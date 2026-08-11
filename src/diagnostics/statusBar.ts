// Pure state -> label/tooltip model for the Tidy status bar (ADD-05, v0.3.0).
//
// vscode-free by design (same contract as ./lastFormat): the host wrapper
// (./statusBarHost) gathers plain inputs and renders the views built here onto
// the single StatusBarItem. Everything in this file is covered by plain
// mocha+tsx tests, including the exhaustive 12-status transient mapping.
//
// CONTENT-FREE CONTRACT: a view is built ONLY from LastFormatRecord fields
// (already sanitized by sanitizeDetail), configuration values, languageIds and
// formatter ids. Document source can never reach the bar or the tooltip. Any
// detail string is additionally Markdown-escaped before rendering.
import type { FormatStatus, LastFormatRecord } from './lastFormat';
import { EXTENSION_ID } from '../commands/setDefaultFormatter';

/** Setting key relative to the 'tidy' section (declared in package.json). */
export const STATUS_BAR_ENABLE_KEY = 'statusBar.enable';

/** Fully-qualified setting id, for tests and configuration-change checks. */
export const STATUS_BAR_ENABLE_SETTING = 'tidy.statusBar.enable';

/**
 * How long a transient attempt result stays visible before the passive state
 * repaints. Product spec mandates the 5000..8000 ms window (tested).
 */
export const TRANSIENT_DISPLAY_MS = 6000;

/** Shared tooltip footer: the three actions behind the status bar click. */
const ACTIONS_FOOTER =
  'Click for actions: Explain last format, Preview format (diff), ' +
  'Show Effective Configuration.';

/**
 * The passive states of the active file, first-match-wins priority. Mirrors the
 * provider's own exit order (disabled -> ignored -> too large) so the bar can
 * never announce a state the provider would contradict.
 */
export type PassiveStateKind =
  | 'unsupported'
  | 'disabled'
  | 'ignored-file'
  | 'too-large'
  | 'other-default'
  | 'ready-default'
  | 'ready';

/** The plain boolean gates the host gathers; the decision itself stays pure. */
export interface PassiveGates {
  readonly supported: boolean;
  readonly enabled: boolean;
  readonly ignoredByFile: boolean;
  readonly tooLarge: boolean;
  /** editor.defaultFormatter for the active language, normalized (null -> undefined). */
  readonly defaultFormatter?: string;
}

/**
 * Decide the passive state from the gates. PURE, first match wins; the order is
 * the provider's own exit order so bar and provider can never disagree.
 */
export function computePassiveKind(gates: PassiveGates): PassiveStateKind {
  if (!gates.supported) {
    return 'unsupported';
  }
  if (!gates.enabled) {
    return 'disabled';
  }
  if (gates.ignoredByFile) {
    return 'ignored-file';
  }
  if (gates.tooLarge) {
    return 'too-large';
  }
  if (gates.defaultFormatter === undefined) {
    return 'ready';
  }
  return gates.defaultFormatter === EXTENSION_ID
    ? 'ready-default'
    : 'other-default';
}

/** Everything renderPassive needs. Plain data; no 'vscode' types leak here. */
export interface PassiveFileState {
  readonly kind: PassiveStateKind;
  readonly languageId: string;
  /** The effective tidy.maxFileSizeKB, surfaced in the too-large tooltip. */
  readonly maxFileSizeKB?: number;
  /** The competing editor.defaultFormatter id (kind 'other-default' only). */
  readonly otherFormatterId?: string;
  /** The last format record, ONLY when it belongs to the active document. */
  readonly lastRecord?: LastFormatRecord;
}

/** How the host colors the item background. Passive views are always 'none'. */
export type StatusBarSeverity = 'none' | 'warning' | 'error';

/** A fully-rendered view of the status bar item. Plain data. */
export interface StatusBarView {
  readonly visible: boolean;
  readonly text: string;
  readonly tooltipMarkdown: string;
  readonly severity: StatusBarSeverity;
}

