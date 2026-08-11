// Unit tests for the PURE status bar model (ADD-05). No 'vscode' anywhere: the
// module under test is vscode-free by contract, so a regression that introduced
// a top-level import would make this file fail to load.
//
// What is locked here:
//   - the passive priority order mirrors the provider's own exit order, so the
//     bar can never announce a state a real format would contradict;
//   - the 12 format statuses each map to a short label, a codicon and a
//     severity, exhaustively;
//   - the CONTENT-FREE contract: a record `detail` never reaches the bar text,
//     and it is Markdown-escaped before it reaches the tooltip.
import assert from 'node:assert/strict';
import {
  computePassiveKind,
  escapeMarkdown,
  renderPassive,
  renderTransient,
  statusShortLabel,
  STATUS_BAR_ENABLE_SETTING,
  TRANSIENT_DISPLAY_MS,
  type PassiveFileState,
  type PassiveGates,
  type PassiveStateKind
} from '../../../src/diagnostics/statusBar';
import type {
  FormatStatus,
  LastFormatRecord
} from '../../../src/diagnostics/lastFormat';

const ALL_STATUSES: readonly FormatStatus[] = [
  'applied',
  'already-tidy',
  'guard-rejected',
  'engine-error',
  'restore-failed',
  'config-error',
  'too-large',
  'ignored-file',
  'ignored-marker',
  'disabled',
  'unsupported',
  'cancelled'
];

const VISIBLE_KINDS: readonly PassiveStateKind[] = [
  'disabled',
  'ignored-file',
  'too-large',
  'other-default',
  'ready-default',
  'ready'
];

// Never the raw character in sources: the repo forbids U+2014 in shipped text.
const EM_DASH = String.fromCharCode(0x2014);

function gates(over: Partial<PassiveGates> = {}): PassiveGates {
  return {
    supported: true,
    enabled: true,
    ignoredByFile: false,
    tooLarge: false,
    defaultFormatter: undefined,
    ...over
  };
}

function state(over: Partial<PassiveFileState> = {}): PassiveFileState {
  return { kind: 'ready', languageId: 'css', maxFileSizeKB: 5120, ...over };
}

function rec(
  status: FormatStatus,
  over: Partial<LastFormatRecord> = {}
): LastFormatRecord {
  return {
    uri: 'file:///w/a.css',
    fileName: 'a.css',
    languageId: 'css',
    status,
    scope: 'document',
    at: '2026-07-29T12:33:05.000Z',
    ...over
  };
}

describe('diagnostics/statusBar : constants', () => {
  it('TRANSIENT_DISPLAY_MS sits in the mandated 5000..8000 ms window', () => {
    assert.ok(TRANSIENT_DISPLAY_MS >= 5000 && TRANSIENT_DISPLAY_MS <= 8000);
  });

  it('exposes the fully-qualified setting id', () => {
    assert.equal(STATUS_BAR_ENABLE_SETTING, 'tidy.statusBar.enable');
  });
});

describe('diagnostics/statusBar : computePassiveKind (provider exit order)', () => {
  it('unsupported wins over everything else', () => {
    assert.equal(
      computePassiveKind(
        gates({
          supported: false,
          enabled: false,
          ignoredByFile: true,
          tooLarge: true,
          defaultFormatter: 'x'
        })
      ),
      'unsupported'
    );
  });

  it('disabled beats ignored, too-large and other-default', () => {
    assert.equal(
      computePassiveKind(
        gates({
          enabled: false,
          ignoredByFile: true,
          tooLarge: true,
          defaultFormatter: 'esbenp.prettier-vscode'
        })
      ),
      'disabled'
    );
  });

  it('ignored-file beats too-large', () => {
    assert.equal(
      computePassiveKind(gates({ ignoredByFile: true, tooLarge: true })),
      'ignored-file'
    );
  });

  it('too-large beats other-default', () => {
    assert.equal(
      computePassiveKind(
        gates({ tooLarge: true, defaultFormatter: 'esbenp.prettier-vscode' })
      ),
      'too-large'
    );
  });

  it('a competing defaultFormatter yields other-default', () => {
    assert.equal(
      computePassiveKind(gates({ defaultFormatter: 'esbenp.prettier-vscode' })),
      'other-default'
    );
  });

  it('Tidy as defaultFormatter yields ready-default', () => {
    assert.equal(
      computePassiveKind(gates({ defaultFormatter: 'ced-lab.tidy-formatter' })),
      'ready-default'
    );
  });

  it('no defaultFormatter yields ready', () => {
    assert.equal(computePassiveKind(gates()), 'ready');
  });
});

