// Runtime properties of the JSX tag-boundary fingerprint (ADD-12b follow-up):
//
//   1. COST. It is read from the AST the guard already parsed. The guard never
//      asks @babel/parser for `tokens: true` (quadratic on template-literal-dense
//      scripts: 1 MiB in an HTML document went from 4.6 s to 70 s) and never
//      parses a third time. Asserted by counting the calls that reach the parser
//      rather than by timing them, so the test cannot flake under load.
//   2. E1. A chunk LOAD failure raised while the fingerprint is computed is an
//      engine failure and is rethrown, like in every other catch of the guard. It
//      is never reported as a statement about the user's code.
//   3. FAIL CLOSED. Anything else going wrong while reading the tags is a
//      refusal (a file) or a verbatim comparison (an embedded script), never an
//      acceptance.
//   4. THE ONE NON-JSX `<`. The `<` of a TSX generic arrow function is marked like
//      a tag, because the token-based fingerprint marked it: dropping it would
//      accept a detached `< T,>` that used to be refused.
//
// The failures are injected through the loader's test seam: the chunk's `parse`
// is wrapped and the AST it returns is booby-trapped where only the fingerprint
// reads it (`start`, a key the canonical comparison skips without reading).
import assert from 'node:assert/strict';
import {
  ChunkLoadError,
  __resetChunksForTests,
  __setChunkLoadForTests,
  isChunkLoadError
} from '../../../src/chunks/loader';
import { guard } from '../../../src/safety/guard';

const realChunk = require('../../../src/chunks/guardJsChunk') as typeof import('../../../src/chunks/guardJsChunk');

type ParseFn = typeof realChunk.parse;
type ParseOptions = Parameters<ParseFn>[1];

function installJsChunk(wrapParse: (real: ParseFn) => ParseFn): void {
  __setChunkLoadForTests('chunk-guard-js', () => ({
    parse: wrapParse(realChunk.parse),
    traverseFast: realChunk.traverseFast
  }));
}

/** First node of `type` in the tree, depth first. */
function findNode(node: unknown, type: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findNode(item, type);
      if (hit !== undefined) {
        return hit;
      }
    }
    return undefined;
  }
  if (node === null || typeof node !== 'object') {
    return undefined;
  }
  const record = node as Record<string, unknown>;
  if (record.type === type) {
    return record;
  }
  for (const key of Object.keys(record)) {
    if (key === 'loc' || key === 'extra') {
      continue;
    }
    const hit = findNode(record[key], type);
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}

/** Make reading the first JSX opening element's `start` do `onRead`. */
function boobyTrapFirstTag(onRead: () => number): ParseFn {
  return ((code: string, options?: ParseOptions) => {
    const file = realChunk.parse(code, options);
    const tag = findNode(file.program, 'JSXOpeningElement');
    if (tag !== undefined) {
      Object.defineProperty(tag, 'start', { get: onRead, enumerable: true, configurable: true });
    }
    return file;
  }) as ParseFn;
}

const JSX_FILE_IN = 'const a = <A x={1} />;';
const JSX_FILE_OUT = 'const a = <A\n  x={1}\n/>;\n';
const JSX_HTML_IN = '<div><script>const a = <A x={1} />;</script></div>';
const JSX_HTML_OUT = '<div>\n  <script>\n    const a = <A x={1} />;\n  </script>\n</div>';

