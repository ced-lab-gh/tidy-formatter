// The tidy.deferToOtherFormatters preference: its values, its key, how a raw
// setting value is normalised, and the ONE rule for when detecting a competing
// formatter can change anything the user sees.
//
// PURE: no 'vscode', no I/O, no throw. Lives apart from decide.ts and detect.ts
// because both need it and decide.ts already imports detect.ts, so putting it in
// either would make the two import each other.

/**
 * The user-facing preference (the `tidy.deferToOtherFormatters` enum; the values
 * are owned here so they cannot drift from package.json). Default is 'notify'.
 *
 *  - 'notify'        : surface a one-shot notification when a competitor is found.
 *  - 'silent-defer'  : do not notify, but acknowledge a competitor exists (the host
 *                      may quietly step back WITHOUT writing any setting); never a
 *                      nag, never a silent disable of Tidy's settings.
 *  - 'off'           : ignore detection entirely (no notification, no deference).
 */
export type DeferenceSetting = 'notify' | 'silent-defer' | 'off';

/** The default preference: surface the choice, decide nothing for the user. */
export const DEFAULT_DEFERENCE_SETTING: DeferenceSetting = 'notify';

/** The full VS Code setting key (owned here so callers/tests share one source). */
export const DEFERENCE_SETTING_KEY = 'tidy.deferToOtherFormatters';

/**
 * Normalise an arbitrary setting value to a known {@link DeferenceSetting},
 * defaulting unknown / missing values to {@link DEFAULT_DEFERENCE_SETTING}. PURE.
 * Lets the host pass the raw config value without pre-validating it.
 */
export function normalizeSetting(value: unknown): DeferenceSetting {
  return value === 'notify' || value === 'silent-defer' || value === 'off'
    ? value
    : DEFAULT_DEFERENCE_SETTING;
}

/**
 * Whether scanning the workspace for a competing formatter at activation can
 * change anything the user sees. PURE.
 *
 * The scan costs a directory listing and a package.json read per workspace
 * folder, and its answer is only ever used to decide whether to show the
 * one-shot notification. So it matters only when the notification can still be
 * shown: the setting is 'notify' and it has not been shown yet.
 *
 *   - 'off'           : detection is ignored entirely.
 *   - 'silent-defer'  : decide() answers 'defer', and the host acts on nothing but
 *                       'notify': no toast, no setting, no globalState. Nothing
 *                       reads 'defer' (test/unit/deference/decide.test.ts pins
 *                       that), so the scan could not change an outcome.
 *   - 'notify'        : only until the one-shot has been shown.
 *
 * If a host ever starts to act on 'defer', that is the change that must make this
 * return true for 'silent-defer'.
 */
export function detectionCanChangeOutcome(
  setting: DeferenceSetting,
  alreadyPrompted: boolean
): boolean {
  return setting === 'notify' && !alreadyPrompted;
}
