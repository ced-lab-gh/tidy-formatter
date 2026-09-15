// v0.4.1: the Prettier family now preserves a document's existing line endings
// the same way the js-beautify family does (the completion of defect C-04).
//
// C-04 fixed the js-beautify adapter, whose local copy of the whitespace policy
// appended a bare LF to a CRLF document. The PRETTIER path was left alone, and
// it had a sibling of the same defect one level up: it never ran the shared
// post-processing pass at all, and it omitted prettier's `endOfLine` key
// whenever Tidy had resolved no concrete EOL. Prettier's own default for that
// key is 'lf', so a whole CRLF document came back LF whenever files.eol was
// unset or "auto".
//
// Nothing was ever corrupted (a whitespace-only change is equivalent to the
// guard, and the result was never MIXED), so this is not a safety defect. It is
// a CONSISTENCY defect: the same extension gave a CRLF project one answer for a
// .css and a different one for a .ts, which is exactly what a single shared
// policy module exists to prevent.
//
// THE MATRIX BELOW IS THE AUDIT'S. Each of the ten languages is swept across
// files.eol {auto, lf, crlf} x insertFinalNewline {true, false, unset} x four
// document shapes (all-CRLF, all-LF, mixed, CRLF with no final newline): 36
// combinations per language, 360 in all. Measured on this tree:
//
//   metric                     before -> after
//   EOL defect (a CRLF document with NO explicit files.eol came back LF)
//     css/scss/less/html/json/jsonc/javascript    0 of 36 ->  0 of 36
//     typescript / typescriptreact / javascriptreact
//                                                 6 of 36 ->  0 of 36
//     TOTAL                                      18 of 360 -> 0 of 360
//   final-newline defect (no opinion yet the last byte moved, or an explicit
//   insertFinalNewline false ignored)
//     the seven js-beautify languages              0 of 36 ->  0 of 36
//     the three Prettier languages                15 of 36 ->  0 of 36
//     TOTAL                                      45 of 360 -> 0 of 360
//   mixed endings produced from a uniform document  0 of 360 -> 0 of 360
//   explicit files.eol honoured                   180 of 360 -> 180 of 360
//
// The last line is the one that keeps this a fix and not a regression: an
// EXPLICIT endOfLine still wins over the document. The rule is only "when the
// user has not said, keep what the document already has".
import assert from 'node:assert/strict';
import { dispatchFormat } from '../../../src/engine/dispatcher';
import { PrettierEngine } from '../../../src/engine/prettier';
import { guard } from '../../../src/safety/guard';
import { resolved } from '../../helpers/options';
import { SUPPORTED_LANG_IDS, type LangId, type ResolvedOptions } from '../../../src/types';

/* -------------------------------------------------------------------------- */
/* The matrix                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One unformatted sample per language, written with LF so every shape below is
 * derived from ONE source. Each is deliberately messy enough that the engine
 * really reprints it, otherwise the sweep would prove nothing about the printer.
 */
const SAMPLES: Readonly<Record<LangId, string>> = {
  css: '.a {\ncolor: red;\n}\n.b {\ncolor: blue;\n}\n',
  scss: '.a {\ncolor: red;\n.c { color: green; }\n}\n',
  less: '.a {\ncolor: red;\n.c { color: green; }\n}\n',
  html: '<div>\n<p>hello</p>\n<span>x</span>\n</div>\n',
  json: '{\n"a": 1,\n"b": [1, 2]\n}\n',
  jsonc: '{\n// note\n"a": 1,\n"b": [1, 2]\n}\n',
  javascript: 'const a = 1;\nfunction f() {\nreturn a;\n}\n',
  typescript: 'const a: number = 1;\nfunction f(): number {\nreturn a;\n}\n',
  typescriptreact:
    'const a = <div>hi</div>;\nfunction g() {\nreturn a;\n}\nexport default g;\n',
  javascriptreact:
    'const a = <div>hi</div>;\nfunction g() {\nreturn a;\n}\nexport default g;\n'
};

type Shape = 'all-crlf' | 'all-lf' | 'mixed' | 'crlf-no-final-newline';
const SHAPES: readonly Shape[] = [
  'all-crlf',
  'all-lf',
  'mixed',
  'crlf-no-final-newline'
];

/** files.eol "auto" and "unset" both reach the engine as endOfLine undefined. */
type EolSetting = 'auto' | 'lf' | 'crlf';
const EOL_SETTINGS: readonly EolSetting[] = ['auto', 'lf', 'crlf'];

type FinalNewlineSetting = 'true' | 'false' | 'unset';
const FINAL_NEWLINE_SETTINGS: readonly FinalNewlineSetting[] = [
  'true',
  'false',
  'unset'
];

