// PURE decision logic for surfacing deference to a competing formatter
// (Axe 4 / 4.T5). Given the detected competitors, the user's preference, and the
// one-shot dedup flag, decide whether to NOTIFY, silently DEFER, or do NOTHING —
// and, when notifying, the exact message to show.
//
// ANTI-HIJACK (ARCH-02, SPEC §5/§10/§12) — NON-NEGOTIABLE:
//   - This module DECIDES; it never writes a setting nor touches
//     `editor.defaultFormatter`. The host turns 'notify' into a one-shot, surfaced
//     notification (offering the user an explicit, consented "disable Tidy here"
//     that writes ONLY `tidy.<lang>.enable=false` at Workspace scope).
//   - Deference is NEVER silent disabling: the default is 'notify'; 'silent-defer'
//     records intent for the host but still writes nothing here; 'off' suppresses
//     detection entirely. No branch returns an instruction to disable anything.
//   - The notification is ONE-SHOT: once `alreadyPrompted` is true, we never
//     return 'notify' again (anti-nag, the #1 complaint about the incumbent).
//
// PURE: no 'vscode', no I/O, no throw. Fully unit-testable under mocha+tsx.

/**
 * The user-facing preference (the `tidy.deferToOtherFormatters` enum, added to
 * package.json later in integration; the values are owned here so they cannot
 * drift). Default is 'notify'.
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
 * The globalState key under which the host records that the deference prompt has
 * already been shown for this workspace, so the notification is one-shot.
 */
export const DEFERENCE_PROMPTED_KEY = 'tidy.deference.prompted';

/**
 * What the host should do with a deference detection.
 *
 *  - 'notify' : show the one-shot notification (message is provided).
 *  - 'defer'  : a competitor exists and the user chose 'silent-defer'; the host may
 *               step back quietly. NO write, NO notification.
 *  - 'none'   : nothing to do (no competitor, 'off', or already prompted).
 */
export type DeferenceAction = 'notify' | 'defer' | 'none';

/**
 * The result of {@link decide}: an action and, only for 'notify', the message to
 * surface. PURE data; the host owns presentation and any consented write.
 */
export interface DeferenceDecision {
  readonly action: DeferenceAction;
  /** Present iff action === 'notify'. */
  readonly message?: string;
}

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
 * Human-readable list of detected formatters: "Prettier", "Prettier and Biome",
 * "Prettier, Biome, and dprint". PURE. Input is assumed already de-duplicated and
 * ordered by the detector; empty input yields an empty string (callers guard
 * against that before composing a message).
 */
function listFormatters(detected: readonly string[]): string {
  if (detected.length === 1) {
    return detected[0];
  }
  if (detected.length === 2) {
    return `${detected[0]} and ${detected[1]}`;
  }
  const head = detected.slice(0, -1).join(', ');
  const tail = detected[detected.length - 1];
  return `${head}, and ${tail}`;
}

/**
 * Compose the one-shot deference notification message. PURE. States that a
 * competitor is configured, that Tidy is NOT taking over, and that the user can
 * step Tidy back per language — making the anti-hijack contract explicit.
 */
export function formatDeferenceMessage(detected: readonly string[]): string {
  const names = listFormatters(detected);
  return (
    `This workspace already configures ${names}. ` +
    'Tidy will not take over — your default formatter is unchanged. ' +
    'You can disable Tidy per language for this workspace if you prefer to ' +
    `let ${names} handle formatting.`
  );
}

/**
 * PURE decision: should the host surface deference, quietly defer, or do nothing?
 *
 * Truth table (anti-hijack + anti-nag):
 *   - no competitor detected            -> 'none'   (nothing to defer to)
 *   - setting 'off'                      -> 'none'   (detection ignored entirely)
 *   - setting 'silent-defer'             -> 'defer'  (no notify, no write)
 *   - setting 'notify' & not prompted    -> 'notify' (one-shot, with message)
 *   - setting 'notify' & already prompted-> 'none'   (one-shot dedup)
 *
 * Never returns an instruction to disable anything; 'notify'/'defer' carry no
 * write. The host alone, on explicit user consent, may write tidy.<lang>.enable.
 *
 * @param detected        competing formatters from the detector (de-duped, ordered).
 * @param setting         the user's `tidy.deferToOtherFormatters` preference.
 * @param alreadyPrompted whether the one-shot notification has already been shown.
 */
export function decide(
  detected: readonly string[],
  setting: DeferenceSetting,
  alreadyPrompted: boolean
): DeferenceDecision {
  // Nothing to defer to: a clean workspace never triggers anything.
  if (!Array.isArray(detected) || detected.length === 0) {
    return { action: 'none' };
  }

  if (setting === 'off') {
    return { action: 'none' };
  }

  if (setting === 'silent-defer') {
    // Acknowledge the competitor for the host; never notify, never write.
    return { action: 'defer' };
  }

  // setting === 'notify': one-shot only.
  if (alreadyPrompted) {
    return { action: 'none' };
  }
  return { action: 'notify', message: formatDeferenceMessage(detected) };
}
