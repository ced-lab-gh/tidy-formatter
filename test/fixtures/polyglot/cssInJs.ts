// CSS-in-JS / embedded-foreign-language template-literal corpus.
//
// Files written in TS/TSX that carry a FOREIGN language inside a tagged (or
// member-call) template literal:
//   - styled-components  : styled.div`...css...`, styled(Base)`...`, styled.button.attrs(...)`...`
//   - css helper         : css`...css...`
//   - createGlobalStyle  : createGlobalStyle`...css...`
//   - lit-html           : html`...html...`
//   - GraphQL            : gql`...graphql...`
//   - SQL                : sql`...sql...`
//
// GROUND TRUTH (probed against the real dispatchFormat + guard before authoring):
//   Prettier WITHOUT its CSS-in-JS plugin does NOT reformat the *contents* of a
//   tagged template literal. It reformats the surrounding JS/TS only and leaves
//   the backtick-delimited body byte-identical. To the JS AST a template quasi is
//   just a string, so the guard treats the whole template body as opaque text:
//     * any change to the JS AROUND the template -> guard REJECTS (AST changed),
//     * any change to the static template body (even whitespace) -> guard REJECTS
//       (the quasi string differs),
//     * a change to an INTERPOLATED expression `${...}` -> guard REJECTS,
//     * reformatting an interpolated expression's inner whitespace -> ACCEPTED
//       (the expression is real JS the guard compares structurally).
//
// SPEC refs: SAFE-01 (AST equivalence guard, §12 "faux positif"/"faux négatif"),
// SAFE-03 (idempotence), ENG-02 (template literals not corrupted).
import type { LangId } from '../../../src/types';

export interface CssInJsAcceptFixture {
  /** Stable id used in the test title. */
  id: string;
  /** Human description of the embedded language under test. */
  desc: string;
  /** SPEC / scenario reference. */
  ref: string;
  /** languageId routed through the real dispatcher (ts/tsx). */
  lang: LangId;
  /** Messy-but-VALID TS/TSX input containing a foreign template literal. */
  input: string;
  /**
   * The EXACT template-literal span(s) (including the backticks) whose content
   * must survive verbatim in the formatted output. These are static quasi spans
   * (no interpolation crossing them), so they are pinned byte-for-byte. A
   * regression that reflows the embedded language fails loudly here.
   */
  verbatim: string[];
  /**
   * Substrings expected to APPEAR in the output because the surrounding JS/TS was
   * reformatted (proves the formatter actually ran on the wrapper, so the test is
   * not vacuously passing on a no-op).
   */
  jsReformatted: string[];
}

