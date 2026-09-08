// Chunk entry: the three PostCSS dialect parsers used by the CSS safety guard
// (ADD-11). Built as dist/chunk-guard-css.js.
// MUST NOT import 'vscode'.
export { parse as parseCss } from 'postcss';
export { parse as parseScss } from 'postcss-scss';
export { parse as parseLess } from 'postcss-less';