describe('diagnostics/statusBar : renderPassive', () => {
  it('unsupported renders an invisible view', () => {
    const view = renderPassive(state({ kind: 'unsupported' }));
    assert.equal(view.visible, false);
    assert.equal(view.text, '');
  });

  it('disabled names the exact per-language enable key', () => {
    const view = renderPassive(state({ kind: 'disabled', languageId: 'json' }));
    assert.ok(view.tooltipMarkdown.includes('tidy.json.enable'));
  });

  it('ignored-file names .soukformatignore', () => {
    const view = renderPassive(state({ kind: 'ignored-file' }));
    assert.ok(view.tooltipMarkdown.includes('.soukformatignore'));
  });

  it('too-large surfaces the exact KB limit', () => {
    const view = renderPassive(state({ kind: 'too-large', maxFileSizeKB: 512 }));
    assert.ok(view.tooltipMarkdown.includes('(512 KB)'), view.tooltipMarkdown);
    assert.ok(view.tooltipMarkdown.includes('tidy.maxFileSizeKB'));
  });

  it('other-default names the competing formatter id and the two opt-in paths', () => {
    const view = renderPassive(
      state({
        kind: 'other-default',
        otherFormatterId: 'esbenp.prettier-vscode'
      })
    );
    assert.ok(view.tooltipMarkdown.includes('esbenp.prettier-vscode'));
    assert.ok(view.tooltipMarkdown.includes('Format Document With'));
    assert.ok(view.tooltipMarkdown.includes('Use Tidy as my Formatter'));
  });

  it('ready and ready-default mention Format Document and the marker note', () => {
    for (const kind of ['ready', 'ready-default'] as const) {
      const view = renderPassive(state({ kind }));
      assert.ok(view.tooltipMarkdown.includes('Format Document'), kind);
      assert.ok(
        view.tooltipMarkdown.includes(
          'In-source tidy-ignore / prettier-ignore markers are checked at format time.'
        ),
        kind
      );
    }
  });

  it('appends the last attempt line when the record belongs to the file', () => {
    const view = renderPassive(
      state({
        lastRecord: rec('guard-rejected', {
          engineId: 'js-beautify',
          detail: 'not equivalent'
        })
      })
    );
    assert.ok(view.tooltipMarkdown.includes('Last attempt'));
    assert.ok(view.tooltipMarkdown.includes('guard blocked'));
    assert.ok(view.tooltipMarkdown.includes('js-beautify'));
    assert.ok(view.tooltipMarkdown.includes('12:33:05 UTC'));
  });

  it('selection-scoped records are labelled (selection)', () => {
    const view = renderPassive(
      state({ lastRecord: rec('applied', { scope: 'selection' }) })
    );
    assert.ok(view.tooltipMarkdown.includes('Last attempt (selection) at'));
  });

  it('every visible kind starts with a codicon and reads "Tidy"', () => {
    for (const kind of VISIBLE_KINDS) {
      const view = renderPassive(state({ kind }));
      assert.equal(view.visible, true, kind);
      assert.match(view.text, /^\$\([a-z-]+\) Tidy$/, `${kind}: ${view.text}`);
    }
  });

  it('passive severity is always none (no permanent alarm)', () => {
    for (const kind of VISIBLE_KINDS) {
      assert.equal(renderPassive(state({ kind })).severity, 'none', kind);
    }
  });

  it('every passive view carries the click-actions footer', () => {
    for (const kind of VISIBLE_KINDS) {
      assert.ok(
        renderPassive(state({ kind })).tooltipMarkdown.includes(
          'Click for actions:'
        ),
        kind
      );
    }
  });

  it('never emits an em dash', () => {
    for (const kind of [...VISIBLE_KINDS, 'unsupported' as const]) {
      const view = renderPassive(
        state({ kind, otherFormatterId: 'x', lastRecord: rec('applied') })
      );
      assert.ok(!view.text.includes(EM_DASH), kind);
      assert.ok(!view.tooltipMarkdown.includes(EM_DASH), kind);
    }
  });
});