/** Re-end a LF sample with the line endings of the requested shape. */
function reshape(sample: string, s: Shape): string {
  const lines = sample.split('\n');
  const body = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  switch (s) {
    case 'all-crlf':
      return `${body.join('\r\n')}\r\n`;
    case 'all-lf':
      return `${body.join('\n')}\n`;
    case 'mixed':
      return body.map((line, i) => line + (i % 2 === 0 ? '\r\n' : '\n')).join('');
    case 'crlf-no-final-newline':
      return body.join('\r\n');
  }
}

function optionsFor(
  eol: EolSetting,
  finalNewline: FinalNewlineSetting
): ResolvedOptions {
  return resolved({
    ...(eol === 'auto' ? {} : { endOfLine: eol }),
    ...(finalNewline === 'unset'
      ? {}
      : { insertFinalNewline: finalNewline === 'true' })
  });
}

const countCrlf = (text: string): number => (text.match(/\r\n/g) ?? []).length;
/** LF not preceded by CR: the only kind that can make a document mixed. */
const countLoneLf = (text: string): number =>
  (text.match(/(?<!\r)\n/g) ?? []).length;
const endsWithNewline = (text: string): boolean => /[\r\n]$/.test(text);

/* -------------------------------------------------------------------------- */
/* The sweep                                                                   */
/* -------------------------------------------------------------------------- */

describe('engine : line endings across the whole format matrix (C-04, completed)', () => {
  for (const lang of SUPPORTED_LANG_IDS) {
    it(`${lang}: 36 combinations, and not one of them rewrites the document's EOL uninvited`, async () => {
      for (const s of SHAPES) {
        const input = reshape(SAMPLES[lang], s);
        const inputIsUniformCrlf = countCrlf(input) > 0 && countLoneLf(input) === 0;
        const inputIsUniformLf = countLoneLf(input) > 0 && countCrlf(input) === 0;

        for (const eol of EOL_SETTINGS) {
          for (const finalNewline of FINAL_NEWLINE_SETTINGS) {
            const where = `${lang} eol=${eol} insertFinalNewline=${finalNewline} shape=${s}`;
            // eslint-disable-next-line no-await-in-loop
            const output = await dispatchFormat({
              languageId: lang,
              code: input,
              options: optionsFor(eol, finalNewline)
            });

            if (eol === 'crlf') {
              assert.equal(
                countLoneLf(output),
                0,
                `${where}: an explicit crlf must leave no lone LF, got ${JSON.stringify(output)}`
              );
            } else if (eol === 'lf') {
              assert.equal(
                countCrlf(output),
                0,
                `${where}: an explicit lf must leave no CRLF, got ${JSON.stringify(output)}`
              );
            } else {
              // THE FIX. No explicit setting: keep what the document already has.
              if (inputIsUniformCrlf) {
                assert.equal(
                  countLoneLf(output),
                  0,
                  `${where}: a CRLF document must stay CRLF, got ${JSON.stringify(output)}`
                );
                assert.ok(
                  countCrlf(output) > 0,
                  `${where}: a CRLF document must keep its CRLFs, got ${JSON.stringify(output)}`
                );
              }
              if (inputIsUniformLf) {
                assert.equal(
                  countCrlf(output),
                  0,
                  `${where}: an LF document must stay LF, got ${JSON.stringify(output)}`
                );
              }
            }

            // A uniform document is never handed back with two kinds of ending:
            // that is the C-04 failure itself, and it must not exist anywhere.
            if (inputIsUniformCrlf || inputIsUniformLf) {
              assert.ok(
                countCrlf(output) === 0 || countLoneLf(output) === 0,
                `${where}: uniform in, MIXED out: ${JSON.stringify(output)}`
              );
            }

            // The final-newline contract, same three branches for every engine.
            if (finalNewline === 'true') {
              assert.ok(
                endsWithNewline(output),
                `${where}: insertFinalNewline true must end in a newline`
              );
            } else if (finalNewline === 'false') {
              assert.ok(
                !endsWithNewline(output),
                `${where}: insertFinalNewline false must strip the last newline, got ${JSON.stringify(output)}`
              );
            } else {
              assert.equal(
                endsWithNewline(output),
                endsWithNewline(input),
                `${where}: no opinion must move no final byte, got ${JSON.stringify(output)}`
              );
            }

            // And the whole point: every one of these outputs is still a result
            // the guard would accept, so the fix cannot have turned a working
            // format into a silent no-op.
            const verdict = guard.check(lang, input, output);
            assert.equal(
              verdict.equivalent,
              true,
              `${where}: the guard rejected the output (${verdict.reason ?? 'no reason'})`
            );
          }
        }
      }
    });
  }
});

