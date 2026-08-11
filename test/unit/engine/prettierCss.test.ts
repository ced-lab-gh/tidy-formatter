// Unit tests for the Prettier CSS-family fallback engine path (ADD-01).
// Locks the option mapping (stylistic only), the EOL/final-newline policy shared
// with the js-beautify family, the "never pass rangeStart/rangeEnd to postcss"
// rule, and the deliberate NON-consumption of the js/ts stylistic bag
// (singleQuote would break the guard's verbatim quoted-span comparison).
import assert from 'node:assert/strict';
import { PrettierEngine } from '../../../src/engine/prettier';
import {
  dispatchCssFallback,
  dispatchFormat,
  pickEngine,
  CSS_FALLBACK_LANGS
} from '../../../src/engine/dispatcher';
import { guard } from '../../../src/safety/guard';
import { resolved } from '../../helpers/options';

const engine = new PrettierEngine();

describe('engine/prettier : css family (postcss fallback engine)', () => {
  it('supports css, scss and less', () => {
    for (const lang of ['css', 'scss', 'less'] as const) {
      assert.ok(engine.supports(lang), `expected supports('${lang}')`);
    }
  });

  it('formats plain css and the guard accepts the output', async () => {
    const input = '.a{color:red}';
    const out = await engine.format({
      languageId: 'css',
      code: input,
      options: resolved()
    });
    assert.ok(
      out.includes('color: red'),
      `expected a reformat, got ${JSON.stringify(out)}`
    );
    const verdict = guard.check('css', input, out);
    assert.equal(verdict.equivalent, true, verdict.reason);
  });

  it('honours tabSize and insertSpaces=false (tabs)', async () => {
    const input = '.a{color:red}';
    const spaces = await engine.format({
      languageId: 'css',
      code: input,
      options: resolved({ tabSize: 4 })
    });
    assert.ok(/\n {4}color/.test(spaces), 'tabSize 4 must indent with 4 spaces');
    const tabs = await engine.format({
      languageId: 'css',
      code: input,
      options: resolved({ insertSpaces: false })
    });
    assert.ok(/\n\tcolor/.test(tabs), 'insertSpaces=false must indent with a tab');
  });

  it('maps shared wrap_line_length to printWidth, overridden by prettier.printWidth', async () => {
    const input =
      '.sel{margin:0 1px 2px 3px;padding:0 1px 2px 3px;border-color:red blue green teal}';
    const narrow = await engine.format({
      languageId: 'css',
      code: input,
      options: resolved({ engineOptions: { wrap_line_length: 20 } })
    });
    const wide = await engine.format({
      languageId: 'css',
      code: input,
      options: resolved({
        engineOptions: { wrap_line_length: 20, prettier: { printWidth: 200 } }
      })
    });
    assert.notEqual(narrow, wide, 'printWidth must override the shared wrap');
    assert.ok(
      narrow.split('\n').length > wide.split('\n').length,
      'the narrow width must wrap more lines than the overridden wide one'
    );
  });

  it('does NOT consume singleQuote for the css family (quoted spans stay verbatim)', async () => {
    // singleQuote would rewrite "x" to 'x'. The guard compares CSS quoted spans
    // VERBATIM, so consuming it would make every fallback attempt rejected and
    // the whole feature would silently never apply.
    const input = '.a{content:"x"}';
    const out = await engine.format({
      languageId: 'css',
      code: input,
      options: resolved({ engineOptions: { prettier: { singleQuote: true } } })
    });
    assert.ok(
      out.includes('"x"'),
      `quotes must be preserved, got ${JSON.stringify(out)}`
    );
    assert.equal(guard.check('css', input, out).equivalent, true);
  });

  it('preserves CRLF when endOfLine is unresolved', async () => {
    const input = '.a{\r\ncolor:red}\r\n';
    const out = await engine.format({
      languageId: 'css',
      code: input,
      options: resolved()
    });
    assert.ok(out.includes('\r\n'), 'CRLF must survive');
    assert.ok(!/[^\r]\n/.test(out), 'no lone LF may be introduced');
  });

  it('restores the final-newline state when insertFinalNewline is undefined', async () => {
    const noNl = await engine.format({
      languageId: 'css',
      code: '.a{color:red}',
      options: resolved()
    });
    assert.ok(
      !/[\r\n]$/.test(noNl),
      'input without final newline: output must not gain one'
    );
    const withNl = await engine.format({
      languageId: 'css',
      code: '.a{color:red}\n',
      options: resolved()
    });
    assert.ok(/\n$/.test(withNl), 'input with final newline: output must keep it');
  });

  it('honours an explicit insertFinalNewline in both directions', async () => {
    const added = await engine.format({
      languageId: 'css',
      code: '.a{color:red}',
      options: resolved({ insertFinalNewline: true })
    });
    assert.ok(/\n$/.test(added), 'insertFinalNewline true must append one');
    const removed = await engine.format({
      languageId: 'css',
      code: '.a{color:red}\n',
      options: resolved({ insertFinalNewline: false })
    });
    assert.ok(
      !/[\r\n]$/.test(removed),
      'insertFinalNewline false must strip the trailing newline'
    );
  });

  it('(range) formats the whole snippet: rangeStart/rangeEnd are never sent to postcss', async () => {
    // Verified behaviour: prettier + parser 'css' + rangeStart/rangeEnd returns
    // the input UNCHANGED, which would silently no-op the fallback. The engine
    // must therefore format the whole snippet when a (whole-span) range is
    // present, and suppress the final-newline policy like the js-beautify range
    // path does.
    const input = '.a{color:red}.b{color:blue}';
    const out = await engine.format({
      languageId: 'css',
      code: input,
      options: resolved({ insertFinalNewline: true }),
      range: { startOffset: 0, endOffset: input.length }
    });
    assert.notEqual(out, input, 'the snippet must actually be reformatted');
    assert.ok(out.includes('color: red'), 'reformat must be visible');
    assert.ok(
      !/[\r\n]$/.test(out),
      'range scope must suppress the final-newline policy'
    );
  });
});

