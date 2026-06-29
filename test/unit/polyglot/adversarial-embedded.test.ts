// Adversarial POLYGLOT (embedded-language) suite — the deepest test of the HTML
// safety guard, attacked from the seam where HTML hosts OTHER languages.
//
// An HTML file is rarely just HTML: it embeds CSS (<style>), JavaScript
// (<script>), JSON data (<script type="application/json">), verbatim text
// (<pre>/<textarea>), and inline event-handler JS (onclick=...). The guard
// (`htmlTreeEqual`) canonicalises each embedded body through ITS OWN language so a
// pure reindent passes but any real change does not (SPEC §3, §12; the guard
// notes on canonicalizeEmbeddedCode / cssShape / canonicalizeJsonForEmbed).
//
// Every fixture here keeps the surrounding HTML structurally identical and
// corrupts ONLY the embedded payload — a CSS value, a JS instruction, a JSON
// key/value, verbatim text, or an inline handler. Each MUST be rejected
// (`equivalent === false`) with a non-empty reason.
//
// Why this proves the guard's worth (the parse-only trap, two layers deep):
//   1. INDEPENDENT HTML ORACLE — every corrupted output is a well-formed HTML
//      document (parse5 throws nothing). A guard that only re-parsed the HTML
//      would ship the corruption.
//   2. INDEPENDENT EMBEDDED ORACLE — for the css/js/json cases the corrupted
//      PAYLOAD is itself well-formed in its own language (postcss / @babel/parser
//      / JSON.parse succeed). So even a guard that re-parsed the embedded snippet
//      in isolation would ship it. Only the deep, per-language *value/tree* diff
//      inside htmlTreeEqual catches the meaning change.
//
// Conventions: mocha BDD + node:assert/strict. Fixtures live in
// test/fixtures/polyglotFixtures.ts so the data set is reusable and auditable.
import assert from 'node:assert/strict';
import { parse as parseHtml } from 'parse5';
import { parse as parseCss } from 'postcss';
import { parse as babelParse } from '@babel/parser';
import { guard, htmlTreeEqual } from '../../../src/safety/guard';
import { polyglotFixtures, type PolyglotFixture } from '../../fixtures/polyglotFixtures';

