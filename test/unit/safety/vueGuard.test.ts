// Unit tests for the Vue SFC equivalence strategy (ADD-15): guard.check('vue').
// Adversarial by design: every reject case is a corruption the engine COULD
// produce and the guard MUST stop before any byte reaches the file.
import assert from 'node:assert/strict';
import { guard, vueSfcEqual } from '../../../src/safety/guard';

const SFC = [
  '<template>',
  '  <div v-if="ok" :cls="a">Hello</div>',
  '</template>',
  '<!-- between blocks -->',
  '<script>',
  'const a = 1;',
  '</script>',
  '<style scoped>',
  '.x { color: red; }',
  '</style>',
  ''
].join('\n');

describe('safety/vueGuard : accepts legitimate reformatting', () => {
  it('accepts identical input (fast path)', () => {
    assert.equal(guard.check('vue', SFC, SFC).equivalent, true);
  });

  it('accepts a pure template reindent', () => {
    const out = SFC.replace(
      '  <div v-if="ok" :cls="a">Hello</div>',
      '    <div v-if="ok" :cls="a">\n        Hello\n    </div>'
    );
    assert.equal(vueSfcEqual(SFC, out).equivalent, true);
  });

  it('accepts a whitespace-only style change', () => {
    const out = SFC.replace('.x { color: red; }', '.x {\n    color: red;\n}');
    assert.equal(vueSfcEqual(SFC, out).equivalent, true);
  });
});

describe('safety/vueGuard : rejects corruption (zero edit upstream)', () => {
  function rejects(output: string, why: string): void {
    const verdict = vueSfcEqual(SFC, output);
    assert.equal(verdict.equivalent, false, why);
    assert.ok(verdict.reason && verdict.reason.length > 0, 'reason required');
  }

  it('rejects a single-byte change inside the script block', () => {
    rejects(SFC.replace('const a = 1;', 'const a = 2;'), 'script must be verbatim');
  });

  it('rejects a script reindent too (v1 promises byte-for-byte, not AST-equal)', () => {
    rejects(SFC.replace('const a = 1;', '  const a = 1;'), 'script must be verbatim');
  });

  it('rejects a dropped comment between blocks', () => {
    rejects(SFC.replace('<!-- between blocks -->\n', ''), 'skeleton must be verbatim');
  });

  it('rejects a dropped style block', () => {
    rejects(
      SFC.replace('<style scoped>\n.x { color: red; }\n</style>\n', ''),
      'block structure must be stable'
    );
  });

  it('rejects a changed block attribute (<style scoped> -> <style>)', () => {
    rejects(SFC.replace('<style scoped>', '<style>'), 'block attrs must be stable');
  });

  it('rejects a rewritten Vue directive value', () => {
    rejects(SFC.replace(':cls="a"', ':cls="b"'), 'directive values are opaque');
  });

  it('rejects a template text change', () => {
    rejects(SFC.replace('Hello', 'Hi'), 'template text is meaning');
  });

  it('rejects a style value change', () => {
    rejects(SFC.replace('color: red', 'color: blue'), 'css values are meaning');
  });

  it('rejects a modified custom block', () => {
    const withDocs = SFC + '<docs>original</docs>\n';
    const verdict = vueSfcEqual(withDocs, withDocs.replace('original', 'edited'));
    assert.equal(verdict.equivalent, false);
  });

  it('rejects output that no longer splits as an SFC', () => {
    const verdict = vueSfcEqual(SFC, '<template>\nbroken');
    assert.equal(verdict.equivalent, false);
    assert.ok(verdict.reason!.includes('did not parse'));
  });

  // HIGH-02 (verbatim <pre>/<code> inherited) is in production: this is live.
  it('rejects a reflowed <pre><code> inside the template', () => {
    const input =
      '<template>\n<pre><code>if (x) {\n    y();\n}</code></pre>\n</template>\n';
    const output =
      '<template>\n<pre><code>if (x) { y(); }</code></pre>\n</template>\n';
    assert.equal(vueSfcEqual(input, output).equivalent, false);
  });

  it('never leaks source code in a rejection reason', () => {
    const secret = SFC.replace('const a = 1;', 'const key = "sk-SECRET";');
    const broken = secret.replace('sk-SECRET', 'sk-OTHER');
    const verdict = guard.check('vue', secret, broken);
    assert.equal(verdict.equivalent, false);
    assert.ok(!verdict.reason!.includes('sk-SECRET'));
  });
});
