// Differential test: the Vue guard against the real Vue compiler.
//
// The property under test is "the guard ACCEPTS a pair  =>  @vue/compiler-dom
// 3.5.25 (whitespace: 'condense') compiles both templates to the SAME render
// code", in the development build (comments kept) and in the production build
// (comments dropped). A single disagreement is a formatter that would change
// what a user's page renders, so the allowed count is zero.
//
// Pairs come from three places: what js-beautify proposes for each template
// (five option sets, BEFORE the engine's own pre-check, so the guard is tested on
// every raw candidate), the whitespace edits a formatter COULD make, and the
// engine's end-to-end output. The compiler is a devDependency used here only.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dispatchFormat } from '../../../src/engine/dispatcher';
import { htmlTreeEqual, vueSfcEqual } from '../../../src/safety/guard';
import {
  buildVueTemplateCorpus,
  markupMutants,
  seededRng,
  whitespaceMutants,
  type CorpusEntry
} from '../../helpers/vueTemplateCorpus';
import {
  compiledRender,
  ORACLE_OPTION_SETS,
  outerTemplate,
  rawCandidate,
  sameRender,
  templateBody
} from '../../helpers/vueOracle';

interface Pair {
  readonly origin: string;
  readonly input: string;
  readonly output: string;
}

interface Stats {
  pairs: number;
  accepted: number;
  disagreements: Pair[];
  /** Accepted although the two bodies differ textually. */
  acceptedChanged: number;
  /** Rejected although the compiler renders them alike (cost of being strict). */
  rejectedButSame: number;
}

const corpus: CorpusEntry[] = buildVueTemplateCorpus();

/** Judge one pair: the guard first, the compiler only to audit an acceptance. */
function judge(pair: Pair, stats: Stats): void {
  stats.pairs += 1;
  const inputBody = templateBody(pair.input);
  const outputBody = templateBody(pair.output);
  const accepted = vueSfcEqual(pair.input, pair.output).equivalent;
  if (inputBody === undefined || outputBody === undefined) {
    assert.equal(accepted, false, 'a pair that does not split can never be accepted');
    return;
  }
  const same = sameRender(inputBody, outputBody);
  if (!accepted) {
    stats.rejectedButSame += same && inputBody !== outputBody ? 1 : 0;
    return;
  }
  stats.accepted += 1;
  stats.acceptedChanged += inputBody === outputBody ? 0 : 1;
  if (!same) {
    stats.disagreements.push(pair);
  }
}

async function collectPairs(entry: CorpusEntry, index: number): Promise<Pair[]> {
  const pairs: Pair[] = [];
  const input = outerTemplate(entry.template);
  const seen = new Set<string>();
  for (const [name, options] of ORACLE_OPTION_SETS) {
    const candidate = await rawCandidate(input, options);
    if (!seen.has(candidate)) {
      seen.add(candidate);
      pairs.push({ origin: `${entry.id} formatter:${name}`, input, output: candidate });
    }
  }
  const rng = seededRng(1000 + index);
  const mutants = [...whitespaceMutants(entry.template, rng, 5), ...markupMutants(entry.template, rng)];
  for (const mutant of mutants) {
    pairs.push({ origin: `${entry.id} mutant`, input, output: outerTemplate(mutant) });
    pairs.push({ origin: `${entry.id} mutant-reversed`, input: outerTemplate(mutant), output: input });
  }
  return pairs;
}

function describeDisagreements(stats: Stats): string {
  return stats.disagreements
    .slice(0, 5)
    .map(
      (pair) =>
        `${pair.origin}\n  input : ${JSON.stringify(pair.input)}\n  output: ${JSON.stringify(pair.output)}`
    )
    .join('\n');
}