// ---------------------------------------------------------------------------
// Independent oracle #1: does the corrupted output parse as an HTML document?
// parse5 is error-tolerant, so only a thrown error counts as "no parse". When
// this returns true, a re-parse-only HTML guard would have accepted the file.
// ---------------------------------------------------------------------------
function htmlParses(html: string): boolean {
  try {
    parseHtml(html);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Independent oracle #2: is the corrupted EMBEDDED payload well-formed in its
// own language? If yes, a guard that re-parsed only the embedded snippet would
// ALSO have accepted the corruption — the deep value diff is the real defense.
// ---------------------------------------------------------------------------
function embeddedPayloadWellFormed(f: PolyglotFixture): boolean {
  if (f.corruptedPayload === undefined) {
    return false;
  }
  try {
    switch (f.embedded) {
      case 'css':
        parseCss(f.corruptedPayload);
        return true;
      case 'js':
        babelParse(f.corruptedPayload, {
          sourceType: 'unambiguous',
          allowReturnOutsideFunction: true,
          plugins: ['typescript', 'jsx', 'decorators-legacy']
        });
        return true;
      case 'json':
        JSON.parse(f.corruptedPayload);
        return true;
      default:
        return false;
    }
  } catch {
    return false;
  }
}

describe('adversarial polyglot — embedded-language corruption MUST be rejected', () => {
  it(`covers >= 18 polyglot cases (actual: ${polyglotFixtures.length})`, () => {
    assert.ok(
      polyglotFixtures.length >= 18,
      `expected at least 18 polyglot fixtures, found ${polyglotFixtures.length}`
    );
  });

  it('every fixture id is unique (no accidental duplicate)', () => {
    const ids = polyglotFixtures.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate fixture ids found');
  });

  it('covers all five embedded surfaces: <style>, <script>, json, verbatim, inline attr', () => {
    const kinds = new Set(polyglotFixtures.map((f) => f.embedded));
    for (const kind of ['css', 'js', 'json', 'verbatim', 'attr'] as const) {
      assert.ok(kinds.has(kind), `no polyglot fixture for embedded surface '${kind}'`);
    }
  });

  it('every fixture is on the html languageId (the polyglot host)', () => {
    for (const f of polyglotFixtures) {
      assert.equal(f.lang, 'html', `fixture ${f.id} must target the html languageId`);
    }
  });

  for (const f of polyglotFixtures) {
    it(`${f.id} [${f.embedded}]: ${f.desc}`, () => {
      const verdict = guard.check(f.lang, f.input, f.output);

      // 1) The embedded corruption MUST be rejected. A false negative here means
      //    Tidy would ship an HTML file whose embedded code/data/text silently
      //    changed meaning — the exact lonefy "breaks your files" failure.
      assert.equal(
        verdict.equivalent,
        false,
        `guard ACCEPTED an embedded corruption (${f.id}); false negative — meaning changed silently`
      );

      // 2) A rejection MUST carry a non-empty reason for the OutputChannel.
      assert.ok(
        typeof verdict.reason === 'string' && verdict.reason.length > 0,
        `rejection must include a non-empty reason (${f.id})`
      );

      // 3) The reason must never leak the source code (SPEC §9: "jamais le contenu").
      const reason = verdict.reason as string;
      assert.ok(!reason.includes('evil'), `reason leaked source (${f.id})`);
      assert.ok(!reason.includes('steal'), `reason leaked source (${f.id})`);
      assert.ok(!reason.includes('isAdmin'), `reason leaked source (${f.id})`);

      // 4) INDEPENDENT HTML ORACLE: the corrupted output is well-formed HTML, so a
      //    re-parse-only guard would have accepted it. This is what makes the
      //    rejection above non-trivial.
      assert.equal(
        htmlParses(f.output),
        f.htmlParses,
        `fixture ${f.id} declares htmlParses=${f.htmlParses} but parse5 ` +
          `${htmlParses(f.output) ? 'parsed' : 'did NOT parse'} the corrupted output`
      );

      // 5) INDEPENDENT EMBEDDED ORACLE (css/js/json only): the corrupted payload is
      //    also well-formed in its own language, so even a snippet-level re-parse
      //    guard would accept it — only the deep value diff catches the change.
      if (f.embeddedWellFormed !== undefined) {
        assert.equal(
          embeddedPayloadWellFormed(f),
          f.embeddedWellFormed,
          `fixture ${f.id} declares embeddedWellFormed=${f.embeddedWellFormed} but the ` +
            `isolated payload actually ${embeddedPayloadWellFormed(f) ? 'parses' : 'does NOT parse'}`
        );
      }
    });
  }
});

describe('adversarial polyglot — the two-layer parse-only trap (SPEC §5)', () => {
  // Prove the trap class is large: many embedded corruptions re-parse cleanly at
  // BOTH the HTML level and the embedded-snippet level, yet all must be rejected.
  const deepTrap = polyglotFixtures.filter(
    (f) => f.htmlParses && f.embeddedWellFormed === true
  );

  it('has many embedded corruptions that re-parse at both layers yet must be rejected', () => {
    assert.ok(
      deepTrap.length >= 12,
      `expected >= 12 doubly-parsing corruptions, found ${deepTrap.length}`
    );
  });

  for (const f of deepTrap) {
    it(`${f.id}: well-formed HTML + well-formed embedded payload, still rejected on value`, () => {
      assert.equal(htmlParses(f.output), true, `${f.id} output should parse as HTML`);
      assert.equal(embeddedPayloadWellFormed(f), true, `${f.id} payload should parse in its language`);
      const verdict = guard.check(f.lang, f.input, f.output);
      assert.equal(verdict.equivalent, false, `${f.id} must be rejected despite double parseability`);
    });
  }
});

describe('adversarial polyglot — false-positive guardrail (do NOT over-reject)', () => {
  // The embedded guard must stay sharp without becoming paranoid: a pure reindent
  // of the SAME embedded code/data must be ACCEPTED. If these fail, the guard has
  // collapsed into a blanket-rejector and the must-reject results above would be
  // meaningless (a guard that rejects everything trivially "passes"). This is the
  // SPEC §12 "faux positif de la garde" / "safe but does nothing" failure mode.
  it('accepts a pure reindent of embedded <style> (same CSS values)', () => {
    const v = guard.check(
      'html',
      '<head><style>.btn{color:red}</style></head>',
      '<head><style>\n  .btn {\n    color: red;\n  }\n</style></head>'
    );
    assert.equal(v.equivalent, true, v.reason);
  });

  it('accepts a pure reindent of embedded <script> (same JS instructions)', () => {
    const v = guard.check(
      'html',
      '<body><script>var a=1;</script></body>',
      '<body><script>\n  var a = 1;\n</script></body>'
    );
    assert.equal(v.equivalent, true, v.reason);
  });

  it('accepts reformatted <script type="application/json"> (same JSON value)', () => {
    const v = guard.check(
      'html',
      '<body><script type="application/json">{"a":1,"b":[1,2,3]}</script></body>',
      '<body><script type="application/json">\n{\n  "a": 1,\n  "b": [1, 2, 3]\n}\n</script></body>'
    );
    assert.equal(v.equivalent, true, v.reason);
  });

  it('accepts a JSON object key reorder in an embedded data script (order is not meaning)', () => {
    const v = guard.check(
      'html',
      '<body><script type="application/json">{"a":1,"b":2}</script></body>',
      '<body><script type="application/json">{"b":2,"a":1}</script></body>'
    );
    assert.equal(v.equivalent, true, v.reason);
  });
});

describe('adversarial polyglot — direct htmlTreeEqual spot-checks (one per surface)', () => {
  // Hit the exported htmlTreeEqual directly (not via guard.check) so the embedded
  // path is exercised even if guard.check ever gains a short-circuit.
  it('(a) <style> value change rejected', () => {
    assert.equal(
      htmlTreeEqual('<style>.x{color:red}</style>', '<style>.x{color:blue}</style>').equivalent,
      false
    );
  });
  it('(b) <script> instruction change rejected', () => {
    assert.equal(
      htmlTreeEqual('<script>var a=1;</script>', '<script>var a=2;</script>').equivalent,
      false
    );
  });
  it('(c) <script type=application/json> value change rejected', () => {
    assert.equal(
      htmlTreeEqual(
        '<script type="application/json">{"n":1}</script>',
        '<script type="application/json">{"n":2}</script>'
      ).equivalent,
      false
    );
  });
  it('(d) <pre> verbatim text change rejected', () => {
    assert.equal(htmlTreeEqual('<pre>old</pre>', '<pre>new</pre>').equivalent, false);
  });
  it('(e) inline onclick handler change rejected', () => {
    assert.equal(
      htmlTreeEqual('<button onclick="a()">x</button>', '<button onclick="b()">x</button>').equivalent,
      false
    );
  });
});
