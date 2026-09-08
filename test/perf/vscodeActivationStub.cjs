// Functional vscode API stub, preloaded via `node --require` (ADD-11).
//
// Sibling of vscodeStub.cjs, and deliberately NOT a replacement for it:
//   - vscodeStub.cjs answers every access with a permissive Proxy. That is
//     exactly right for the cold-REQUIRE measurement, where activate() is never
//     called and no stubbed value is ever consumed.
//   - this stub is for the ACTIVATION + FORMAT scenario, where the bundle
//     really runs: it must hand back a number where the code expects a number,
//     capture the providers the extension registers, and return the caller's
//     own fallback from workspace.getConfiguration().get(key, fallback).
//
// Hybrid on purpose: the namespace below defines the handful of APIs the
// activation and format paths actually consume, and anything NOT defined falls
// through to the same permissive Proxy vscodeStub.cjs uses. A missing corner of
// the API therefore degrades to "returns a callable stub" instead of throwing,
// while every API that matters is faithful.
//
// Captured state is published on globalThis.__tidyActivationStub so the child
// script can drive the registered providers.
//
// Plain CommonJS on purpose: `--require` preloads run under plain Node.
'use strict';
const Module = require('node:module');

function makeLooseStub(path) {
  const fn = function stub() {
    return makeLooseStub(`${path}()`);
  };
  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive) {
        return () => `[vscode-stub ${path}]`;
      }
      if (prop === Symbol.toStringTag) {
        return 'VscodeStub';
      }
      if (prop === 'then') {
        // Never thenable: an await on a stubbed namespace must not hang.
        return undefined;
      }
      if (typeof prop === 'symbol') {
        return undefined;
      }
      return makeLooseStub(`${path}.${String(prop)}`);
    },
    apply() {
      return makeLooseStub(`${path}()`);
    },
    construct() {
      return makeLooseStub(`new ${path}`);
    }
  });
}

const captured = {
  formattingProviders: [],
  rangeFormattingProviders: [],
  commands: new Map(),
  outputLines: [],
  warnings: [],
  informations: []
};
globalThis.__tidyActivationStub = captured;

class Disposable {
  constructor(callOnDispose) {
    this._callOnDispose = callOnDispose;
  }
  dispose() {
    if (typeof this._callOnDispose === 'function') {
      this._callOnDispose();
    }
  }
  static from(...items) {
    return new Disposable(() => {
      for (const item of items) {
        if (item && typeof item.dispose === 'function') {
          item.dispose();
        }
      }
    });
  }
}

const noopDisposable = () => new Disposable(() => {});
const noopEvent = () => noopDisposable();

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

class MarkdownString {
  constructor(value) {
    this.value = value ?? '';
    this.isTrusted = false;
    this.supportThemeIcons = false;
  }
  appendMarkdown(value) {
    this.value += value;
    return this;
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

const TextEdit = {
  replace(range, newText) {
    return { range, newText };
  },
  insert(position, newText) {
    return { range: new Range(position, position), newText };
  }
};

const configuration = {
  get(_key, fallback) {
    // Faithful to the real API contract: an unset key yields the caller's own
    // default. Returning a stub here would silently change every resolved
    // option and make the measured format meaningless.
    return fallback;
  },
  has() {
    return false;
  },
  inspect() {
    return undefined;
  },
  async update() {
    /* the stub never writes a setting (anti-hijack: nothing to write to). */
  }
};

const namespace = {
  version: '1.84.0',
  Disposable,
  Position,
  Range,
  Selection: Range,
  TextEdit,
  MarkdownString,
  ThemeColor,
  EndOfLine: { LF: 1, CRLF: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
  Uri: {
    parse: (value) => ({ scheme: 'file', path: String(value), fsPath: String(value), toString: () => String(value) }),
    file: (value) => ({ scheme: 'file', path: String(value), fsPath: String(value), toString: () => `file://${String(value)}` }),
    joinPath: (base, ...parts) => ({
      scheme: 'file',
      path: [base?.path ?? '', ...parts].join('/'),
      fsPath: [base?.fsPath ?? '', ...parts].join('/'),
      toString() {
        return this.path;
      }
    })
  },
  languages: {
    registerDocumentFormattingEditProvider(selector, provider) {
      captured.formattingProviders.push({ selector, provider });
      return noopDisposable();
    },
    registerDocumentRangeFormattingEditProvider(selector, provider) {
      captured.rangeFormattingProviders.push({ selector, provider });
      return noopDisposable();
    }
  },
  commands: {
    registerCommand(id, handler) {
      captured.commands.set(id, handler);
      return noopDisposable();
    },
    registerTextEditorCommand(id, handler) {
      captured.commands.set(id, handler);
      return noopDisposable();
    },
    executeCommand() {
      return Promise.resolve(undefined);
    },
    getCommands() {
      return Promise.resolve([...captured.commands.keys()]);
    }
  },
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    createOutputChannel(name) {
      return {
        name,
        appendLine(line) {
          captured.outputLines.push(line);
        },
        append(text) {
          captured.outputLines.push(text);
        },
        clear() {},
        show() {},
        hide() {},
        dispose() {}
      };
    },
    createStatusBarItem() {
      return {
        text: '',
        tooltip: undefined,
        command: undefined,
        backgroundColor: undefined,
        show() {},
        hide() {},
        dispose() {}
      };
    },
    showInformationMessage(message) {
      captured.informations.push(String(message));
      return Promise.resolve(undefined);
    },
    showWarningMessage(message) {
      captured.warnings.push(String(message));
      return Promise.resolve(undefined);
    },
    showErrorMessage(message) {
      captured.warnings.push(String(message));
      return Promise.resolve(undefined);
    },
    showQuickPick() {
      return Promise.resolve(undefined);
    },
    showTextDocument() {
      return Promise.resolve(undefined);
    },
    withProgress(_options, task) {
      return Promise.resolve(
        task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: noopEvent })
      );
    },
    onDidChangeActiveTextEditor: noopEvent,
    onDidChangeTextEditorSelection: noopEvent,
    onDidChangeVisibleTextEditors: noopEvent
  },
  workspace: {
    isTrusted: true,
    workspaceFolders: undefined,
    name: undefined,
    getConfiguration() {
      return configuration;
    },
    getWorkspaceFolder() {
      return undefined;
    },
    asRelativePath(value) {
      return String(value);
    },
    openTextDocument() {
      return Promise.resolve(undefined);
    },
    applyEdit() {
      return Promise.resolve(true);
    },
    onDidChangeConfiguration: noopEvent,
    onDidGrantWorkspaceTrust: noopEvent,
    onDidChangeWorkspaceFolders: noopEvent
  },
  extensions: {
    all: [],
    getExtension() {
      return undefined;
    }
  },
  env: {
    appName: 'Tidy Startup Harness',
    language: 'en',
    machineId: 'startup-harness',
    sessionId: 'startup-harness',
    uriScheme: 'vscode',
    openExternal() {
      return Promise.resolve(true);
    }
  }
};

// Known keys answer faithfully; everything else degrades to a permissive stub.
const VSCODE_STUB = new Proxy(namespace, {
  get(target, prop) {
    if (prop in target) {
      return target[prop];
    }
    if (prop === 'then' || typeof prop === 'symbol') {
      return undefined;
    }
    return makeLooseStub(`vscode.${String(prop)}`);
  }
});

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return VSCODE_STUB;
  }
  return originalLoad.call(this, request, parent, isMain);
};
