// Unit tests for "Tidy: Open Playground" (ADD-03).
//
// The module has NO top-level 'vscode' import, so this file loading at all under
// plain mocha+tsx is itself an assertion (same idiom as previewFormat.test.ts).
//
// Two layers here:
//   1. the PURE surface: command id, the embedded samples (locked byte-for-byte
//      against samples/messy.css and samples/messy.tsx, so the playground, the
//      listing visuals and the integration demo can never drift apart), and the
//      shipped strings (English, em-dash free);
//   2. the HANDLER, exercised against a fake 'vscode' injected through the CJS
//      loader. That is what lets us prove, without an Electron host, the two
//      claims the walkthrough makes: the samples really are injected into
//      untitled buffers, and opening the playground writes NOTHING to disk (the
//      fs write surface is booby-trapped for the duration of the call).
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Module from 'node:module';
import {
  OPEN_PLAYGROUND_COMMAND_ID,
  PLAYGROUND_CSS_SAMPLE,
  PLAYGROUND_TSX_SAMPLE,
  PLAYGROUND_DOCUMENTS,
  PLAYGROUND_READY_MESSAGE,
  openPlayground,
  playgroundErrorMessage
} from '../../../src/commands/openPlayground';

const ROOT = path.resolve(__dirname, '../../..');

