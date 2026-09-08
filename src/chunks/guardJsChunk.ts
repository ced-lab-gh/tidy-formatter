// Chunk entry: the babel toolchain shared by the JS-family safety guard and
// the dispatcher's JSX detection (ADD-11). Built as dist/chunk-guard-js.js.
// Type-only imports of '@babel/parser' / '@babel/types' stay allowed anywhere
// (they are erased at compile time); VALUE imports must go through here.
// MUST NOT import 'vscode'.
export { parse } from '@babel/parser';
export { traverseFast } from '@babel/types';