const HIDDEN_VIEW: StatusBarView = {
  visible: false,
  text: '',
  tooltipMarkdown: '',
  severity: 'none'
};

/**
 * Escape Markdown control characters so a (sanitized, single-line) detail can
 * never inject links or formatting into the tooltip. Defense in depth on top of
 * MarkdownString.isTrusted = false in the host.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()<>|#]/g, (c) => `\\${c}`);
}

/**
 * Short, stable label for each format status: what the transient bar shows
 * after "Tidy: ". Exhaustive over FormatStatus (never-guard) so a new status
 * cannot ship without a label. Wording aligned with explainLastFormat.
 */
export function statusShortLabel(status: FormatStatus): string {
  switch (status) {
    case 'applied':
      return 'formatted';
    case 'already-tidy':
      return 'already tidy';
    case 'guard-rejected':
      return 'guard blocked';
    case 'engine-error':
      return 'engine error';
    case 'restore-failed':
      return 'restore failed';
    case 'config-error':
      return 'config error';
    case 'too-large':
      return 'file too large';
    case 'ignored-file':
      return 'ignored (ignore file)';
    case 'ignored-marker':
      return 'ignored (marker)';
    case 'disabled':
      return 'disabled';
    case 'unsupported':
      return 'unsupported';
    case 'cancelled':
      return 'cancelled';
    default: {
      const _never: never = status;
      return _never;
    }
  }
}

/** Codicon name for a transient status. Exhaustive over the same union. */
function transientIcon(status: FormatStatus): string {
  switch (status) {
    case 'applied':
    case 'already-tidy':
      return 'check';
    case 'guard-rejected':
    case 'restore-failed':
      return 'shield';
    case 'engine-error':
    case 'config-error':
      return 'error';
    case 'too-large':
      return 'warning';
    case 'ignored-file':
    case 'ignored-marker':
      return 'eye-closed';
    case 'disabled':
      return 'circle-slash';
    case 'unsupported':
      return 'question';
    case 'cancelled':
      return 'stop-circle';
    default: {
      const _never: never = status;
      return _never;
    }
  }
}

/**
 * Background severity for a transient status: the guard family warns, real
 * errors alert, every deliberate skip stays neutral.
 */
function transientSeverity(status: FormatStatus): StatusBarSeverity {
  switch (status) {
    case 'guard-rejected':
    case 'restore-failed':
      return 'warning';
    case 'engine-error':
    case 'config-error':
      return 'error';
    default:
      return 'none';
  }
}

/** One full tooltip sentence per transient status (EN, content-free). */
function transientSentence(record: LastFormatRecord): string {
  switch (record.status) {
    case 'applied':
      return 'Formatting applied.';
    case 'already-tidy':
      return 'No changes needed: the file already matches your settings.';
    case 'guard-rejected':
      return 'The safety guard rejected the output; your file was left intact.';
    case 'engine-error':
      return 'The engine reported an error; nothing was applied.';
    case 'restore-failed':
      return 'An ignore region could not be restored verbatim; nothing was applied.';
    case 'config-error':
      return 'Options could not be resolved; nothing was applied.';
    case 'too-large':
      return 'Skipped: the file exceeds tidy.maxFileSizeKB.';
    case 'ignored-file':
      return 'Skipped: a .soukformatignore rule excludes this file.';
    case 'ignored-marker':
      return 'Skipped: a top-of-file ignore marker is present.';
    case 'disabled':
      return `Skipped: "tidy.${record.languageId}.enable" is false.`;
    case 'unsupported':
      return 'Skipped: Tidy does not handle this language.';
    case 'cancelled':
      return 'The format was cancelled before finishing.';
    default: {
      const _never: never = record.status;
      return _never;
    }
  }
}

/**
 * The "Last attempt ..." tooltip line for a record. Pure and content-free:
 * time, scope, engine, short label and the (sanitized + escaped) detail only.
 */
