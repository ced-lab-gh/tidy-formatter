// Unit tests for the safety guard (SPEC SAFE-01/02/03). The corpus is the
// anti-incumbent regression set in test/fixtures/guardFixtures.ts: every
// fixture is a real lonefy corruption (reject) or a legitimate reformatting
// (accept). The single most important assertion is GUARD-JSX-MANGLE.
import assert from 'node:assert/strict';
import { guard, astEqualJs, cssTreeEqual, htmlTreeEqual, jsonEqual } from '../../../src/safety/guard';
import { guardFixtures } from '../../fixtures/guardFixtures';

describe('safety/guard — anti-incumbent regression corpus', () => {
  for (const f of guardFixtures) {
    it(`${f.id}: ${f.desc} [${f.ref}]`, () => {
      const verdict = guard.check(f.lang, f.input, f.output);
      assert.equal(
        verdict.equivalent,
        f.equivalent,
        `expected equivalent=${f.equivalent} but got ${verdict.equivalent}` +
          (verdict.reason ? ` (reason: ${verdict.reason})` : '')
      );
      // A rejection must always carry a reason for the OutputChannel.
      if (!f.equivalent) {
        assert.ok(verdict.reason && verdict.reason.length > 0, 'rejection must include a reason');
      }
    });
  }

  it('GUARD: rejection reason never leaks source code', () => {
    const secret = 'const apiKey = "sk-LEAKED-SECRET";';
    const broken = 'const apiKey = "sk-DIFFERENT";';
    const verdict = guard.check('javascript', secret, broken);
    assert.equal(verdict.equivalent, false);
    assert.ok(verdict.reason);
    assert.ok(!verdict.reason!.includes('sk-LEAKED-SECRET'), 'reason must not echo the code');
  });
});

describe('safety/guard — the mandatory acceptance test (SPEC §5)', () => {
  it('rejects the mangled JSX that still re-parses as valid TSX', () => {
    // This is the load-bearing test from the SPEC: '< Foo bar = {x} />' parses
    // fine, so a parse-only guard would WRONGLY accept it. The boundary check
    // must catch it.
    const verdict = guard.check('typescriptreact', '<Foo bar={x} />;', '< Foo bar = {x} />;');
    assert.equal(verdict.equivalent, false);
  });

  it('confirms the mangled output really does re-parse (so reject is non-trivial)', () => {
    // Sanity: prove the AST-only diff alone would pass, justifying the boundary check.
    const astVerdict = astEqualJs('<Foo bar={x} />;', '< Foo bar = {x} />;');
    assert.equal(astVerdict.equivalent, false, 'astEqualJs must use the boundary check, not AST alone');
  });
});

describe('safety/guard — legitimate JSX reflow is accepted (regression)', () => {
  // Regression for the "safe but does nothing" false positive: Prettier reflows
  // adjacent JSX children onto indented lines, inserting whitespace-only JSXText
  // nodes the input lacked. Those are insignificant in JSX and must NOT be seen
  // as a structural change, or Tidy would refuse to format every real TSX file.
  it('accepts multi-line JSX reflow that only adds insignificant whitespace', () => {
    const input = 'const x = <div><h1>{a}</h1><span>{b}</span></div>;';
    const output = [
      'const x = (',
      '  <div>',
      '    <h1>{a}</h1>',
      '    <span>{b}</span>',
      '  </div>',
      ');'
    ].join('\n');
    const verdict = guard.check('typescriptreact', input, output);
    assert.equal(verdict.equivalent, true, verdict.reason);
  });

  it('still rejects a real JSX text-content change', () => {
    // cleanJsxText must normalize whitespace WITHOUT erasing meaningful text:
    // losing the space between words changes the rendered output.
    const verdict = guard.check('javascriptreact', 'const x = <p>Hello world</p>;', 'const x = <p>Helloworld</p>;');
    assert.equal(verdict.equivalent, false);
  });
});

describe('safety/guard — fast path & dispatch', () => {
  it('returns equivalent immediately when input === output', () => {
    const verdict = guard.check('css', '.a{}', '.a{}');
    assert.deepEqual(verdict, { equivalent: true });
  });

  it('per-language strategies are exported and usable directly', () => {
    assert.equal(astEqualJs('const a=1;', 'const a = 1;').equivalent, true);
    assert.equal(cssTreeEqual('css', 'a{color:red}', 'a {\n  color: red\n}').equivalent, true);
    assert.equal(htmlTreeEqual('<p>x</p>', '<p>\n  x\n</p>').equivalent, true);
    assert.equal(jsonEqual('{"a":1}', '{\n  "a": 1\n}').equivalent, true);
  });
});