/** Read a repo sample, normalising CRLF checkouts back to the committed LF. */
function readSample(rel: string): string {
  return fs
    .readFileSync(path.join(ROOT, 'samples', rel), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('commands/openPlayground : constants', () => {
  it('exposes the stable command id', () => {
    assert.equal(OPEN_PLAYGROUND_COMMAND_ID, 'tidy.openPlayground');
  });

  it('opens exactly two documents: css first (focused), typescriptreact second', () => {
    assert.equal(PLAYGROUND_DOCUMENTS.length, 2);
    assert.equal(PLAYGROUND_DOCUMENTS[0].languageId, 'css');
    assert.equal(PLAYGROUND_DOCUMENTS[0].content, PLAYGROUND_CSS_SAMPLE);
    assert.equal(PLAYGROUND_DOCUMENTS[1].languageId, 'typescriptreact');
    assert.equal(PLAYGROUND_DOCUMENTS[1].content, PLAYGROUND_TSX_SAMPLE);
  });
});

describe('commands/openPlayground : samples are the real repo samples (no drift)', () => {
  it('the embedded CSS sample is byte-identical to samples/messy.css', () => {
    assert.equal(PLAYGROUND_CSS_SAMPLE, readSample('messy.css'));
  });

  it('the embedded TSX sample is byte-identical to samples/messy.tsx', () => {
    assert.equal(PLAYGROUND_TSX_SAMPLE, readSample('messy.tsx'));
  });

  it('the samples keep the guard-relevant showcase constructs', () => {
    // If someone "simplifies" the samples, the aha moment dies silently. Lock
    // the constructs the listing and tryit.md advertise.
    assert.ok(PLAYGROUND_CSS_SAMPLE.includes('calc(100% - 20px)'));
    assert.ok(PLAYGROUND_CSS_SAMPLE.includes(':nth-child(2n)'));
    assert.ok(PLAYGROUND_TSX_SAMPLE.includes('?.toString()'));
    assert.ok(PLAYGROUND_TSX_SAMPLE.includes('??'));
    assert.ok(PLAYGROUND_TSX_SAMPLE.includes('<div className="card"'));
  });

  it('both samples are messy enough that a format has something to show', () => {
    assert.ok(PLAYGROUND_CSS_SAMPLE.includes('   #main   >   '));
    assert.ok(PLAYGROUND_TSX_SAMPLE.includes('import {useState,useEffect}'));
  });
});

describe('commands/openPlayground : shipped strings hygiene', () => {
  it('the ready message is English, actionable, and mentions zero disk writes', () => {
    assert.ok(PLAYGROUND_READY_MESSAGE.includes('Preview Format (Diff)'));
    assert.ok(PLAYGROUND_READY_MESSAGE.includes('Nothing is written to disk'));
  });

  it('the ready message names the command title contributed in package.json', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')
    ) as { contributes: { commands: { command: string; title: string }[] } };
    const preview = manifest.contributes.commands.find(
      (c) => c.command === 'tidy.previewFormat'
    );
    assert.ok(preview, 'tidy.previewFormat must be contributed');
    assert.ok(
      PLAYGROUND_READY_MESSAGE.includes(preview!.title),
      `the toast must name the shipped title '${preview!.title}'`
    );
  });

  it('the error message keeps the detail inline and stays English', () => {
    assert.equal(
      playgroundErrorMessage('host unavailable'),
      'Tidy: could not open the playground (host unavailable).'
    );
  });

  it('no exported string contains an em dash (U+2014)', () => {
    for (const s of [
      OPEN_PLAYGROUND_COMMAND_ID,
      PLAYGROUND_CSS_SAMPLE,
      PLAYGROUND_TSX_SAMPLE,
      PLAYGROUND_READY_MESSAGE,
      playgroundErrorMessage('x')
    ]) {
      assert.ok(!s.includes('\u2014'), 'shipped strings must not contain U+2014');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Handler, against a fake 'vscode' + a booby-trapped fs                        */
/* -------------------------------------------------------------------------- */

interface OpenedDocument {
  readonly language: string;
  readonly content: string;
}

interface FakeHost {
  readonly opened: OpenedDocument[];
  readonly shown: { doc: unknown; options: { preserveFocus?: boolean } }[];
  readonly info: string[];
  readonly errors: string[];
}

/** Install a fake 'vscode' for the duration of `run`, and report what it saw. */
async function withFakeVscode(
  run: () => Promise<void>,
  options: { failOnOpen?: Error } = {}
): Promise<FakeHost> {
  const host: FakeHost = { opened: [], shown: [], info: [], errors: [] };
  const fake = {
    workspace: {
      openTextDocument: async (opts: OpenedDocument) => {
        if (options.failOnOpen) {
          throw options.failOnOpen;
        }
        host.opened.push(opts);
        return { isUntitled: true, ...opts };
      }
    },
    window: {
      showTextDocument: async (doc: unknown, opts: { preserveFocus?: boolean }) => {
        host.shown.push({ doc, options: opts });
        return undefined;
      },
      showInformationMessage: (message: string) => {
        host.info.push(message);
        return undefined;
      },
      showErrorMessage: (message: string) => {
        host.errors.push(message);
        return undefined;
      }
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loader = Module as unknown as { _load: (...args: any[]) => unknown };
  const original = loader._load;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loader._load = function (this: unknown, request: string, ...rest: any[]): unknown {
    return request === 'vscode'
      ? fake
      : (original as (...args: unknown[]) => unknown).call(
          this,
          request,
          ...rest
        );
  };
  try {
    await run();
  } finally {
    loader._load = original;
  }
  return host;
}

/**
 * Replace every fs write entry point with a throwing stub for the duration of
 * `run`. Any disk write attempted by the code under test therefore becomes a
 * loud failure instead of a silent side effect.
 */
async function withNoDiskWrites(run: () => Promise<void>): Promise<void> {
  const writers = [
    'writeFile',
    'writeFileSync',
    'appendFile',
    'appendFileSync',
    'mkdir',
    'mkdirSync',
    'open',
    'openSync',
    'createWriteStream'
  ] as const;
  // Patch the REAL CommonJS fs module object, not this file's imported
  // namespace: the transpiled namespace is a getter-only copy, so writing to it
  // would patch nothing and prove nothing.
  const target = Module.createRequire(__filename)('node:fs') as Record<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any
  >;
  const saved = new Map<string, unknown>();
  for (const name of writers) {
    saved.set(name, target[name]);
    target[name] = (): never => {
      throw new Error(`fs.${name} must never be called by the playground`);
    };
  }
  // Self-check: a trap that silently failed to install would make every
  // "writes nothing" assertion below vacuous.
  assert.throws(
    () => (target.writeFileSync as () => void)(),
    /must never be called/,
    'the fs write trap must be armed'
  );
  try {
    await run();
  } finally {
    for (const [name, fn] of saved) {
      target[name] = fn;
    }
  }
}

describe('commands/openPlayground : handler (fake host, no disk)', () => {
  it('injects both embedded samples into UNTITLED buffers, css focused first', async () => {
    let host: FakeHost | undefined;
    await withNoDiskWrites(async () => {
      host = await withFakeVscode(() => openPlayground());
    });

    assert.ok(host);
    assert.deepEqual(host!.opened, [
      { language: 'css', content: PLAYGROUND_CSS_SAMPLE },
      { language: 'typescriptreact', content: PLAYGROUND_TSX_SAMPLE }
    ]);
    // openTextDocument({ language, content }) is the untitled path: a URI
    // argument would have opened a file on disk instead.
    for (const opened of host!.opened) {
      assert.deepEqual(Object.keys(opened).sort(), ['content', 'language']);
    }
    assert.equal(host!.shown.length, 2);
    assert.equal(host!.shown[0].options.preserveFocus, false);
    assert.equal(host!.shown[1].options.preserveFocus, true);
  });

  it('writes nothing to disk and surfaces the ready toast', async () => {
    let host: FakeHost | undefined;
    await withNoDiskWrites(async () => {
      host = await withFakeVscode(() => openPlayground());
    });
    assert.deepEqual(host!.info, [PLAYGROUND_READY_MESSAGE]);
    assert.deepEqual(host!.errors, []);
  });

  it('never throws on a host failure: one non-blocking, first-line-only error', async () => {
    const host = await withFakeVscode(() => openPlayground(), {
      failOnOpen: new Error('host is gone\nsecond line with user content')
    });
    assert.deepEqual(host.opened, []);
    assert.deepEqual(host.info, []);
    assert.deepEqual(host.errors, [playgroundErrorMessage('host is gone')]);
    assert.ok(
      !host.errors[0].includes('second line'),
      'only the first line of an error may reach the user'
    );
  });

  it('the module source touches no file-system API at all', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'src', 'commands', 'openPlayground.ts'),
      'utf8'
    );
    for (const forbidden of [
      "require('fs')",
      "require('node:fs')",
      "from 'fs'",
      "from 'node:fs'",
      'workspace.fs',
      'writeFile',
      'Uri.file'
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `openPlayground.ts must not reference ${forbidden}`
      );
    }
  });
});
