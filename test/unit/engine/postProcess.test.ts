// Unit tests for the shared post-processing pass (ADD-01, src/engine/postProcess.ts):
// per-line trailing-whitespace trim, final-newline policy, EOL normalisation.
// This is what makes the Prettier CSS fallback a drop-in for the js-beautify
// family as far as whitespace policy is concerned.
import assert from 'node:assert/strict';
import { postProcess } from '../../../src/engine/postProcess';
import { resolved } from '../../helpers/options';

describe('engine/postProcess : trailing whitespace', () => {
  it('strips per-line trailing whitespace only when asked', () => {
    const input = 'a  \nb\t\nc';
    assert.equal(postProcess(input, resolved(), false), input);
    assert.equal(
      postProcess(input, resolved({ trimTrailingWhitespace: true }), false),
      'a\nb\nc'
    );
  });

  it('never touches leading or inner whitespace', () => {
    const input = '  a  b  \n';
    assert.equal(
      postProcess(input, resolved({ trimTrailingWhitespace: true }), true),
      '  a  b\n'
    );
  });
});

describe('engine/postProcess : final-newline policy', () => {
  it('insertFinalNewline true appends exactly one newline', () => {
    assert.equal(postProcess('a\n\n\n', resolved({ insertFinalNewline: true }), true), 'a\n');
    assert.equal(postProcess('a', resolved({ insertFinalNewline: true }), false), 'a\n');
  });

  it('insertFinalNewline true uses the document EOL, not a hard-coded LF', () => {
    assert.equal(
      postProcess('a\r\nb', resolved({ insertFinalNewline: true, endOfLine: 'crlf' }), false),
      'a\r\nb\r\n'
    );
    // No explicit endOfLine: infer from the text itself.
    assert.equal(postProcess('a\r\nb', resolved({ insertFinalNewline: true }), false), 'a\r\nb\r\n');
  });

  it('insertFinalNewline false strips every trailing newline', () => {
    assert.equal(postProcess('a\n\n', resolved({ insertFinalNewline: false }), true), 'a');
  });

  it('undefined restores the INPUT final-newline state in both directions', () => {
    // Prettier always emits a trailing newline: without this restore, formatting
    // a file that had none would silently add a byte.
    assert.equal(postProcess('a\n', resolved(), false), 'a');
    assert.equal(postProcess('a', resolved(), true), 'a\n');
    // Already matching: untouched.
    assert.equal(postProcess('a\n', resolved(), true), 'a\n');
    assert.equal(postProcess('a', resolved(), false), 'a');
  });

  it('undefined restores a CRLF final newline as CRLF', () => {
    assert.equal(postProcess('a\r\nb', resolved(), true), 'a\r\nb\r\n');
  });
});

/* -------------------------------------------------------------------------- */
/* A BARE-CR document: the third line-ending style                            */
/* -------------------------------------------------------------------------- */
//
// Classic-Mac / bare-CR files still turn up, and NOTHING in this pipeline
// normalises them: with files.eol unset or "auto" the EOL pass is a no-op, so
// such a document keeps its CRs from end to end. Deciding the terminator from
// /\r\n/ alone answered LF for them and glued a lone LF onto a CR-only file :
// defect C-04's exact shape, a whitespace-only difference the guard calls
// equivalent and therefore WRITES. Measured at 3 of 42 (files.eol x
// insertFinalNewline x document) document-scope combinations before the fix.

describe('engine/postProcess : a bare-CR document', () => {
  it('THE DEFECT: insertFinalNewline true used to glue an LF onto a CR file', () => {
    assert.equal(
      postProcess('a\rb', resolved({ insertFinalNewline: true }), false),
      'a\rb\r'
    );
  });

  it('undefined restores a CR-only final newline as CR', () => {
    assert.equal(postProcess('a\rb', resolved(), true), 'a\rb\r');
  });

  it('never leaves a CR-only document MIXED, on either branch', () => {
    const optionBags = [resolved({ insertFinalNewline: true }), resolved()];
    for (const options of optionBags) {
      const out = postProcess('.a {\r  color: red\r}', options, true);
      assert.ok(!out.includes('\n'), `a lone LF was glued on: ${JSON.stringify(out)}`);
      assert.ok(out.endsWith('\r'), `the file must still end in a newline: ${JSON.stringify(out)}`);
    }
  });

  it('an EXPLICIT endOfLine still wins over the document', () => {
    assert.equal(
      postProcess('a\rb', resolved({ insertFinalNewline: true, endOfLine: 'lf' }), false),
      'a\nb\n'
    );
    assert.equal(
      postProcess('a\rb', resolved({ insertFinalNewline: true, endOfLine: 'crlf' }), false),
      'a\r\nb\r\n'
    );
  });

  it('CRLF still wins over a stray CR in an already mixed document', () => {
    assert.equal(
      postProcess('a\r\nb\rc', resolved({ insertFinalNewline: true }), false),
      'a\r\nb\rc\r\n'
    );
  });

  it('a document with no line ending at all still gets an LF', () => {
    assert.equal(postProcess('a', resolved({ insertFinalNewline: true }), false), 'a\n');
  });
});

describe('engine/postProcess : EOL normalisation', () => {
  it('crlf converts every line ending', () => {
    assert.equal(postProcess('a\nb\rc\r\nd', resolved({ endOfLine: 'crlf' }), false), 'a\r\nb\r\nc\r\nd');
  });

  it('lf converts every line ending', () => {
    assert.equal(postProcess('a\r\nb\rc\nd', resolved({ endOfLine: 'lf' }), false), 'a\nb\nc\nd');
  });

  it('an unresolved endOfLine leaves mixed endings exactly as the engine produced them', () => {
    assert.equal(postProcess('a\r\nb\nc', resolved(), false), 'a\r\nb\nc');
  });

  it('EOL is applied AFTER the final newline, so the appended one is converted too', () => {
    assert.equal(
      postProcess('a', resolved({ insertFinalNewline: true, endOfLine: 'crlf' }), false),
      'a\r\n'
    );
  });
});
