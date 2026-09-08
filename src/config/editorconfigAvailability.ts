// Is the .editorconfig layer actually available in THIS install?
//
// WHY THIS MODULE EXISTS (a fail-safe that used to be silent).
// The `editorconfig` package pulls in @one-ini/wasm, whose CommonJS entry does
// a bare readFileSync of a sibling `one_ini_bg.wasm` at module initialisation.
// editorconfig.ts therefore loads it LAZILY and GUARDED, so a quarantined or
// partially installed asset degrades to "no .editorconfig layer" instead of
// killing activation. That degradation is the right behaviour, but it was
// INVISIBLE: on such an install a project whose .editorconfig says
// `indent_size = 8` was silently formatted with the editor's own indentation,
// with nothing anywhere saying the team's convention had been dropped.
//
// A formatter that silently stops honouring the project's configuration is
// exactly the broken promise Tidy sells against, so the degraded state is now
// STATED once, in the diagnostics surfaces the user already has (the output
// channel and "Show Effective Configuration").
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO:
//   - it does not block or fail a format: formatting must still succeed with
//     the remaining layers;
//   - it does not raise a notification: a modal or toast on every session of a
//     degraded install would be a nag, and the user cannot fix it from there;
//   - it adds no setting: there is nothing here for the user to configure.
//
// PURE: no 'vscode' import, so the probe and its message are unit-testable.
import { loadBundledParseSync, type ParseSyncLoader } from './editorconfig';

/**
 * The one message shown when the EditorConfig parser cannot be loaded.
 *
 * Every clause is literally true of that state: the layer really is skipped,
 * formatting really does continue, and the other layers really do still apply
 * (they are read by different code with no dependency on this parser).
 */
export const EDITORCONFIG_UNAVAILABLE_MESSAGE =
  '.editorconfig: the EditorConfig parser could not be loaded in this install, ' +
  'so the .editorconfig layer is NOT applied. Formatting still works, but any ' +
  "indent_style / indent_size / end_of_line / charset your project's " +
  '.editorconfig sets is being ignored; VS Code settings, .prettierrc and ' +
  '.soukformatrc still apply. Reinstalling Tidy Formatter restores the layer.';

/**
 * Whether the EditorConfig parser can be used at all.
 *
 * The loader is the SAME memoized one readEditorConfigLayer uses, so this probe
 * costs one closure call after the first format and can never disagree with the
 * layer's own outcome. A loader that throws counts as unavailable; this function
 * never throws.
 */
export function isEditorConfigParserAvailable(
  load: ParseSyncLoader = loadBundledParseSync
): boolean {
  try {
    return typeof load() === 'function';
  } catch {
    return false;
  }
}

/**
 * The warnings to surface for the .editorconfig layer: exactly one when its
 * parser is unavailable, none otherwise. Returned as an array so callers can
 * concatenate it with the other layers' warnings without special-casing.
 *
 * Call this ONLY when the layer would really have been read (the caller's
 * gates: on-disk document, trusted workspace, `tidy.editorconfig` enabled).
 * Warning about a layer the user switched off would be noise, not honesty.
 */
export function editorConfigUnavailableWarnings(
  load: ParseSyncLoader = loadBundledParseSync
): string[] {
  return isEditorConfigParserAvailable(load)
    ? []
    : [EDITORCONFIG_UNAVAILABLE_MESSAGE];
}