describe('diagnostics/statusBar : renderTransient (exhaustive over 12 statuses)', () => {
  it('every status yields a visible, short, labelled view', () => {
    for (const status of ALL_STATUSES) {
      const view = renderTransient(rec(status));
      assert.equal(view.visible, true, status);
      assert.match(view.text, /^\$\([a-z-]+\) Tidy: .+$/, view.text);
      assert.ok(view.text.length <= 48, `${status}: ${view.text.length}`);
      assert.ok(view.tooltipMarkdown.length > 0, status);
      assert.ok(!view.text.includes(EM_DASH), status);
      assert.ok(!view.tooltipMarkdown.includes(EM_DASH), status);
    }
  });

  it('the guard family warns, real errors alert, deliberate skips stay neutral', () => {
    assert.equal(renderTransient(rec('guard-rejected')).severity, 'warning');
    assert.equal(renderTransient(rec('restore-failed')).severity, 'warning');
    assert.equal(renderTransient(rec('engine-error')).severity, 'error');
    assert.equal(renderTransient(rec('config-error')).severity, 'error');
    for (const status of [
      'applied',
      'already-tidy',
      'too-large',
      'ignored-file',
      'ignored-marker',
      'disabled',
      'unsupported',
      'cancelled'
    ] as const) {
      assert.equal(renderTransient(rec(status)).severity, 'none', status);
    }
  });

  it('the detail never reaches the bar text, only the tooltip', () => {
    const view = renderTransient(
      rec('guard-rejected', { detail: 'JSX tag boundary changed' })
    );
    assert.ok(!view.text.includes('JSX'));
    assert.ok(view.tooltipMarkdown.includes('JSX tag boundary changed'));
  });

  it('disabled names the per-language key of the record', () => {
    const view = renderTransient(rec('disabled', { languageId: 'scss' }));
    assert.ok(view.tooltipMarkdown.includes('tidy.scss.enable'));
  });

  it('a hostile markdown detail cannot form a command link', () => {
    const view = renderTransient(
      rec('engine-error', {
        detail: '[evil](command:workbench.action.openSettings)'
      })
    );
    assert.ok(!view.tooltipMarkdown.includes(']('));
  });

  it('carries the click-actions footer and the last attempt line', () => {
    const view = renderTransient(rec('applied', { engineId: 'js-beautify' }));
    assert.ok(view.tooltipMarkdown.includes('Click for actions:'));
    assert.ok(view.tooltipMarkdown.includes('Last attempt at 12:33:05 UTC'));
  });
});

describe('diagnostics/statusBar : statusShortLabel / escapeMarkdown', () => {
  it('every status has a distinct, short, em-dash-free label', () => {
    const seen = new Set<string>();
    for (const status of ALL_STATUSES) {
      const label = statusShortLabel(status);
      assert.ok(label.length > 0 && label.length <= 24, `${status}: ${label}`);
      assert.ok(!label.includes(EM_DASH), status);
      assert.ok(!seen.has(label), `duplicate label: ${label}`);
      seen.add(label);
    }
    assert.equal(seen.size, ALL_STATUSES.length);
  });

  it('escapes link and emphasis syntax, leaving plain text alone', () => {
    const escaped = escapeMarkdown('[x](y) *b* `c`');
    assert.ok(!escaped.includes('[x]'));
    assert.ok(!escaped.includes('(y)'));
    assert.equal(escapeMarkdown('plain words 123'), 'plain words 123');
  });
});
