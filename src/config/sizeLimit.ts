// Per-family file size cap resolution (ADD-08).
//
// Why per family: the JSON/JSONC path is the linear jsonc-parser pretty-printer
// (src/engine/jsonFormatter.ts, ~13x faster than js-beautify on large documents,
// see FAMILY_BY_LANG in src/engine/jsbeautify.ts) and its safety guard is a cheap
// value equality (src/safety/guard.ts jsonEqual). Large JSON documents
// (package-lock.json, API dumps) are therefore safe to format well beyond the
// generic 5120 KB cap that protects the heavier js-beautify / Prettier / AST
// guard paths.
//
// Precedence (an explicit value is one the USER set at any settings scope,
// never the package.json default):
//   1. explicit tidy.json.maxFileSizeKB   (json / jsonc only)
//   2. explicit tidy.maxFileSizeKB        (any language)
//   3. built-in default: 10240 KB for json / jsonc, 5120 KB otherwise
//
// Value rules:
//   - an explicit value <= 0 DISABLES the cap (documented intent);
//   - a non-number / non-finite explicit value is IGNORED and resolution falls
//     through to the next layer, never silently disabling the guard;
//   - fractional values are floored.
//
// PURE: MUST NOT import 'vscode'. The host-side reading of the two settings
// lives in src/config/vscodeConfig.ts (readSizeLimit).
import type { LangId } from '../types';

/** Default cap (KB) for the heavy engine families (js-beautify / Prettier). */
export const DEFAULT_MAX_FILE_SIZE_KB = 5120;

/** Default cap (KB) for the fast JSON/JSONC family (linear format + value guard). */
export const JSON_DEFAULT_MAX_FILE_SIZE_KB = 10240;

/** Languages governed by tidy.json.maxFileSizeKB. */
export const JSON_SIZE_LIMIT_LANGS: ReadonlySet<LangId> = new Set<LangId>([
  'json',
  'jsonc'
]);

/** The two setting keys that can govern the cap; surfaced verbatim to the user. */
export type SizeLimitSettingKey = 'tidy.json.maxFileSizeKB' | 'tidy.maxFileSizeKB';

/** Where the winning value came from. Rendered verbatim by describeSizeLimit. */
export type SizeLimitSource = 'user setting' | 'default';

/** Plain input for the pure resolver; values come from config.inspect (unknown). */
export interface SizeLimitInput {
  readonly languageId: LangId;
  /** Explicit user value of tidy.maxFileSizeKB, if set at any scope. */
  readonly globalKB?: unknown;
  /** Explicit user value of tidy.json.maxFileSizeKB, if set at any scope. */
  readonly jsonKB?: unknown;
}

/** The winning cap plus its full attribution (key + origin), for UX surfaces. */
export interface EffectiveSizeLimit {
  /** The winning cap in KB (0 = cap disabled). */
  readonly limitKB: number;
  /** The cap in bytes, or undefined when the cap is disabled. */
  readonly limitBytes: number | undefined;
  /** The setting key that produced the winning value. */
  readonly settingKey: SizeLimitSettingKey;
  /** Whether the value came from the user or from the built-in default. */
  readonly source: SizeLimitSource;
}

/** A value is usable only when it is a real, finite number. */
function isUsableKB(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Normalize a usable KB value into a full EffectiveSizeLimit (immutable). */
function toLimit(
  limitKB: number,
  settingKey: SizeLimitSettingKey,
  source: SizeLimitSource
): EffectiveSizeLimit {
  const normalized = limitKB > 0 ? Math.floor(limitKB) : 0;
  return {
    limitKB: normalized,
    limitBytes: normalized > 0 ? normalized * 1024 : undefined,
    settingKey,
    source
  };
}

/**
 * Resolve the effective size cap for a language. PURE and total: every input
 * shape (including adversarial non-number values) resolves to a usable limit.
 */
export function resolveSizeLimit(input: SizeLimitInput): EffectiveSizeLimit {
  const isJsonFamily = JSON_SIZE_LIMIT_LANGS.has(input.languageId);
  if (isJsonFamily && isUsableKB(input.jsonKB)) {
    return toLimit(input.jsonKB, 'tidy.json.maxFileSizeKB', 'user setting');
  }
  if (isUsableKB(input.globalKB)) {
    return toLimit(input.globalKB, 'tidy.maxFileSizeKB', 'user setting');
  }
  return isJsonFamily
    ? toLimit(JSON_DEFAULT_MAX_FILE_SIZE_KB, 'tidy.json.maxFileSizeKB', 'default')
    : toLimit(DEFAULT_MAX_FILE_SIZE_KB, 'tidy.maxFileSizeKB', 'default');
}

/**
 * Canonical one-line description of the effective cap: shared verbatim by the
 * too-large lastFormat detail, the Output channel line and Show Effective
 * Configuration, so every surface tells the same story. Content-free by
 * construction (numbers and setting keys only, never document content).
 */
export function describeSizeLimit(limit: EffectiveSizeLimit): string {
  if (limit.limitBytes === undefined) {
    return `disabled via ${limit.settingKey} (${limit.source})`;
  }
  return `${limit.limitKB} KB via ${limit.settingKey} (${limit.source})`;
}

/**
 * Recover the setting key named inside a describeSizeLimit() string, so a
 * consumer that only holds the rendered detail (the stored lastFormat record)
 * can still point the user at the exact knob to turn. Returns undefined when the
 * detail was not produced by describeSizeLimit (older record, truncated detail),
 * letting the caller fall back to the generic key.
 */
export function settingKeyFromDescription(
  detail: string | undefined
): SizeLimitSettingKey | undefined {
  if (detail === undefined) {
    return undefined;
  }
  if (detail.includes('via tidy.json.maxFileSizeKB')) {
    return 'tidy.json.maxFileSizeKB';
  }
  if (detail.includes('via tidy.maxFileSizeKB')) {
    return 'tidy.maxFileSizeKB';
  }
  return undefined;
}