export const cssInJsAcceptFixtures: CssInJsAcceptFixture[] = [
  // --- styled-components ----------------------------------------------------
  {
    id: 'PG-STYLED-DIV',
    desc: 'styled.div`` with messy CSS body preserved verbatim',
    ref: 'styled-components',
    lang: 'typescript',
    input: 'const   Box=styled.div`\n  color: red;\n  padding:   4px;\n   margin: 0;\n`;',
    verbatim: ['`\n  color: red;\n  padding:   4px;\n   margin: 0;\n`'],
    jsReformatted: ['const Box = styled.div`']
  },
  {
    id: 'PG-STYLED-INTERP',
    desc: 'styled.div`` with interpolations; static CSS spans preserved',
    ref: 'styled-components interpolation',
    lang: 'typescript',
    input: 'const Box=styled.div`\n  color: ${(p) => p.color};\n  padding: ${4}px;\n`;',
    // The static quasi between the two interpolations is preserved verbatim.
    verbatim: ['\n  color: ', '`\n  color: '],
    jsReformatted: ['const Box = styled.div`', '${(p) => p.color}']
  },
  {
    id: 'PG-STYLED-EXTEND',
    desc: 'styled(Base)`` extension form',
    ref: 'styled-components extend',
    lang: 'typescript',
    input: 'const   X = styled(Base)`\n  color: blue;\n  border:   1px solid;\n`;',
    verbatim: ['`\n  color: blue;\n  border:   1px solid;\n`'],
    jsReformatted: ['const X = styled(Base)`']
  },
  {
    id: 'PG-STYLED-ATTRS',
    desc: 'styled.button.attrs({...})`` — attrs object reformatted, css body preserved',
    ref: 'styled-components attrs',
    lang: 'typescript',
    input: 'const B=styled.button.attrs({type:"button"})`\n  border: none;\n  cursor:   pointer;\n`;',
    verbatim: ['`\n  border: none;\n  cursor:   pointer;\n`'],
    // The attrs() OBJECT is real JS and gets reformatted; the css body does not.
    jsReformatted: ['styled.button.attrs({ type: "button" })`']
  },
  {
    id: 'PG-STYLED-DEEP-INDENT',
    desc: 'styled.div`` with irregular deep indentation kept byte-identical',
    ref: 'styled-components verbatim indentation',
    lang: 'typescript',
    input: 'const X=styled.div`\n        color:red;\n                padding:0;\n`;',
    verbatim: ['`\n        color:red;\n                padding:0;\n`'],
    jsReformatted: ['const X = styled.div`']
  },
  {
    id: 'PG-STYLED-NESTED-AMP',
    desc: 'styled.div`` with nested &:hover + nested tagged template (media.sm``)',
    ref: 'styled-components nested',
    lang: 'typescript',
    input: 'const   X=styled.div`\n  &:hover { color: ${red}; }\n  ${media.sm`padding: 4px;`}\n`;',
    // The inner tagged template body is itself preserved verbatim.
    verbatim: ['media.sm`padding: 4px;`', '&:hover { color: '],
    jsReformatted: ['const X = styled.div`']
  },

  // --- css`` helper ---------------------------------------------------------
  {
    id: 'PG-CSS-HELPER',
    desc: 'css`` helper with compact declarations preserved',
    ref: 'emotion/styled css helper',
    lang: 'typescript',
    input: 'const mix=css`\n  display:flex;\n    align-items:center;\n`;',
    verbatim: ['`\n  display:flex;\n    align-items:center;\n`'],
    jsReformatted: ['const mix = css`']
  },
  {
    id: 'PG-CSS-MULTI-DECL',
    desc: 'two css`` literals in one comma declaration, both bodies preserved',
    ref: 'css helper multiple',
    lang: 'typescript',
    input: 'const a=css`x:1;`,b=css`y:   2;`;',
    verbatim: ['css`x:1;`', 'css`y:   2;`'],
    jsReformatted: ['const a = css`x:1;`']
  },

  // --- createGlobalStyle ----------------------------------------------------
  {
    id: 'PG-GLOBAL-STYLE',
    desc: 'createGlobalStyle`` global CSS preserved verbatim',
    ref: 'styled-components createGlobalStyle',
    lang: 'typescript',
    input: 'const   G=createGlobalStyle`\n  body { margin: 0;   padding:0; }\n`;',
    verbatim: ['`\n  body { margin: 0;   padding:0; }\n`'],
    jsReformatted: ['const G = createGlobalStyle`']
  },

  // --- lit-html `html` ------------------------------------------------------
  {
    id: 'PG-LIT-HTML',
    desc: 'lit-html html`` with irregular HTML indentation preserved',
    ref: 'lit-html',
    lang: 'typescript',
    input: 'const tpl=html`\n  <div class="x">\n      <span>${val}</span>\n  </div>\n`;',
    // Static quasi before the interpolation kept verbatim (incl. the messy indent).
    verbatim: ['`\n  <div class="x">\n      <span>', '</span>\n  </div>\n`'],
    jsReformatted: ['const tpl = html`']
  },
  {
    id: 'PG-LIT-HTML-NO-INTERP',
    desc: 'lit-html html`` without interpolation kept byte-identical',
    ref: 'lit-html static',
    lang: 'typescript',
    input: 'const tpl=html`<ul>  <li>a</li>   <li>b</li></ul>`;',
    verbatim: ['html`<ul>  <li>a</li>   <li>b</li></ul>`'],
    jsReformatted: ['const tpl = html`']
  },

  // --- GraphQL `gql` --------------------------------------------------------
  {
    id: 'PG-GQL-QUERY',
    desc: 'gql`` query with irregular spacing preserved verbatim',
    ref: 'GraphQL gql',
    lang: 'typescript',
    input: 'const Q=gql`\n  query GetUser($id: ID!) {\n      user(id: $id) {   name email }\n  }\n`;',
    verbatim: ['`\n  query GetUser($id: ID!) {\n      user(id: $id) {   name email }\n  }\n`'],
    jsReformatted: ['const Q = gql`']
  },
  {
    id: 'PG-GQL-TABS',
    desc: 'gql`` body using tabs + extra spaces kept byte-identical',
    ref: 'GraphQL gql tabs',
    lang: 'typescript',
    input: 'const Q=gql`\n\tquery   {\n\t\t  field1\n\t\t  field2\n\t}\n`;',
    verbatim: ['`\n\tquery   {\n\t\t  field1\n\t\t  field2\n\t}\n`'],
    jsReformatted: ['const Q = gql`']
  },
  {
    id: 'PG-GQL-MUTATION-INTERP',
    desc: 'gql`` mutation with an interpolated fragment; static spans preserved',
    ref: 'GraphQL gql interpolation',
    lang: 'typescript',
    input: 'const M=gql`\n  mutation($in: In!) {\n    create(input: $in) { id }\n  }\n  ${UserFragment}\n`;',
    verbatim: ['`\n  mutation($in: In!) {\n    create(input: $in) { id }\n  }\n  '],
    jsReformatted: ['const M = gql`']
  },

  // --- SQL `sql` ------------------------------------------------------------
  {
    id: 'PG-SQL-SELECT',
    desc: 'sql`` SELECT with irregular spacing + interpolated parameter',
    ref: 'SQL template tag',
    lang: 'typescript',
    input: 'const q=sql`\n  SELECT *   FROM users\n     WHERE id = ${id}\n`;',
    verbatim: ['`\n  SELECT *   FROM users\n     WHERE id = '],
    jsReformatted: ['const q = sql`']
  },
  {
    id: 'PG-SQL-IN-FUNCTION',
    desc: 'sql`` inside a function body; wrapper reflowed, query preserved',
    ref: 'SQL template tag in fn',
    lang: 'typescript',
    input: 'function run(){return  sql`SELECT * FROM t WHERE a=${x}`;}',
    verbatim: ['sql`SELECT * FROM t WHERE a='],
    jsReformatted: ['function run() {', 'return sql`']
  },

  // --- TSX: styled + JSX together -------------------------------------------
  {
    id: 'PG-TSX-STYLED-JSX',
    desc: 'TSX: styled.div`` definition + JSX usage; JSX reflowed, css preserved',
    ref: 'styled-components in TSX',
    lang: 'typescriptreact',
    input: 'const B=styled.div`\n  color: red;\n  padding:   8px;\n`;const A=()=><B   foo="1"    bar="2">hi</B>;',
    verbatim: ['`\n  color: red;\n  padding:   8px;\n`'],
    jsReformatted: ['const B = styled.div`', '<B foo="1" bar="2">']
  },
  {
    id: 'PG-TSX-LIT-HTML',
    desc: 'TSX: lit-html html`` returned from a component; html body preserved',
    ref: 'lit-html in TSX',
    lang: 'typescriptreact',
    input: 'const render=()=>html`<section>  <h1>${title}</h1>   </section>`;',
    verbatim: ['html`<section>  <h1>'],
    jsReformatted: ['const render = () => html`']
  },

  // --- mixed: multiple foreign languages in one file ------------------------
  {
    id: 'PG-MIXED-GQL-STYLED',
    desc: 'one file with both gql`` and styled.div``; both bodies preserved',
    ref: 'mixed embedded languages',
    lang: 'typescript',
    input: 'const Q=gql`query{me{id}}`;const   S=styled.p`\n  font-size:   12px;\n`;',
    verbatim: ['gql`query{me{id}}`', '`\n  font-size:   12px;\n`'],
    jsReformatted: ['const Q = gql`', 'const S = styled.p`']
  },

  // --- escapes / literal dollar inside embedded bodies ----------------------
  {
    id: 'PG-ESCAPED-BACKTICK',
    desc: 'css`` body containing an escaped backtick survives verbatim',
    ref: 'template escape',
    lang: 'typescript',
    input: 'const s=css`content: "\\`"; color:red;`;',
    verbatim: ['css`content: "\\`"; color:red;`'],
    jsReformatted: ['const s = css`']
  },
  {
    id: 'PG-LITERAL-DOLLAR',
    desc: 'css`` with calc() and a non-interpolated $ in a comment preserved',
    ref: 'template literal dollar',
    lang: 'typescript',
    input: 'const s=css`width: calc(100% - 10px); /* $not interp */`;',
    verbatim: ['css`width: calc(100% - 10px); /* $not interp */`'],
    jsReformatted: ['const s = css`']
  }
];

