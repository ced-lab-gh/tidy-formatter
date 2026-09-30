// ADD-12b: the JSX tag-boundary fingerprint applies to the body of an EXECUTABLE
// <script> in an HTML document exactly as it applies to a .jsx/.tsx file.
//
// THE GAP THIS CLOSES. In a .jsx/.tsx file the guard refuses a DETACHED OPENING
// `<` (`<App x={1} />` -> `< App x = {1} />`): babel's JSX grammar ignores that
// whitespace, so the two texts have the SAME AST, and only the boundary
// fingerprint tells them apart. The embedded-script branch of the HTML guard
// compared the AST and the comments and never ran the fingerprint, so the same
// text was accepted inside a <script>. The program's meaning did not change (the
// ASTs are identical); what was missing was the rule the product states, the
// signature corruption of the incumbent (`< App`) getting written to disk.
//
// WHAT MUST NOT CHANGE, AND WHY A TEST IS DELIBERATELY ABSENT.
//   - `<Foo / >` and `</ Foo>` are VALID JSX. @babel/parser and esbuild both
//     accept them with the same AST as `<Foo />` and `</Foo>`, and the
//     fingerprint reads only the opening `<`, which stays glued in both. They
//     are ACCEPTED, in a file and in a script, and the tests below pin that.
//   - There is no test here that rejects `</ Foo>`, and there must never be one:
//     it would ask the guard to refuse valid JSX. (An earlier package note
//     proposed one under a name ending in CLOSE-MANGLE; it rested on a wrong
//     premise.)
//   - Only scripts the guard already classifies as JavaScript are touched. A
//     data block (application/json, importmap, ld+json) and every opaque type
//     (a template, text/babel) keep the rule they had.
import assert from 'node:assert/strict';
import { guard } from '../../../src/safety/guard';
import { guardCheckNoFastPath } from '../../helpers/guardCheck';

const wrap = (js: string, attrs = ''): string => `<div><script${attrs}>${js}</script></div>`;

describe('safety/guard : JSX tag boundaries inside an executable <script> (ADD-12b)', () => {
  // The verifier chunks (babel, parse5) load lazily on first use; when this file
  // runs alone the first check pays that cost, which exceeds mocha's 2 s default.
  before(function () {
    this.timeout(30000);
    guard.check('html', wrap('a'), wrap('b'));
  });

  it('GUARD-EMBED-JSX-MANGLE: rejects a detached opening `<` that the AST cannot see', () => {
    const verdict = guard.check(
      'html',
      '<div><script>const el = <App x={1} />;</script></div>',
      '<div><script>const el = < App x = {1} />;</script></div>'
    );
    assert.equal(verdict.equivalent, false);
    assert.ok(verdict.reason && verdict.reason.length > 0, 'rejection must include a reason');
  });

  it('GUARD-EMBED-JSX-MANGLE: the same pair is refused as a file, so the two paths now agree', () => {
    assert.deepEqual(
      guard.check('javascriptreact', 'const el = <App x={1} />;', 'const el = < App x = {1} />;'),
      { equivalent: false, reason: 'JSX tag boundaries were altered by formatting' }
    );
  });

  for (const type of ['', ' type="module"', ' type="text/javascript"', ' type="application/javascript"']) {
    it(`GUARD-EMBED-JSX-MANGLE: refused for <script${type}>`, () => {
      const verdict = guard.check(
        'html',
        wrap('const el = <App x={1} />;', type),
        wrap('const el = < App x = {1} />;', type)
      );
      assert.equal(verdict.equivalent, false);
    });
  }

  // Each row: [label, input JS, output JS, accepted]. The embedded verdict must
  // equal the file-level verdict on the same pair (parity), and both must equal
  // the stated expectation.
  const PARITY_ROWS: ReadonlyArray<readonly [string, string, string, boolean]> = [
    ['opening `<` detached from a self-closing tag', 'const a = <App x={1} />;', 'const a = < App x = {1} />;', false],
    ['opening `<` detached from an open tag', 'const a = <div>{x}</div>;', 'const a = < div>{x}</div>;', false],
    ['opening `<` of a closing tag detached from its `/`', 'const a = <div>{x}</div>;', 'const a = <div>{x}< /div>;', false],
    ['opening `<` detached from a fragment', 'const a = <><A /></>;', 'const a = < ><A /></>;', false],
    ['`<Foo / >` is valid JSX and stays accepted', 'const a = <Foo />;', 'const a = <Foo / >;', true],
    ['`</ Foo>` is valid JSX and stays accepted', 'const a = <Foo></Foo>;', 'const a = <Foo></ Foo>;', true],
    ['wrapped attributes with the closing `>` on its own line', 'const a = <Foo bar={1}>x</Foo>;', 'const a = <Foo\n  bar={1}\n>\n  x\n</Foo>;', true],
    ['a self-closing tag exploded over several lines', 'const a = <Foo bar={1} />;', 'const a = <Foo\n  bar={1}\n/>;', true],
    ['both sides already detached, nothing moved', 'const a = < Foo />;', 'const a = < Foo />;\n', true],
    ['detached on the input side, glued on the output side', 'const a = < Foo />;', 'const a = <Foo />;', false]
  ];

  for (const [label, inputJs, outputJs, accepted] of PARITY_ROWS) {
    it(`parity with the file-level path: ${label}`, () => {
      const fileVerdict = guardCheckNoFastPath('javascriptreact', inputJs, outputJs);
      const embedVerdict = guardCheckNoFastPath('html', wrap(inputJs), wrap(outputJs));
      assert.equal(fileVerdict.equivalent, accepted, 'file-level expectation');
      assert.equal(embedVerdict.equivalent, accepted, 'embedded expectation');
    });
  }

  it('GUARD-EMBED-JSX-SELFCLOSE-SPACE: `<Foo / >` inside an executable script stays accepted', () => {
    assert.equal(
      guard.check('html', wrap('const el = <Foo />;'), wrap('const el = <Foo / >;')).equivalent,
      true
    );
  });

  it('GUARD-EMBED-JSX-CLOSE-SPACE-VALID: `</ Foo>` inside an executable script stays accepted', () => {
    assert.equal(
      guard.check('html', wrap('const el = <Foo></Foo>;'), wrap('const el = <Foo></ Foo>;')).equivalent,
      true
    );
  });

  it('accepts a legitimate reindent of a script that holds JSX with every `<` glued', () => {
    const verdict = guard.check(
      'html',
      '<div><script>const el = <App x={1} onClick={() => go()} />;render(el);</script></div>',
      '<div>\n  <script>\n    const el = <App\n      x={1}\n      onClick={() => go()}\n    />;\n    render(el);\n  </script>\n</div>'
    );
    assert.equal(verdict.equivalent, true);
  });

  it('a script with no JSX, only comparisons, keeps its verdicts', () => {
    assert.equal(
      guard.check('html', wrap('if(a<b&&c>d){go()}'), wrap('\n  if (a < b && c > d) {\n    go()\n  }\n')).equivalent,
      true
    );
    // a real change is still caught by the AST diff, not by the fingerprint
    assert.equal(
      guard.check('html', wrap('if(a<b){go()}'), wrap('if (a > b) { go() }')).equivalent,
      false
    );
  });

  it('a JSX script that loses a comment is still refused for the comment', () => {
    assert.equal(
      guard.check('html', wrap('/* keep */ const el = <App />;'), wrap('const el = <App />;')).equivalent,
      false
    );
  });
});

