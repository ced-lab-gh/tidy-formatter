// C1 (audit-v050/12): which <script> of an HTML document is JavaScript, decided
// the way the HTML standard decides it ("prepare the script element"), and not
// the way `String.prototype.trim` and an ignored `language` attribute did.
//
// WHAT WAS WRONG. `scriptType` trimmed the `type` with ECMAScript's whitespace
// set (U+00A0, U+FEFF, U+2000-200A, U+2028/2029, U+3000, U+000B on top of the
// ASCII ones) and never read `language`. The standard strips only TAB, LF, FF, CR
// and SPACE from `type`, and with no `type` it derives the type string from
// `language`. So a block the browser does NOT execute (a DATA block: its text is
// read back through `textContent`) was compared as JavaScript, and a reformat
// that is AST-equivalent but changes that text was accepted and written.
//
// THE RULE NOW. A block is compared as JavaScript only when the standard would run
// it as classic or module script. Every other block keeps the comparison it
// already had for its type: JSON data as JSON, anything else verbatim. A block
// that is not executable because of `language` is verbatim.
import assert from 'node:assert/strict';
import { guard } from '../../../src/safety/guard';
import { guardCheckNoFastPath } from '../../helpers/guardCheck';

// AST-equivalent bodies whose TEXT differs: accepted if compared as JavaScript,
// refused if compared verbatim.
const BODY_IN = 'var a=1;';
const BODY_OUT = 'var a = 1;';

function reformatted(attrs: string): boolean {
  return guard.check(
    'html',
    `<div><script${attrs}>${BODY_IN}</script></div>`,
    `<div><script${attrs}>${BODY_OUT}</script></div>`
  ).equivalent;
}

describe('safety/guard : <script> classification follows the HTML standard (C1)', () => {
  // The verifier chunks (babel, parse5) load lazily on first use.
  before(function () {
    this.timeout(30000);
    guard.check('html', '<div><script>a</script></div>', '<div><script>b</script></div>');
  });

  // Executable per the standard: the reformat is a legitimate one and must pass.
  const EXECUTABLE: ReadonlyArray<readonly [string, string]> = [
    ['no attribute', ''],
    ['empty type', ' type=""'],
    ['text/javascript', ' type="text/javascript"'],
    ['text/javascript, upper case', ' type="TEXT/JAVASCRIPT"'],
    ['application/javascript', ' type="application/javascript"'],
    ['text/ecmascript', ' type="text/ecmascript"'],
    ['application/ecmascript', ' type="application/ecmascript"'],
    ['module', ' type="module"'],
    ['module, mixed case', ' type="Module"'],
    ['ASCII spaces around the type', ' type=" text/javascript "'],
    ['TAB, LF, FF, CR around the type', ' type="\t\ntext/javascript\f\r"'],
    ['language="javascript"', ' language="javascript"'],
    ['language="JavaScript", mixed case', ' language="JavaScript"'],
    ['language="ecmascript"', ' language="ecmascript"'],
    ['empty language', ' language=""'],
    ['empty type, language="javascript"', ' type="" language="javascript"'],
    ['type present, so language is ignored', ' type="text/javascript" language="vbscript"'],
    ['module type, so language is ignored', ' type="module" language="vbscript"']
  ];

  for (const [label, attrs] of EXECUTABLE) {
    it(`C1-EXEC: a reformat is accepted for an executable script (${label})`, () => {
      assert.equal(reformatted(attrs), true);
    });
  }

  // Not executable per the standard. These were ACCEPTED before C1 (compared as
  // JavaScript); they are refused now (compared verbatim).
  const NOT_EXECUTABLE: ReadonlyArray<readonly [string, string]> = [
    ['U+00A0 before the type', ' type=" text/javascript"'],
    ['U+00A0 after the type', ' type="text/javascript "'],
    ['U+000B (vertical tab) before the type', ' type="\u000bmodule"'],
    ['U+FEFF before the type', ' type="﻿module"'],
    ['U+2003 before the type', ' type=" text/javascript"'],
    ['U+3000 before the type', ' type="　module"'],
    ['U+2028 before the type', ' type=" module"'],
    ['U+2029 after the type', ' type="text/javascript "'],
    ['a type made of ASCII spaces only', ' type=" "'],
    ['language="vbscript"', ' language="vbscript"'],
    ['language="json"', ' language="json"'],
    ['language="module" (text/module)', ' language="module"'],
    ['language with a leading space', ' language=" javascript"'],
    ['language with a trailing space', ' language="javascript "'],
    ['empty type, language="vbscript"', ' type="" language="vbscript"']
  ];

  for (const [label, attrs] of NOT_EXECUTABLE) {
    it(`C1-DATA: a reformat is refused for a non-executable script (${label})`, () => {
      assert.equal(reformatted(attrs), false);
    });
  }

  it('C1-DATA: a non-executable script is still accepted when its body is byte-identical', () => {
    for (const [, attrs] of NOT_EXECUTABLE) {
      const html = `<div><script${attrs}>${BODY_IN}</script></div>`;
      assert.equal(guardCheckNoFastPath('html', html, html).equivalent, true, attrs);
      // The surrounding markup may be reindented: only the script text must not move.
      const reindented = `<div>\n  <script${attrs}>${BODY_IN}</script>\n</div>`;
      assert.equal(guard.check('html', html, reindented).equivalent, true, attrs);
    }
  });

  it('C1-DATA: a real change in a non-executable script body is refused', () => {
    assert.equal(
      guard.check(
        'html',
        '<div><script language="vbscript">var a=1;</script></div>',
        '<div><script language="vbscript">var a=2;</script></div>'
      ).equivalent,
      false
    );
  });

  it('C1-JSON: type="application/json" keeps its JSON comparison (a reindent is accepted)', () => {
    assert.equal(
      guard.check(
        'html',
        '<script type="application/json">{"a":1}</script>',
        '<script type="application/json">{\n  "a": 1\n}</script>'
      ).equivalent,
      true
    );
  });

  it('C1-JSON: language="json" is not a JSON block, so the same reindent is refused', () => {
    assert.equal(
      guard.check(
        'html',
        '<script language="json">{"a":1}</script>',
        '<script language="json">{\n  "a": 1\n}</script>'
      ).equivalent,
      false
    );
  });
});
