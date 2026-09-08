// Chunk entry: prettier standalone + the exact plugins Tidy uses (ADD-11).
// Built as a standalone CommonJS bundle (dist/chunk-prettier.js); loaded on
// demand through src/chunks/loader.ts, NEVER imported statically by the host.
//
// Why the STANDALONE build plus EXPLICIT plugins: the full 'prettier' entry
// lazy-loads its parser plugins through runtime dynamic imports which, once
// bundled, fail to resolve; the engine would then silently no-op on every
// TS/JSX file. Standalone takes the plugins as values, so they bundle cleanly
// and the parser is always present.
//
// pluginPostcss backs the CSS-family guard-rejection fallback (ADD-01); it
// lives here rather than in chunk-guard-css because it is a PRINTER used by the
// engine, not one of the guard's verifiers.
// MUST NOT import 'vscode'.
export { format } from 'prettier/standalone';
export * as pluginBabel from 'prettier/plugins/babel';
export * as pluginEstree from 'prettier/plugins/estree';
export * as pluginTypescript from 'prettier/plugins/typescript';
export * as pluginPostcss from 'prettier/plugins/postcss';