describe('safety/vueCompiledOracle : guard accepts => Vue renders the same', function () {
  this.timeout(240000);

  it('the corpus holds at least 300 distinct templates', () => {
    assert.ok(corpus.length >= 300, `corpus has ${corpus.length} templates`);
    assert.equal(new Set(corpus.map((entry) => entry.template)).size >= 300, true);
  });

  it('zero disagreement on every (input, formatted) and (input, whitespace edit) pair', async () => {
    const stats: Stats = {
      pairs: 0,
      accepted: 0,
      disagreements: [],
      acceptedChanged: 0,
      rejectedButSame: 0
    };
    for (const [index, entry] of corpus.entries()) {
      for (const pair of await collectPairs(entry, index)) {
        judge(pair, stats);
      }
    }
    if (process.env.VUE_ORACLE_STATS) {
      console.log(
        `vue oracle: ${corpus.length} templates, ${stats.pairs} pairs, ${stats.accepted} accepted ` +
          `(${stats.acceptedChanged} textually changed), ${stats.rejectedButSame} rejected though Vue renders alike, ` +
          `${stats.disagreements.length} disagreements`
      );
    }
    assert.ok(stats.pairs >= 3000, `only ${stats.pairs} pairs were judged`);
    assert.ok(stats.acceptedChanged >= 300, `only ${stats.acceptedChanged} changed pairs were accepted`);
    assert.equal(stats.disagreements.length, 0, describeDisagreements(stats));
  });

  it('the engine output is accepted by the guard and renders like the input', async () => {
    let changed = 0;
    for (const entry of corpus) {
      const input = `${outerTemplate(entry.template)}\n`;
      const [, options] = ORACLE_OPTION_SETS[0];
      const output = await dispatchFormat({ languageId: 'vue', code: input, options });
      if (output === input) {
        continue;
      }
      changed += 1;
      assert.equal(vueSfcEqual(input, output).equivalent, true, `${entry.id}: engine output must pass the guard`);
      assert.equal(sameRender(templateBody(input) ?? '', templateBody(output) ?? ''), true, entry.id);
    }
    assert.ok(changed >= 100, `only ${changed} templates were reformatted`);
  });
});

describe('safety/vueCompiledOracle : the compiler stays a test-only dependency', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
    });
  }

  it('no file under src/ imports a @vue/ package', () => {
    const offenders = sourceFiles(join(__dirname, '..', '..', '..', 'src')).filter((file) =>
      /(?:from|require\(|import\()\s*['"]@vue\//.test(readFileSync(file, 'utf8'))
    );
    assert.deepEqual(offenders, []);
  });

  it('is a devDependency pinned to an exact version', () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    assert.equal(manifest.devDependencies?.['@vue/compiler-dom'], '3.5.25');
    assert.equal(manifest.dependencies?.['@vue/compiler-dom'], undefined);
  });
});

describe('safety/vueCompiledOracle : the audit cases (21-verif-100-opus.md)', () => {
  const sfc = (body: string): string => `${outerTemplate(body)}\n`;

  /** The HTML guard used to accept these; Vue renders them differently. */
  const V1_V2: ReadonlyArray<readonly [string, string, string]> = [
    [
      'V1 two components joined by a space',
      '\n<div><MyBtn>A</MyBtn> <MyBtn>B</MyBtn></div>\n',
      '\n  <div>\n    <MyBtn>A</MyBtn>\n    <MyBtn>B</MyBtn>\n  </div>\n'
    ],
    [
      'V1 self-closing components',
      '\n<div><Star /> <Star /> <Star /></div>\n',
      '\n<div>\n<Star />\n<Star />\n<Star />\n</div>\n'
    ],
    [
      'V1 dashed component then a block',
      '\n<div><el-button>A</el-button> <div>x</div></div>\n',
      '\n<div><el-button>A</el-button>\n<div>x</div></div>\n'
    ],
    [
      'V2 text edge before a component',
      '\n<h2>Inbox<Badge :count="n" /></h2>\n',
      '\n<h2>Inbox\n    <Badge :count="n" />\n  </h2>\n'
    ],
    [
      'V2 text edge around a component',
      '\n<p>(<Count :n="n" />)</p>\n',
      '\n<p>( <Count :n="n" />)</p>\n'
    ]
  ];

  for (const [name, before, after] of V1_V2) {
    it(`${name}: HTML guard accepted, Vue renders differently, Vue guard rejects`, () => {
      assert.equal(sameRender(before, after), false, 'the compiler must see a difference');
      assert.equal(
        htmlTreeEqual(before, after).equivalent,
        true,
        'this is the pair the HTML comparison used to accept'
      );
      assert.equal(vueSfcEqual(sfc(before), sfc(after)).equivalent, false);
    });
  }

  it('V1 reformat by the engine is left verbatim, not rewritten', async () => {
    const input = sfc('\n<div><MyBtn>A</MyBtn> <MyBtn>B</MyBtn></div>\n');
    const [, options] = ORACLE_OPTION_SETS[0];
    assert.equal(await dispatchFormat({ languageId: 'vue', code: input, options }), input);
  });

  it('keeps accepting a whitespace change that Vue condenses away', () => {
    const before = '\n<div><span>a</span>\n<span>b</span></div>\n';
    const after = '\n<div>\n  <span>a</span>\n  <span>b</span>\n</div>\n';
    assert.equal(sameRender(before, after), true);
    assert.equal(vueSfcEqual(sfc(before), sfc(after)).equivalent, true);
  });

  it('the oracle itself separates a space from a line break between elements', () => {
    assert.notEqual(
      compiledRender('<a/> <b/>', true),
      compiledRender('<a/>\n<b/>', true)
    );
  });
});
