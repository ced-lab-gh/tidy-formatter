// Ambient declaration for `postcss-less`, which ships no bundled types and has
// no @types package. The guard (src/safety/guard.ts) only needs `parse`; we
// mirror the shape `postcss-scss` publishes (postcss.Parser/Stringifier) so the
// LESS round-trip guard stays fully typed without pulling a network dependency.
declare module 'postcss-less' {
  import * as postcss from 'postcss';
  export const parse: postcss.Parser<postcss.Root>;
  export const stringify: postcss.Stringifier;
}
