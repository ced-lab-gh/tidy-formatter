// Shared, lazily-created "Tidy Formatter" output channel. Both the formatting
// provider (a diagnostic trace of each format attempt) and the "Explain last
// format" command write to the SAME channel, so the user has one place to look.
// Content-free by contract: we never log document source, only language, engine,
// status and a short reason.
import * as vscode from 'vscode';

const OUTPUT_CHANNEL_NAME = 'Tidy Formatter';

let channel: vscode.OutputChannel | undefined;

/**
 * The singleton Tidy output channel, created on first use. Push it into
 * `context.subscriptions` once (in activate) so it is disposed on deactivate.
 */
export function getTidyOutputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  }
  return channel;
}