// --- CORRUPTION corpus -------------------------------------------------------
// Each fixture is an (input, corruptedOutput) pair where the corruptedOutput is
// what a BROKEN engine might emit. The guard MUST reject every one: either the
// JS/TS around the template changed meaning, or the foreign template BODY was
// altered (which the JS AST sees as a different quasi string). This is the
// adversarial half — proving the guard does not blindly trust template content.
export interface CssInJsCorruptionFixture {
  id: string;
  desc: string;
  ref: string;
  lang: LangId;
  input: string;
  /** A meaning-changing "formatted" output that MUST be rejected. */
  corrupted: string;
}

export const cssInJsCorruptionFixtures: CssInJsCorruptionFixture[] = [
  {
    id: 'PG-COR-OPERATOR',
    desc: 'operator flipped (+ -> -) in the JS expression around the template',
    ref: 'SAFE-01 operator corruption',
    lang: 'typescript',
    input: 'const x = a + styled.div`c:1;`;',
    corrupted: 'const x = a - styled.div`c:1;`;'
  },
  {
    id: 'PG-COR-STATEMENT-VALUE',
    desc: 'a sibling statement value changed (1 -> 2)',
    ref: 'SAFE-01 statement corruption',
    lang: 'typescript',
    input: 'const Q = gql`q{a}`;\nconst x = 1;',
    corrupted: 'const Q = gql`q{a}`;\nconst x = 2;'
  },
  {
    id: 'PG-COR-TAG-RENAME',
    desc: 'tag function renamed (css -> sql) — different call target',
    ref: 'SAFE-01 tag corruption',
    lang: 'typescript',
    input: 'const q = css`a:1;`;',
    corrupted: 'const q = sql`a:1;`;'
  },
  {
    id: 'PG-COR-TPL-CONTENT',
    desc: 'static template content changed (query{a} -> query{b})',
    ref: 'SAFE-01 template-body corruption',
    lang: 'typescript',
    input: 'const Q = gql`query{a}`;',
    corrupted: 'const Q = gql`query{b}`;'
  },
  {
    id: 'PG-COR-TPL-WHITESPACE',
    desc: 'whitespace-only edit INSIDE the styled body — meaning-bearing for the JS string, must reject',
    ref: 'SAFE-01 §12 faux négatif (template is opaque text)',
    lang: 'typescript',
    input: 'const B = styled.div`color:   red;`;',
    corrupted: 'const B = styled.div`color: red;`;'
  },
  {
    id: 'PG-COR-TPL-REINDENT',
    desc: 'embedded GraphQL reindented (engine should NOT do this) — quasi differs, reject',
    ref: 'SAFE-01 template reindent',
    lang: 'typescript',
    input: 'const Q = gql`\n  query {\n    a\n  }\n`;',
    corrupted: 'const Q = gql`\nquery {\na\n}\n`;'
  },
  {
    id: 'PG-COR-SQL-NEWLINE',
    desc: 'a newline inserted into the SQL body changes the quasi, must reject',
    ref: 'SAFE-01 sql body corruption',
    lang: 'typescript',
    input: 'const q = sql`SELECT a FROM t`;',
    corrupted: 'const q = sql`SELECT a\nFROM t`;'
  },
  {
    id: 'PG-COR-INTERP-EXPR',
    desc: 'interpolated expression identifier changed (x -> y)',
    ref: 'SAFE-01 interpolation corruption',
    lang: 'typescript',
    input: 'const q = sql`a=${x}`;',
    corrupted: 'const q = sql`a=${y}`;'
  },
  {
    id: 'PG-COR-DROP-INTERP',
    desc: 'an interpolation removed from the lit-html body (structure change)',
    ref: 'SAFE-01 dropped interpolation',
    lang: 'typescript',
    input: 'const t = html`<span>${val}</span>`;',
    corrupted: 'const t = html`<span>val</span>`;'
  },
  {
    id: 'PG-COR-TSX-JSX-BOUNDARY',
    desc: 'TSX file: styled body intact but JSX tag boundary mangled (< Box)',
    ref: 'SAFE-01 JSX boundary alongside CSS-in-JS',
    lang: 'typescriptreact',
    input: 'const B = styled.div`c:1;`;\nconst A = () => <Box foo={x} />;',
    corrupted: 'const B = styled.div`c:1;`;\nconst A = () => < Box foo = {x} />;'
  }
];
