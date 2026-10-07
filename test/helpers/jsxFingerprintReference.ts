// REFERENCE ORACLE, NOT PRODUCT CODE.
//
// This is the JSX tag-boundary fingerprint exactly as src/safety/guard.ts
// computed it up to ADD-12b: a second @babel/parser pass with `tokens: true`,
// then one mark per `jsxTagStart` token saying whether the token after it starts
// where it ends. It is kept so the AST-position implementation that replaced it
// (see the docblock of `jsxBoundaryFingerprint` in guard.ts) can be compared
// with it, string for string, by
// test/unit/safety/jsxFingerprintDifferential.test.ts: identical on its inputs,
// never fewer marks, and one known stricter difference pinned there by name.
//
// Do not "improve" it. Its whole value is that it is the old behaviour. It is
// quadratic on scripts dense in template literals (that is why it left the
// product), so only ever feed it small inputs.
import { parse } from '@babel/parser';

/** The plugin list the guard uses whenever JSX is part of the grammar. */
export const REFERENCE_JSX_PLUGINS: NonNullable<Parameters<typeof parse>[1]>['plugins'] = [
  'typescript',
  'decorators-legacy',
  'decoratorAutoAccessors',
  'jsx'
];

export function referenceJsxBoundaryFingerprint(code: string): string {
  const ast = parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    allowImportExportEverywhere: true,
    errorRecovery: false,
    tokens: true,
    plugins: REFERENCE_JSX_PLUGINS
  });
  const tokens = (ast.tokens ?? []) as Array<{
    start: number;
    end: number;
    type: unknown;
  }>;
  const labelOf = (token: { type: unknown }): string => {
    const type = token.type as { label?: string } | string | undefined;
    if (type && typeof type === 'object' && typeof type.label === 'string') {
      return type.label;
    }
    return String(type);
  };

  const marks: string[] = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const current = tokens[i];
    const next = tokens[i + 1];
    const currentLabel = labelOf(current);
    // `<` opening a JSX tag (open OR close tag) must be glued to whatever follows
    // it (name, or the `/` of `</tag>` / `< />`). A detached `<` is corruption.
    if (currentLabel === 'jsxTagStart') {
      marks.push(`open:${next.start === current.end ? 'glued' : 'split'}`);
    }
  }
  return marks.join('|');
}