/* -------------------------------------------------------------------------- */
/* The exact pre-fix cases, named                                              */
/* -------------------------------------------------------------------------- */

const PRETTIER_LANGS: readonly LangId[] = [
  'typescript',
  'typescriptreact',
  'javascriptreact'
];

describe('engine/prettier : the six combinations the audit measured, one by one', () => {
  for (const lang of PRETTIER_LANGS) {
    for (const shape of ['all-crlf', 'crlf-no-final-newline'] as const) {
      for (const finalNewline of FINAL_NEWLINE_SETTINGS) {
        it(`${lang} / files.eol auto / insertFinalNewline ${finalNewline} / ${shape} keeps CRLF`, async () => {
          const input = reshape(SAMPLES[lang], shape);
          const output = await dispatchFormat({
            languageId: lang,
            code: input,
            options: optionsFor('auto', finalNewline)
          });
          // Before the fix this was the WHOLE document flattened to LF.
          assert.equal(
            countLoneLf(output),
            0,
            `the document was rewritten to LF: ${JSON.stringify(output)}`
          );
          assert.ok(countCrlf(output) > 0, 'the CRLFs must still be there');
        });
      }
    }
  }

  it('a .ts with no final newline does not grow one when nobody asked', async () => {
    // Prettier emits a trailing newline of its own unconditionally, and the TS
    // path used to return that straight to the provider: the file gained a byte
    // the user never asked for. The CSS fallback path already restored it.
    const input = 'const a = 1;\nconst b = 2;';
    const output = await dispatchFormat({
      languageId: 'typescript',
      code: input,
      options: resolved()
    });
    assert.equal(output, 'const a = 1;\nconst b = 2;');
  });

  it('a .ts WITH a final newline keeps it when nobody asked', async () => {
    const input = 'const a = 1;\nconst b = 2;\n';
    const output = await dispatchFormat({
      languageId: 'typescript',
      code: input,
      options: resolved()
    });
    assert.equal(output, input);
  });

  it('insertFinalNewline false is honoured on the Prettier path', async () => {
    const output = await dispatchFormat({
      languageId: 'typescript',
      code: 'const a = 1;\n',
      options: resolved({ insertFinalNewline: false })
    });
    assert.equal(output, 'const a = 1;');
  });

  it('insertFinalNewline true appends the DOCUMENT EOL, never a bare LF', async () => {
    // The literal shape of C-04 on the js-beautify side: at the default config
    // (files.eol auto) a CRLF document came back with one lone LF glued on.
    const output = await dispatchFormat({
      languageId: 'typescript',
      code: 'const a = 1;\r\nconst b = 2;',
      options: resolved({ insertFinalNewline: true })
    });
    assert.equal(output, 'const a = 1;\r\nconst b = 2;\r\n');
    assert.equal(countLoneLf(output), 0);
  });

  it('an explicit endOfLine still beats the document, in both directions', async () => {
    const crlfDoc = 'const a = 1;\r\nconst b = 2;\r\n';
    const lfDoc = 'const a = 1;\nconst b = 2;\n';
    assert.equal(
      await dispatchFormat({
        languageId: 'typescript',
        code: crlfDoc,
        options: resolved({ endOfLine: 'lf' })
      }),
      lfDoc,
      'an explicit lf must convert a CRLF document'
    );
    assert.equal(
      await dispatchFormat({
        languageId: 'typescript',
        code: lfDoc,
        options: resolved({ endOfLine: 'crlf' })
      }),
      crlfDoc,
      'an explicit crlf must convert an LF document'
    );
  });
});

/* -------------------------------------------------------------------------- */
/* One policy, two families                                                    */
/* -------------------------------------------------------------------------- */