function lastAttemptLine(record: LastFormatRecord): string {
  const time =
    record.at.length >= 19 ? `${record.at.slice(11, 19)} UTC` : record.at;
  const scope = record.scope === 'selection' ? ' (selection)' : '';
  const engine = record.engineId ? ` via ${record.engineId}` : '';
  const detail = record.detail ? `: ${escapeMarkdown(record.detail)}` : '';
  return (
    `Last attempt${scope} at ${time}${engine}: ` +
    `${statusShortLabel(record.status)}${detail}`
  );
}

/** Icon + exact reason sentence for each visible passive kind. */
function passiveFace(state: PassiveFileState): { icon: string; reason: string } {
  const lang = state.languageId;
  switch (state.kind) {
    case 'disabled':
      return {
        icon: 'circle-slash',
        reason: `Tidy is turned off for ${lang}: "tidy.${lang}.enable" is false.`
      };
    case 'ignored-file':
      return {
        icon: 'eye-closed',
        reason:
          'This file is excluded by a .soukformatignore rule; Tidy leaves it untouched.'
      };
    case 'too-large':
      return {
        icon: 'warning',
        reason:
          `This file exceeds tidy.maxFileSizeKB ` +
          `(${state.maxFileSizeKB ?? '?'} KB); Tidy will skip it.`
      };
    case 'other-default':
      return {
        icon: 'info',
        reason:
          `Another formatter is the default for ${lang}: ` +
          `"${state.otherFormatterId ?? 'unknown'}". Tidy runs only via ` +
          '"Format Document With..." or after "Tidy: Use Tidy as my Formatter".'
      };
    case 'ready-default':
      return {
        icon: 'check',
        reason:
          `Ready: Tidy is the default formatter for ${lang}. ` +
          'Run Format Document to format.'
      };
    case 'ready':
      return {
        icon: 'check',
        reason:
          `Ready: Tidy can format ${lang}. No default formatter is set; ` +
          'run Format Document or "Format Document With..." to use it.'
      };
    case 'unsupported':
      // Unreachable: renderPassive returns HIDDEN_VIEW before calling this.
      return { icon: 'question', reason: '' };
    default: {
      const _never: never = state.kind;
      return _never;
    }
  }
}

/**
 * Render the passive view for the active file. Hidden for unsupported
 * languages. Severity is always 'none' at rest: colored backgrounds are
 * reserved for transient outcomes so an ignored file never looks like an alarm.
 */
export function renderPassive(state: PassiveFileState): StatusBarView {
  if (state.kind === 'unsupported') {
    return HIDDEN_VIEW;
  }
  const { icon, reason } = passiveFace(state);
  const lines: string[] = ['**Tidy Formatter**', '', reason];
  if (state.kind === 'ready' || state.kind === 'ready-default') {
    lines.push(
      'In-source tidy-ignore / prettier-ignore markers are checked at format time.'
    );
  }
  if (state.lastRecord) {
    lines.push('', lastAttemptLine(state.lastRecord));
  }
  lines.push('', ACTIONS_FOOTER);
  return {
    visible: true,
    text: `$(${icon}) Tidy`,
    tooltipMarkdown: lines.join('\n'),
    severity: 'none'
  };
}

/**
 * Render the transient view for a just-recorded format attempt. The bar text
 * stays short and NEVER carries the detail (tooltip only, escaped).
 */
export function renderTransient(record: LastFormatRecord): StatusBarView {
  const text =
    `$(${transientIcon(record.status)}) Tidy: ` +
    `${statusShortLabel(record.status)}`;
  const lines = [
    '**Tidy Formatter**',
    '',
    transientSentence(record),
    '',
    lastAttemptLine(record),
    '',
    ACTIONS_FOOTER
  ];
  return {
    visible: true,
    text,
    tooltipMarkdown: lines.join('\n'),
    severity: transientSeverity(record.status)
  };
}
