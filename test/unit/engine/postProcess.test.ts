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