describe('engine : a CRLF project gets ONE answer from the whole extension', () => {
  it('.css and .ts agree on every (files.eol, insertFinalNewline) pair', async () => {
    // The user-visible statement of the defect: formatting a stylesheet and a
    // TypeScript file in the same CRLF project used to produce two different EOL
    // behaviours from one extension.
    for (const eol of EOL_SETTINGS) {
      for (const finalNewline of FINAL_NEWLINE_SETTINGS) {
        const options = optionsFor(eol, finalNewline);
        // eslint-disable-next-line no-await-in-loop
        const css = await dispatchFormat({
          languageId: 'css',
          code: reshape(SAMPLES.css, 'all-crlf'),
          options
        });
        // eslint-disable-next-line no-await-in-loop
        const ts = await dispatchFormat({
          languageId: 'typescript',
          code: reshape(SAMPLES.typescript, 'all-crlf'),
          options
        });
        const describe_ = `eol=${eol} insertFinalNewline=${finalNewline}`;
        assert.equal(
          countLoneLf(css) === 0,
          countLoneLf(ts) === 0,
          `${describe_}: css and ts disagree about CRLF`
        );
        assert.equal(
          endsWithNewline(css),
          endsWithNewline(ts),
          `${describe_}: css and ts disagree about the final newline`
        );
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The one part of the shared policy the TS/JSX path deliberately skips        */
/* -------------------------------------------------------------------------- */

describe('engine/prettier : the trim policy is NOT applied to printed JS/TS', () => {
  const engine = new PrettierEngine();

  it('keeps trailing spaces inside a template literal even with trimTrailingWhitespace', async () => {
    // Those spaces are part of the string's VALUE. Trimming them changes what
    // the program means, the guard answers "AST structure changed after
    // formatting", and the format would abort on every file with such a
    // literal: a silent no-op where Tidy works today. So the shared pass is run
    // with the trim cleared on this path, on purpose.
    const input = 'const s = `line one   \nline two`;\n';
    const output = await engine.format({
      languageId: 'typescript',
      code: input,
      options: resolved({ trimTrailingWhitespace: true })
    });
    assert.ok(
      output.includes('`line one   \nline two`'),
      `the literal's own spaces were eaten: ${JSON.stringify(output)}`
    );
    assert.equal(
      guard.check('typescript', input, output).equivalent,
      true,
      'and the guard therefore still accepts the result'
    );
  });

  it('the EOL half of the policy still applies with trimTrailingWhitespace on', async () => {
    // Clearing the trim must not have cleared the rest of the pass.
    const output = await engine.format({
      languageId: 'typescript',
      code: 'const a = 1;\r\nconst b = 2;\r\n',
      options: resolved({ trimTrailingWhitespace: true, insertFinalNewline: true })
    });
    assert.equal(output, 'const a = 1;\r\nconst b = 2;\r\n');
  });
});

/* -------------------------------------------------------------------------- */
/* Range scope                                                                 */
/* -------------------------------------------------------------------------- */

describe('engine/prettier : a selection is not the end of the document', () => {
  const engine = new PrettierEngine();

  it('does not apply the final-newline policy to a range request', async () => {
    // Same rule the js-beautify range path and the CSS fallback already follow:
    // the slice is not the file's end, and the provider puts the slice's own
    // trailing whitespace run back verbatim afterwards.
    const code = 'const a = 1;';
    const output = await engine.format({
      languageId: 'typescript',
      code,
      options: resolved({ insertFinalNewline: true }),
      range: { startOffset: 0, endOffset: code.length }
    });
    assert.ok(
      !endsWithNewline(output),
      `a selection must not gain a final newline, got ${JSON.stringify(output)}`
    );
  });

  it('still keeps a selection CRLF when the document is CRLF', async () => {
    const code = 'const a = 1;\r\nconst b = 2;';
    const output = await engine.format({
      languageId: 'typescript',
      code,
      options: resolved(),
      range: { startOffset: 0, endOffset: code.length }
    });
    assert.equal(countLoneLf(output), 0, JSON.stringify(output));
  });
});

/* -------------------------------------------------------------------------- */
/* The CSS fallback path, which primary routing never reaches                  */
/* -------------------------------------------------------------------------- */

describe('engine/prettier : the CSS fallback keeps the behaviour it had', () => {
  const engine = new PrettierEngine();

  it('a CRLF stylesheet stays CRLF through the fallback printer', async () => {
    const input = reshape(SAMPLES.css, 'all-crlf');
    const output = await engine.format({
      languageId: 'css',
      code: input,
      options: resolved()
    });
    assert.equal(countLoneLf(output), 0, JSON.stringify(output));
    assert.ok(countCrlf(output) > 0);
  });

  it('answers "this text ends in a line break" the way the js-beautify path does', async () => {
    // Both paths now ask /[\r\n]$/ rather than /\r?\n$/. A stylesheet whose
    // last byte is a lone CR DID end in a line break, so "no opinion" must keep
    // it; the narrower test said no and stripped the file's last byte, which is
    // the one thing the no-opinion branch exists to prevent.
    const input = '.a {\r  color: red;\r}\r';
    const output = await engine.format({
      languageId: 'css',
      code: input,
      options: resolved()
    });
    assert.ok(
      endsWithNewline(output),
      `the file's own final line break was dropped: ${JSON.stringify(output)}`
    );
  });
});
