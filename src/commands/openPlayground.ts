// Command: "Tidy: Open Playground" (ADD-03).
//
// Opens TWO untitled scratch documents (a messy CSS file and a messy TSX
// component) so the walkthrough's "Try it now" step works on disposable,
// in-memory buffers. The samples are embedded in the bundle at build time and
// are locked byte-for-byte against samples/messy.css / samples/messy.tsx by a
// unit test, so the playground, the README visuals and the integration demo all
// showcase the SAME real inputs.
//
// SAFETY / ANTI-HIJACK (NON-NEGOTIABLE):
//   - ZERO disk writes: untitled documents only (openTextDocument({ content })).
//     Closing them leaves no trace, and no path on this module ever touches the
//     file system.
//   - ZERO formatting: this command never calls an engine. Formatting the
//     playground happens exclusively through the explicit preview/format
//     commands, which run the full pipeline INCLUDING the semantic guard.
//   - ZERO hooks, ZERO settings written, ZERO new activation events.
//
// Split of concerns (same idiom as previewFormat.ts): the module's TOP LEVEL
// imports NO 'vscode', so the constants below are unit-testable under plain
// mocha+tsx. The host surface is required lazily inside the handler.
import type { LangId } from '../types';
// The shared, 'vscode'-free detail sanitizer: a host/engine error can embed a
// multi-line payload carrying the user's own content, which must never reach a
// notification. Every error surfaced below goes through it.
import { sanitizeDetail } from '../diagnostics/lastFormat';

/** Command id (registered by extension.ts; this module owns only the constant). */
export const OPEN_PLAYGROUND_COMMAND_ID = 'tidy.openPlayground';

/**
 * The messy CSS sample, byte-identical to samples/messy.css (LF). Shows the
 * guard-relevant constructs the listing advertises: calc(), the > combinator,
 * :nth-child(2n), jammed selectors.
 */
export const PLAYGROUND_CSS_SAMPLE =
  '.card{display:flex;padding:8px;color:red}\n' +
  '   #main   >   .item:nth-child(2n){margin:calc(100% - 20px);background:blue}\n' +
  'a:hover{text-decoration:underline}    .footer    {   gap : 12px  }\n';

/**
 * The messy TSX sample, byte-identical to samples/messy.tsx (LF). Shows JSX
 * staying valid and the ?. / ?? operators surviving.
 */
export const PLAYGROUND_TSX_SAMPLE =
  'import {useState,useEffect} from "react"\n' +
  'type Props={title:string,count?:number}\n' +
  'export function Widget({title,count=0}:Props){\n' +
  'const [n,setN]=useState(count);useEffect(()=>{console.log(n?.toString()??"none")},[n])\n' +
  'return <div className="card"   onClick={()=>setN(n+1)}><h1>{title}</h1><span>{n}</span></div>\n' +
  '}\n';

/** One untitled playground document to open. PURE data. */
export interface PlaygroundDocument {
  readonly languageId: LangId;
  readonly content: string;
}

/**
 * The playground contents, in OPEN order. The CSS document is opened first and
 * stays focused (js-beautify formats it near-instantly, so the first preview is
 * immediate); the TSX tab opens beside it without stealing focus.
 */
export const PLAYGROUND_DOCUMENTS: readonly PlaygroundDocument[] = [
  { languageId: 'css', content: PLAYGROUND_CSS_SAMPLE },
  { languageId: 'typescriptreact', content: PLAYGROUND_TSX_SAMPLE }
];

/**
 * Non-blocking toast shown once the playground is open. English, em-dash free.
 * Names the shipped command title verbatim so the user can find it in the
 * palette: "Preview Format (Diff)" as contributed in package.json.
 */
export const PLAYGROUND_READY_MESSAGE =
  'Playground ready: two scratch files opened (CSS and TSX). ' +
  'Run "Tidy: Preview Format (Diff)" to see what Tidy would change. ' +
  'Nothing is written to disk.';

/**
 * Compose the non-blocking error message for a host failure. Kept pure (and
 * exported) so the wording is testable without an Electron host. The detail is
 * always a FIRST LINE only: an engine or host error can embed a multi-line
 * payload carrying the user's own content, which must never reach a toast.
 */
export function playgroundErrorMessage(detail: string): string {
  return `Tidy: could not open the playground (${detail}).`;
}

/* -------------------------------------------------------------------------- */
/* VS Code handler (loads 'vscode' lazily; runs only in the extension host)     */
/* -------------------------------------------------------------------------- */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

/**
 * Handler for "Tidy: Open Playground".
 *
 * Flow: open each playground document as UNTITLED (nothing on disk), show the
 * first one focused and every later one in the group BESIDE it without taking
 * focus, then surface a non-blocking "what next" toast. Never throws: any host
 * failure is surfaced as a non-blocking error message (first line only, never a
 * code frame).
 */
export async function openPlayground(): Promise<void> {
  const vscode = require('vscode');
  try {
    let firstEditorShown = false;
    for (const sample of PLAYGROUND_DOCUMENTS) {
      const document = await vscode.workspace.openTextDocument({
        language: sample.languageId,
        content: sample.content
      });
      // The FIRST sample takes the active group and the focus. Every later
      // sample opens BESIDE it and must not steal that focus.
      //
      // `preserveFocus` alone is not enough: without an explicit viewColumn the
      // later document is shown in the SAME editor group, where it becomes that
      // group's active editor regardless of preserveFocus. The CSS tab then
      // silently loses focus and the very next "Preview Format (Diff)" runs on
      // the TSX sample instead : exactly the opposite of what this command and
      // the "Try it now" walkthrough step promise. ViewColumn.Beside puts the
      // later sample in its own group, so preserveFocus can actually hold.
      const showOptions = firstEditorShown
        ? {
            preview: false,
            preserveFocus: true,
            viewColumn: vscode.ViewColumn.Beside
          }
        : { preview: false, preserveFocus: false };
      await vscode.window.showTextDocument(document, showOptions);
      firstEditorShown = true;
    }
    void vscode.window.showInformationMessage(PLAYGROUND_READY_MESSAGE);
  } catch (error: unknown) {
    const detail =
      error instanceof Error ? sanitizeDetail(error.message) : 'unknown error';
    void vscode.window.showErrorMessage(playgroundErrorMessage(detail));
  }
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