describe('engine/dispatcher : dispatchCssFallback boundaries', () => {
  it('exposes exactly css/scss/less as fallback languages', () => {
    assert.deepEqual([...CSS_FALLBACK_LANGS].sort(), ['css', 'less', 'scss']);
  });

  it('leaves PRIMARY routing untouched: css/scss/less still pick js-beautify', () => {
    for (const lang of ['css', 'scss', 'less'] as const) {
      assert.equal(
        pickEngine(lang).id,
        'js-beautify',
        `${lang} must keep js-beautify as its primary engine`
      );
    }
  });

  it('primary dispatch of the css family never reaches the postcss path', async () => {
    // `.m(@c:red)` is the discriminator: js-beautify spaces the selector colon,
    // prettier keeps it verbatim. If primary routing ever drifted to prettier
    // this assertion flips.
    const out = await dispatchFormat({
      languageId: 'less',
      code: '.m(@c:red){color:@c}',
      options: resolved()
    });
    assert.ok(
      out.includes('.m(@c: red)'),
      `primary must still be js-beautify, got ${JSON.stringify(out)}`
    );
  });

  it('formats scss and less through the postcss parsers', async () => {
    const scss = await dispatchCssFallback({
      languageId: 'scss',
      code: '.a{&:hover{color:red}}',
      options: resolved()
    });
    assert.ok(scss.includes('&:hover'), 'scss nesting must survive');
    const less = await dispatchCssFallback({
      languageId: 'less',
      code: '.m(@c:red){color:@c}',
      options: resolved()
    });
    assert.ok(
      less.includes('.m(@c:red)'),
      'less mixin default must stay verbatim'
    );
  });

  it('throws on any non-CSS language (the fallback surface cannot widen silently)', async () => {
    for (const lang of ['javascript', 'typescript', 'html', 'json'] as const) {
      await assert.rejects(
        dispatchCssFallback({ languageId: lang, code: 'x', options: resolved() }),
        /css fallback does not support/,
        `expected a throw for '${lang}'`
      );
    }
  });

  it('propagates a typed engine error on unparsable css (provider keeps the primary outcome)', async () => {
    await assert.rejects(
      dispatchCssFallback({
        languageId: 'css',
        code: '.a{{{',
        options: resolved()
      }),
      /prettier failed to format css/
    );
  });
});
