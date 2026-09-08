// Activation + first-format measurement child (ADD-11). Run as:
//   node --require test/perf/vscodeActivationStub.cjs \
//        test/perf/activationChild.cjs <absolute path to dist/extension.js>
//
// This is the ONLY check that exercises the lazy chunk boundary in the world
// where it can actually break: the PACKAGED bundle. Unit tests run from src/
// under tsx, where require('./guardCssChunk') resolves a source file and can
// never catch a mis-emitted runtime require. Here the real dist/extension.js
// is required, activated, and driven through a real format, so a chunk that
// fails to resolve next to the bundle reds this gate instead of reaching a user
// as "Tidy refuses to format anything".
//
// Measures / asserts, in a genuinely cold process:
//   - requireMs + activateMs (wall-clock);
//   - chunksAfterActivate: dist/chunk-*.js entries in require.cache right after
//     activate() (MUST be empty: activation may not evaluate a single chunk);
//   - a real TypeScript format through the registered document provider, the
//     resulting edit text, and which chunks that format loaded;
//   - a real JSON format afterwards, and whether it loaded any FURTHER chunk
//     (it must not: jsonc-parser ships inside the host bundle).
//
// Prints ONE JSON line on stdout and nothing else; the parent (startup.ts)
// parses it and applies the budgets. Plain CommonJS: runs under plain Node with
// no TS tooling.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const target = process.argv[2];
if (!target) {
  process.stderr.write(
    'usage: node --require vscodeActivationStub.cjs activationChild.cjs <bundle>\n'
  );
  process.exit(2);
}

const CHUNK_CACHE_RE = /[\\/]dist[\\/]chunk-[^\\/]+\.js$/;

function cachedChunks() {
  return Object.keys(require.cache)
    .filter((key) => CHUNK_CACHE_RE.test(key))
    .map((key) => path.basename(key))
    .sort();
}

// A real on-disk directory so document.uri.fsPath is a genuine path: the ignore
// resolver and the editorconfig lookup walk it for real, exactly as they would
// in the host. Nothing is written to it beyond the scratch dir itself.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tidy-startup-'));

function makeDocument(languageId, text, extension) {
  const filePath = path.join(scratchDir, `sample.${extension}`);
  const posixPath = filePath.replace(/\\/g, '/');
  return {
    languageId,
    fileName: filePath,
    isUntitled: false,
    isDirty: false,
    isClosed: false,
    version: 1,
    eol: 1,
    lineCount: text.split('\n').length,
    uri: {
      scheme: 'file',
      authority: '',
      path: `/${posixPath}`,
      fsPath: filePath,
      query: '',
      fragment: '',
      toString: () => `file:///${posixPath}`
    },
    getText: () => text,
    positionAt: (offset) => ({ line: 0, character: offset }),
    offsetAt: (position) => position.character,
    lineAt: (line) => ({ lineNumber: line, text: text.split('\n')[line] ?? '' })
  };
}

const NEVER_CANCELLED = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} })
};

const FORMATTING_OPTIONS = { tabSize: 2, insertSpaces: true };

function providerFor(languageId) {
  const stub = globalThis.__tidyActivationStub;
  const registration = stub.formattingProviders.find((entry) => {
    const selector = entry.selector;
    if (Array.isArray(selector)) {
      return selector.some((item) => item && item.language === languageId);
    }
    return selector && selector.language === languageId;
  });
  return registration ? registration.provider : undefined;
}

async function formatOnce(languageId, extension, text) {
  const provider = providerFor(languageId);
  if (!provider) {
    throw new Error(`no document formatting provider registered for '${languageId}'`);
  }
  const document = makeDocument(languageId, text, extension);
  const started = performance.now();
  const edits = await provider.provideDocumentFormattingEdits(
    document,
    FORMATTING_OPTIONS,
    NEVER_CANCELLED
  );
  return {
    elapsedMs: performance.now() - started,
    editCount: Array.isArray(edits) ? edits.length : -1,
    editText: Array.isArray(edits) && edits.length > 0 ? edits[0].newText : ''
  };
}

async function main() {
  const requireStart = performance.now();
  const loaded = require(target);
  const requireMs = performance.now() - requireStart;
  const chunksAfterRequire = cachedChunks();

  const context = {
    subscriptions: [],
    extensionPath: path.dirname(target),
    extensionUri: { fsPath: path.dirname(target), path: path.dirname(target) },
    globalState: {
      get: (_key, fallback) => fallback,
      update: () => Promise.resolve(),
      keys: () => [],
      setKeysForSync: () => {}
    },
    workspaceState: {
      get: (_key, fallback) => fallback,
      update: () => Promise.resolve(),
      keys: () => []
    },
    asAbsolutePath: (relative) => path.join(path.dirname(target), relative),
    extensionMode: 2
  };

  const activateStart = performance.now();
  await loaded.activate(context);
  const activateMs = performance.now() - activateStart;
  const chunksAfterActivate = cachedChunks();

  // Scenario 2: first TypeScript format, WITHOUT waiting for the idle preload
  // (the 5 s timer cannot have fired yet). Exercises dispatcher -> prettier
  // chunk -> guard -> chunk-guard-js, all lazily loaded inside the bundle.
  const typescript = await formatOnce(
    'typescript',
    'ts',
    'const  a:number=1;\nfunction  f(x:number){return x+a}\n'
  );
  const chunksAfterTypescript = cachedChunks();

  // Scenario 3: the JSON family must need NO chunk at all (jsonc-parser and
  // js-beautify both live in the host bundle).
  const json = await formatOnce('json', 'json', '{"a":1,"b":[2,3]}');
  const chunksAfterJson = cachedChunks();

  // Scenario 4: CSS pulls exactly the postcss guard chunk, nothing more.
  const css = await formatOnce('css', 'css', '.a{color:red}');
  const chunksAfterCss = cachedChunks();

  // Dispose everything activate() registered, including the idle preload timer:
  // without this the child would linger for the full preload delay.
  for (const subscription of context.subscriptions) {
    if (subscription && typeof subscription.dispose === 'function') {
      subscription.dispose();
    }
  }
  fs.rmSync(scratchDir, { recursive: true, force: true });

  process.stdout.write(
    `${JSON.stringify({
      requireMs,
      activateMs,
      exportsActivate: typeof loaded.activate,
      exportsDeactivate: typeof loaded.deactivate,
      providerCount: globalThis.__tidyActivationStub.formattingProviders.length,
      chunksAfterRequire,
      chunksAfterActivate,
      chunksAfterTypescript,
      chunksAfterJson,
      chunksAfterCss,
      typescript,
      json,
      css,
      warnings: globalThis.__tidyActivationStub.warnings
    })}\n`
  );
}

main().then(
  () => {
    process.exit(0);
  },
  (error) => {
    process.stderr.write(
      `activation child failed: ${error && error.stack ? error.stack : String(error)}\n`
    );
    process.exit(1);
  }
);