describe('safety/guard : a non-executable <script> is untouched by the JSX fingerprint (ADD-12b)', () => {
  // The classification is the guard's existing JS_SCRIPT_TYPES set. These rows
  // pin that the fix did NOT widen it: data blocks stay JSON, everything else
  // stays verbatim, and none of them is read as JSX.
  it('application/json and application/ld+json keep comparing as JSON', () => {
    for (const type of ['application/json', 'application/ld+json']) {
      const verdict = guard.check(
        'html',
        `<script type="${type}">{"a":1,"b":"<App x={1} />"}</script>`,
        `<script type="${type}">{
  "a": 1,
  "b": "<App x={1} />"
}</script>`
      );
      assert.equal(verdict.equivalent, true, type);
    }
  });

  it('a JSON value that carries JSX-looking text is still compared by value', () => {
    const verdict = guard.check(
      'html',
      '<script type="application/json">{"b":"<App x={1} />"}</script>',
      '<script type="application/json">{"b":"< App x = {1} />"}</script>'
    );
    assert.equal(verdict.equivalent, false);
  });

  it('a template or importmap script stays verbatim: an identical body is accepted, a reindented one is refused', () => {
    for (const type of ['text/x-template', 'importmap']) {
      const body = '<li v-for="x in xs">{{ x }}</li>';
      assert.equal(
        guard.check(
          'html',
          `<div><script type="${type}">${body}</script></div>`,
          `<div>
  <script type="${type}">${body}</script>
</div>`
        ).equivalent,
        true,
        `${type}: identical body`
      );
      assert.equal(
        guard.check(
          'html',
          `<div><script type="${type}">${body}</script></div>`,
          `<div><script type="${type}">
  ${body}
</script></div>`
        ).equivalent,
        false,
        `${type}: reindented body`
      );
    }
  });

  it('text/babel is not classified as JavaScript: a reindent of its body is still refused', () => {
    // If a future change moves it into the JS branch this test must be revisited
    // on purpose; the ADD-12b fix must not do it as a side effect.
    assert.equal(
      guard.check(
        'html',
        '<body><script type="text/babel">const el = <App x={1} />;</script></body>',
        '<body><script type="text/babel">\n  const el = <App x={1} />;\n</script></body>'
      ).equivalent,
      false
    );
    assert.equal(
      guardCheckNoFastPath(
        'html',
        '<body><script type="text/babel">const el = <App x={1} />;</script></body>',
        '<body><script type="text/babel">const el = <App x={1} />;</script></body>'
      ).equivalent,
      true
    );
  });
});

describe('safety/guard : file-level JSX behaviour is unchanged by ADD-12b', () => {
  it('a .tsx file keeps exactly its verdicts, reasons included', () => {
    assert.deepEqual(
      guard.check('typescriptreact', 'const a = <Foo bar={x} />;', 'const a = < Foo bar = {x} />;'),
      { equivalent: false, reason: 'JSX tag boundaries were altered by formatting' }
    );
    assert.deepEqual(guardCheckNoFastPath('typescriptreact', 'const a = <Foo />;', 'const a = <Foo / >;'), {
      equivalent: true
    });
    assert.deepEqual(
      guardCheckNoFastPath('typescriptreact', 'const a = <Foo></Foo>;', 'const a = <Foo></ Foo>;'),
      { equivalent: true }
    );
    assert.deepEqual(
      guard.check('javascriptreact', 'const a = <Foo bar={x} />;', 'const a = < Foo bar = {x} />;'),
      { equivalent: false, reason: 'JSX tag boundaries were altered by formatting' }
    );
  });
});
