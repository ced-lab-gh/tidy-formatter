// Command: the Tidy status bar click menu (ADD-05, v0.3.0).
//
// A QuickPick over the three EXISTING diagnostic commands: Explain last
// format, Preview format (diff), Show Effective Configuration. Each target is
// read-only or applies only on its own explicit confirmation, so this menu
// adds zero write surface. Cancelling the QuickPick does nothing.
//
// Registered at runtime by extension.ts but NOT contributed to the palette
// (contributes.commands): it only makes sense from the status bar item, and
// each target already has its own palette entry. The manifest test asserts
// this deliberate absence.
//
// Split of concerns (idiome commands/*): top level imports NO 'vscode' so the
// pure item builder is testable under mocha+tsx; the handler requires 'vscode'
// lazily and only ever runs inside the extension host.
import { EXPLAIN_LAST_FORMAT_COMMAND_ID } from './explainLastFormat';
import { PREVIEW_FORMAT_COMMAND_ID } from './previewFormat';
import { SHOW_CONFIG_COMMAND_ID } from './showConfig';

/** Command id (registered by extension.ts; this module owns only the constant). */
export const STATUS_BAR_MENU_COMMAND_ID = 'tidy.statusBarMenu';

/** One QuickPick entry: a label, a one-line description, a target command. */
export interface StatusBarMenuItem {
  readonly label: string;
  readonly description: string;
  readonly commandId: string;
}

/**
 * The menu items, in fixed order. PURE and vscode-free: the labels/ids are
 * asserted by a plain unit test so the menu can never drift from the real
 * command constants.
 */
export function buildStatusBarMenuItems(): readonly StatusBarMenuItem[] {
  return [
    {
      label: '$(question) Explain last format',
      description: 'Why the last format attempt did (or did not do) something',
      commandId: EXPLAIN_LAST_FORMAT_COMMAND_ID
    },
    {
      label: '$(diff) Preview format (diff)',
      description: 'See what Tidy would change, without touching the file',
      commandId: PREVIEW_FORMAT_COMMAND_ID
    },
    {
      label: '$(gear) Show effective configuration',
      description: 'Every option in effect and where it came from',
      commandId: SHOW_CONFIG_COMMAND_ID
    }
  ];
}

/* -------------------------------------------------------------------------- */
/* VS Code handler (loads 'vscode' lazily; runs only in the extension host)     */
/* -------------------------------------------------------------------------- */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

/**
 * Handler for the status bar click. Shows the QuickPick and executes the
 * picked command. Escape / dismiss = no action. Never throws: a failing
 * target command surfaces its own error; a QuickPick failure is swallowed.
 */
export async function showStatusBarMenu(): Promise<void> {
  const vscode = require('vscode');
  try {
    const picked = await vscode.window.showQuickPick(buildStatusBarMenuItems(), {
      title: 'Tidy Formatter',
      placeHolder: 'Pick an action for the active file'
    });
    if (!picked) {
      return; // cancelled: nothing happens
    }
    await vscode.commands.executeCommand(picked.commandId);
  } catch {
    // A menu failure must never break the editor; the palette entries of the
    // three target commands remain available regardless.
  }
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