describe('safety/guard : JSX boundary fingerprint at runtime', function () {
  this.timeout(60000);

  beforeEach(() => {
    __resetChunksForTests();
  });
  afterEach(() => {
    __resetChunksForTests();
  });

  describe('cost: no token pass, no extra parse', () => {
    function countParses(run: () => void): ParseOptions[] {
      const seen: ParseOptions[] = [];
      installJsChunk((real) => ((code: string, options?: ParseOptions) => {
        seen.push(options);
        return real(code, options);
      }) as ParseFn);
      // The loader's own canary parses once when the chunk first loads: load it
      // here, then count only what the guard asks for.
      guard.check('javascript', 'a', 'a;');
      seen.length = 0;
      run();
      return seen;
    }

    it('a .jsx file costs exactly two parses, neither with tokens', () => {
      const seen = countParses(() => {
        assert.equal(guard.check('javascriptreact', JSX_FILE_IN, JSX_FILE_OUT).equivalent, true);
      });
      assert.equal(seen.length, 2, 'one parse per side');
      assert.ok(seen.every((options) => !options?.tokens), 'no parse may ask for tokens');
    });

    it('a .tsx file costs exactly two parses, neither with tokens', () => {
      const seen = countParses(() => {
        assert.equal(
          guard.check('typescriptreact', 'const f = <T,>(x: T) => <A b={x} />;', 'const f = <T,>(x: T) => <A b={x} />;\n').equivalent,
          true
        );
      });
      assert.equal(seen.length, 2);
      assert.ok(seen.every((options) => !options?.tokens));
    });

    it('an executable <script> with JSX costs exactly two parses, neither with tokens', () => {
      const seen = countParses(() => {
        assert.equal(guard.check('html', JSX_HTML_IN, JSX_HTML_OUT).equivalent, true);
      });
      assert.equal(seen.length, 2, 'one parse per side');
      assert.ok(seen.every((options) => !options?.tokens));
    });

    it('a template-literal-dense script keeps its verdicts and needs no token pass', () => {
      const lines: string[] = [];
      for (let i = 0; i < 400; i += 1) {
        lines.push(`const v${i} = \`item-${i} \${a${i % 7}} tail\`; class K${i} { #p = 1; m() { return #p in this; } }`);
      }
      const body = lines.join('\n');
      const seen = countParses(() => {
        assert.equal(guard.check('html', `<script>${body}</script>`, `<script>\n${body}\n</script>`).equivalent, true);
        assert.equal(guard.check('javascript', body, `${body}\n`).equivalent, true);
      });
      assert.equal(seen.length, 4);
      assert.ok(seen.every((options) => !options?.tokens));
    });
  });

  describe('E1: a chunk load failure while reading the tags is an engine failure', () => {
    it('is rethrown out of a .jsx file check, not reported as a rejection', () => {
      installJsChunk(() =>
        boobyTrapFirstTag(() => {
          throw new ChunkLoadError('chunk-guard-js', 'synthetic failure while fingerprinting');
        })
      );
      assert.throws(
        () => guard.check('javascriptreact', JSX_FILE_IN, JSX_FILE_OUT),
        (error: unknown) =>
          isChunkLoadError(error) && /synthetic failure while fingerprinting/.test((error as Error).message)
      );
    });

    it('is rethrown out of an embedded <script> check as well', () => {
      installJsChunk(() =>
        boobyTrapFirstTag(() => {
          throw new ChunkLoadError('chunk-guard-js', 'synthetic failure while fingerprinting');
        })
      );
      assert.throws(
        () => guard.check('html', JSX_HTML_IN, JSX_HTML_OUT),
        (error: unknown) => isChunkLoadError(error)
      );
    });
  });

  describe('fail closed when the tags cannot be read', () => {
    it('a file is REFUSED, with a reason that blames the verifier, not the code', () => {
      installJsChunk(() =>
        boobyTrapFirstTag(() => {
          throw new Error('boom');
        })
      );
      const verdict = guard.check('javascriptreact', JSX_FILE_IN, JSX_FILE_OUT);
      assert.equal(verdict.equivalent, false);
      assert.match(String(verdict.reason), /could not verify JSX integrity/);
    });

    it('a tag whose `<` cannot be located is refused, never skipped', () => {
      // Position 0 holds `c` (of `const`), not a `<`: the walk must not shrug.
      installJsChunk(() => boobyTrapFirstTag(() => 0));
      const verdict = guard.check('javascriptreact', JSX_FILE_IN, JSX_FILE_OUT);
      assert.equal(verdict.equivalent, false);
      assert.match(String(verdict.reason), /could not verify JSX integrity/);
    });

    it('an embedded script falls back to a verbatim body: identical bodies pass, reindented ones do not', () => {
      installJsChunk(() =>
        boobyTrapFirstTag(() => {
          throw new Error('boom');
        })
      );
      // Same body bytes, only the markup around it moved: verbatim equal.
      assert.equal(
        guard.check(
          'html',
          '<div><script>const a = <A />;</script></div>',
          '<div>\n  <script>const a = <A />;</script>\n</div>'
        ).equivalent,
        true
      );
      // The body itself was re-indented: no longer provable, so refused.
      assert.equal(
        guard.check(
          'html',
          '<div><script>const a = <A />;</script></div>',
          '<div><script>\n  const a = <A />;\n</script></div>'
        ).equivalent,
        false
      );
    });
  });

  describe('the `<` of a TSX generic arrow function is fingerprinted like a tag', () => {
    it('refuses a detached `<` there, exactly as the token-based fingerprint did', () => {
      for (const lang of ['typescriptreact', 'javascriptreact'] as const) {
        const verdict = guard.check(lang, 'const f = <T,>(x: T) => x;', 'const f = < T,>(x: T) => x;');
        assert.equal(verdict.equivalent, false, lang);
        assert.equal(verdict.reason, 'JSX tag boundaries were altered by formatting', lang);
      }
    });

    it('does the same inside an executable <script>', () => {
      assert.equal(
        guard.check(
          'html',
          '<script>const f = <T,>(x: T) => x;</script>',
          '<script>const f = < T,>(x: T) => x;</script>'
        ).equivalent,
        false
      );
    });

    it('still accepts an ordinary reflow of a generic arrow', () => {
      assert.equal(
        guard.check('typescriptreact', 'const f = <T,>(x: T) => x;', 'const f = <T,>(\n  x: T\n) => x;').equivalent,
        true
      );
    });
  });
});
