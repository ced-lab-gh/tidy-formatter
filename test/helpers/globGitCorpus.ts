// A corpus of .gitignore cases whose verdicts were taken from REAL git
// (git 2.52, git check-ignore --no-index in a throwaway repository), frozen here
// so the suite keeps protecting the glob matcher on a machine with no git. It
// carries every input of the glob audit (etape 10): character classes (G1),
// negation under an excluded directory (G2), a byte order mark (G3), case (G4),
// runs of three stars (G5), leading and trailing whitespace (G6), and the syntax
// the first round already fixed. globGit.test.ts replays it against Tidy AND,
// when git is installed, against git itself, so a stale row cannot hide.

/** One ignore file, the paths asked about, and what git answered for each. */
export interface GitCorpusRow {
  readonly id: string;
  /** The exact text of the .gitignore (a BOM, CRLF and leading blanks are real). */
  readonly file: string;
  /** core.ignorecase the row was recorded under. */
  readonly ignoreCase: boolean;
  readonly paths: readonly string[];
  /** git check-ignore: true when the path is ignored. */
  readonly expected: readonly boolean[];
}

export const GIT_CORPUS: readonly GitCorpusRow[] = [
  {
    id: "G1 vs template",
    file: "[Dd]ebug/\n[Rr]elease/\n[Bb]in/\n[Oo]bj/\n[Ll]og/\n",
    ignoreCase: false,
    paths: ["Debug/site.css", "debug/site.css", "DEBUG/site.css", "bin/app.js", "Bin/app.js", "src/obj/gen.js", "Obj/gen.js", "release/a.js", "log/a.js", "Logs/a.js", "Debug", "src/Debug", "src/app.js"],
    expected: [true, true, false, true, true, true, true, true, true, false, false, false, false]
  },
  {
    id: "G1 py[cod]",
    file: "*.py[cod]\n",
    ignoreCase: false,
    paths: ["a.pyc", "a.pyo", "a.pyd", "a.pyx", "a.py", "x/y/a.pyc"],
    expected: [true, true, true, false, false, true]
  },
  {
    id: "G1 min.[cj]s",
    file: "*.min.[cj]s\n",
    ignoreCase: false,
    paths: ["lib/a.min.js", "lib/a.min.cs", "lib/a.min.ts", "a.min.js"],
    expected: [true, true, false, true]
  },
  {
    id: "G1 range",
    file: "[a-c].js\n",
    ignoreCase: false,
    paths: ["a.js", "b.js", "c.js", "d.js", "A.js", "x/b.js"],
    expected: [true, true, true, false, false, true]
  },
  {
    id: "G1 negated bang",
    file: "[!a].js\n",
    ignoreCase: false,
    paths: ["a.js", "b.js", "x/c.js", "1.js"],
    expected: [false, true, true, true]
  },
  {
    id: "G1 negated caret",
    file: "[^a].js\n",
    ignoreCase: false,
    paths: ["a.js", "b.js", "x/c.js"],
    expected: [false, true, true]
  },
  {
    id: "G1 ] first",
    file: "[]a].js\n",
    ignoreCase: false,
    paths: ["].js", "a.js", "b.js"],
    expected: [true, true, false]
  },
  {
    id: "G1 posix",
    file: "[[:upper:]][[:digit:]].txt\n",
    ignoreCase: false,
    paths: ["A1.txt", "a1.txt", "AA.txt", "Z9.txt"],
    expected: [true, false, false, true]
  },
  {
    id: "G1 class never crosses slash",
    file: "a[!x]b\n",
    ignoreCase: false,
    paths: ["a/b", "azb", "axb"],
    expected: [false, true, false]
  },
  {
    id: "G1 unterminated matches nothing",
    file: "foo[\n",
    ignoreCase: false,
    paths: ["foo[", "foo", "foo/x"],
    expected: [false, false, false]
  },
  {
    id: "G1 range edge dash",
    file: "[a-]x\n[0-9]y\n",
    ignoreCase: false,
    paths: ["ax", "-x", "bx", "5y", "ay"],
    expected: [true, true, false, true, false]
  },
  {
    id: "G2 packages core",
    file: "*.generated.ts\npackages/*/\n!packages/core/\n",
    ignoreCase: false,
    paths: ["packages/core/api.generated.ts", "packages/core/api.ts", "packages/other/api.ts", "src/a.generated.ts"],
    expected: [true, false, true, true]
  },
  {
    id: "G2 vendor min",
    file: "*.min.js\n!vendor/\n",
    ignoreCase: false,
    paths: ["vendor/jquery.min.js", "vendor/jquery.js", "a.min.js"],
    expected: [true, false, true]
  },
  {
    id: "G2 dist keep",
    file: "dist/\n!dist/keep.css\n",
    ignoreCase: false,
    paths: ["dist/keep.css", "dist/a.css", "keep.css"],
    expected: [true, true, false]
  },
  {
    id: "G2 generated config",
    file: "generated/\n!*.config.js\n",
    ignoreCase: false,
    paths: ["generated/a.config.js", "a.config.js", "generated/a.js"],
    expected: [true, false, true]
  },
  {
    id: "G2 whitelist first level",
    file: "*\n!*/\n!*.js\n",
    ignoreCase: false,
    paths: ["d/a.css", "d/a.js", "a.css", "a.js", "d/e/a.js"],
    expected: [true, false, true, false, false]
  },
  {
    id: "G2 classic whitelist",
    file: "/*\n!/foo\n/foo/*\n!/foo/bar\n",
    ignoreCase: false,
    paths: ["foo/bar/x", "foo/baz/x", "foo/a", "bar/a", "foo"],
    expected: [false, true, true, true, false]
  },
  {
    id: "G2 re-include under allowed dir",
    file: "build/\n!build/\n",
    ignoreCase: false,
    paths: ["build/a.js", "src/build/a.js"],
    expected: [false, false]
  },
  {
    id: "G2 negated last wins on file",
    file: "*.js\n!keep.js\nkeep.js\n",
    ignoreCase: false,
    paths: ["keep.js", "a.js", "src/keep.js"],
    expected: [true, true, true]
  },
  {
    id: "G3 BOM first line",
    file: "\uFEFFdist/\nbuild/\n",
    ignoreCase: false,
    paths: ["dist/a.js", "build/a.js", "src/a.js"],
    expected: [true, true, false]
  },
  {
    id: "G3 BOM first line negation",
    file: "\uFEFF*.js\n!keep.js\n",
    ignoreCase: false,
    paths: ["a.js", "keep.js"],
    expected: [true, false]
  },
  {
    id: "G3 BOM + CRLF",
    file: "\uFEFF*.css\r\n!keep.css\r\n",
    ignoreCase: false,
    paths: ["a.css", "keep.css"],
    expected: [true, false]
  },
  {
    id: "G4 icase dir",
    file: "Dist/\n",
    ignoreCase: true,
    paths: ["dist/a.js", "DIST/a.js", "Dist/a.js", "src/dist/a.js"],
    expected: [true, true, true, true]
  },
  {
    id: "G4 cs dir",
    file: "Dist/\n",
    ignoreCase: false,
    paths: ["dist/a.js", "DIST/a.js", "Dist/a.js"],
    expected: [false, false, true]
  },
  {
    id: "G4 icase ext",
    file: "*.JS\n",
    ignoreCase: true,
    paths: ["a.js", "a.JS", "a.Js", "x/b.js"],
    expected: [true, true, true, true]
  },
  {
    id: "G4 cs ext",
    file: "*.JS\n",
    ignoreCase: false,
    paths: ["a.js", "a.JS"],
    expected: [false, true]
  },
  {
    id: "G4 icase anchored",
    file: "/Src/**/*.TS\n",
    ignoreCase: true,
    paths: ["src/a/b.ts", "SRC/b.Ts", "lib/src/b.ts"],
    expected: [true, true, false]
  },
  {
    id: "G4 icase class quirk [D]",
    file: "[D]ebug\n",
    ignoreCase: true,
    paths: ["Debug", "debug", "DEBUG"],
    expected: [false, false, false]
  },
  {
    id: "G4 icase class quirk [!D]",
    file: "[!D]ebug\n",
    ignoreCase: true,
    paths: ["Debug", "debug", "xebug"],
    expected: [true, true, true]
  },
  {
    id: "G4 icase class [Dd]",
    file: "[Dd]ebug\n",
    ignoreCase: true,
    paths: ["Debug", "debug", "DEBUG", "dEBUG"],
    expected: [true, true, true, true]
  },
  {
    id: "G4 icase range",
    file: "[A-C]x\n",
    ignoreCase: true,
    paths: ["ax", "Ax", "dx", "Dx"],
    expected: [true, true, false, false]
  },
  {
    id: "G4 cs range",
    file: "[A-C]x\n",
    ignoreCase: false,
    paths: ["ax", "Ax", "dx"],
    expected: [false, true, false]
  },
  {
    id: "G4 icase posix upper",
    file: "[[:upper:]]x\n",
    ignoreCase: true,
    paths: ["ax", "Ax", "1x"],
    expected: [true, true, false]
  },
  {
    id: "G5 src/***/gen",
    file: "src/***/gen\n",
    ignoreCase: false,
    paths: ["src/a/b/gen", "src/a/gen", "src/gen", "other/src/a/gen"],
    expected: [true, true, true, false]
  },
  {
    id: "G5 a/***/b",
    file: "a/***/b\n",
    ignoreCase: false,
    paths: ["a/x/y/b", "a/x/b", "a/b"],
    expected: [true, true, true]
  },
  {
    id: "G5 ***/b",
    file: "***/b\n",
    ignoreCase: false,
    paths: ["x/y/b", "b", "x/b"],
    expected: [true, true, true]
  },
  {
    id: "G5 /****/.a",
    file: "/****/.a\n",
    ignoreCase: false,
    paths: ["x/.a", ".a", "x/y/.a"],
    expected: [true, true, true]
  },
  {
    id: "G5 star run inside a segment",
    file: "a/b***c/d\n",
    ignoreCase: false,
    paths: ["a/bxc/d", "a/bx/y/c/d", "a/bc/d"],
    expected: [true, false, true]
  },
  {
    id: "G5 trailing ***",
    file: "a/***\n",
    ignoreCase: false,
    paths: ["a", "a/b", "a/b/c"],
    expected: [false, true, true]
  },
  {
    id: "G5 ** variants",
    file: "x/**\ny/**/z\n**/w\n",
    ignoreCase: false,
    paths: ["x", "x/a", "y/z", "y/a/b/z", "w", "q/w"],
    expected: [false, true, true, true, true, true]
  },
  {
    id: "G6 indented negation",
    file: "*.js\n  !keep.js\n",
    ignoreCase: false,
    paths: ["keep.js", "a.js", "  !keep.js"],
    expected: [true, true, true]
  },
  {
    id: "G6 indented pattern",
    file: "  a.css\n",
    ignoreCase: false,
    paths: ["a.css", "  a.css"],
    expected: [false, true]
  },
  {
    id: "G6 indented comment is a pattern",
    file: "  #note\n",
    ignoreCase: false,
    paths: ["  #note", "#note", "note"],
    expected: [true, false, false]
  },
  {
    id: "G6 trailing space trimmed",
    file: "foo \n",
    ignoreCase: false,
    paths: ["foo", "foo "],
    expected: [true, false]
  },
  {
    id: "G6 escaped trailing space kept",
    file: "foo\\ \n",
    ignoreCase: false,
    paths: ["foo", "foo "],
    expected: [false, true]
  },
  {
    id: "G6 trailing tab is NOT trimmed",
    file: "foo\t\n",
    ignoreCase: false,
    paths: ["foo", "foo\t"],
    expected: [false, true]
  },
  {
    id: "G6 space then escaped space",
    file: "foo\\  \n",
    ignoreCase: false,
    paths: ["foo", "foo "],
    expected: [false, true]
  },
  {
    id: "G6 blank-only line is nothing",
    file: "   \n*.js\n",
    ignoreCase: false,
    paths: ["a.js", "x"],
    expected: [true, false]
  },
  {
    id: "escaped star",
    file: "foo\\*bar\n",
    ignoreCase: false,
    paths: ["foo*bar", "fooxbar"],
    expected: [true, false]
  },
  {
    id: "escaped hash and bang",
    file: "\\#a\n\\!b\n",
    ignoreCase: false,
    paths: ["#a", "!b", "a", "b"],
    expected: [true, true, false, false]
  },
  {
    id: "dir-only vs file",
    file: "build/\n",
    ignoreCase: false,
    paths: ["build", "src/build", "build/x.js", "src/build/x.js"],
    expected: [false, false, true, true]
  },
  {
    id: "star-star-min plain star",
    file: "src**min\n",
    ignoreCase: false,
    paths: ["srcXmin", "src/x/min", "src/min"],
    expected: [true, false, false]
  },
  {
    id: "doubled slash never matches",
    file: "a//b\n//c\nd//\n",
    ignoreCase: false,
    paths: ["a/b", "c", "d", "d/e"],
    expected: [false, false, false, false]
  },
  {
    id: "byte-wise question mark",
    file: "?\n",
    ignoreCase: false,
    paths: ["a", "é", "ab"],
    expected: [true, false, false]
  },
  {
    id: "byte-wise double question mark",
    file: "??\n",
    ignoreCase: false,
    paths: ["a", "é", "ab"],
    expected: [false, true, true]
  },
  {
    id: "non-ASCII literal",
    file: "é.css\n",
    ignoreCase: false,
    paths: ["é.css", "e.css"],
    expected: [true, false]
  }
];
