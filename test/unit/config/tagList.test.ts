// The tag-list validator behind tidy.content_unformatted and tidy.void_elements.
//
// Two jobs, both safety-shaped:
//   - a user entry is only ever a TAG NAME, because js-beautify turns the tag names
//     of the document into a RegExp and looks them up in these lists; an entry with
//     regular-expression syntax would throw or backtrack when the printer met it;
//   - the lists are additive, so nothing here may ever be able to remove a built-in:
//     the validator only ever returns names to ADD, and refuses the elements whose
//     text the guard compares verbatim from the void list.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_TAG_LIST_ENTRIES,
  MAX_TAG_NAME_LENGTH,
  isTagListKind,
  sanitizeTagList
} from '../../../src/config/tagList';
import { HTML_PREFORMATTED_TAGS } from '../../../src/safety/htmlPreformatted';

const EM_DASH = String.fromCharCode(0x2014);

describe('config/tagList : valid entries', () => {
  it('keeps plain and custom-element names, lower-cased, trimmed and de-duplicated, in order', () => {
    const { tags, problems } = sanitizeTagList('content_unformatted', [
      'code',
      ' My-Icon ',
      'CODE',
      'x_y',
      'h1',
      'my-icon'
    ]);
    assert.deepEqual(tags, ['code', 'my-icon', 'x_y', 'h1']);
    assert.deepEqual(problems, [], 'a duplicate is harmless, not a problem');
  });

  it('treats undefined and null as "not set": nothing, and no warning', () => {
    for (const raw of [undefined, null]) {
      for (const kind of ['content_unformatted', 'void_elements'] as const) {
        assert.deepEqual(sanitizeTagList(kind, raw), { tags: [], problems: [] });
      }
    }
  });

  it('an empty list is a valid list of nothing', () => {
    assert.deepEqual(sanitizeTagList('void_elements', []), { tags: [], problems: [] });
  });

  it('recognises exactly the two tag-list engine keys', () => {
    assert.equal(isTagListKind('content_unformatted'), true);
    assert.equal(isTagListKind('void_elements'), true);
    assert.equal(isTagListKind('brace_style'), false);
    assert.equal(isTagListKind(''), false);
  });
});

describe('config/tagList : invalid entries are dropped, reported, and never cost the rest', () => {
  const BAD = [
    '',
    ' ',
    'a b',
    '<code>',
    '</code>',
    'a.b',
    'a(',
    '(',
    '[',
    '\\',
    'x+',
    'x*',
    'a|b',
    '^a',
    'a$',
    '{1}',
    '1abc',
    '-x',
    '_x',
    'é',
    'a/b',
    'a:b',
    '!doctype',
    '?xml',
    'a\nb',
    'a\u0000b'
  ];

  for (const bad of BAD) {
    it(`drops ${JSON.stringify(bad)} with one sentence and keeps "code"`, () => {
      const { tags, problems } = sanitizeTagList('content_unformatted', [bad, 'code']);
      assert.deepEqual(tags, ['code']);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /^tidy\.content_unformatted: entry /);
      assert.match(problems[0], /ignored\.$/);
    });
  }

  it('drops a name longer than the cap', () => {
    const tooLong = 'a'.repeat(MAX_TAG_NAME_LENGTH + 1);
    const atCap = 'a'.repeat(MAX_TAG_NAME_LENGTH);
    const { tags, problems } = sanitizeTagList('void_elements', [tooLong, atCap]);
    assert.deepEqual(tags, [atCap]);
    assert.equal(problems.length, 1);
  });

  it('drops an entry that is not a string', () => {
    const { tags, problems } = sanitizeTagList('void_elements', [5, null, {}, ['x'], true, 'ok']);
    assert.deepEqual(tags, ['ok']);
    assert.equal(problems.length, 5);
    assert.ok(problems.every((p) => /is not a string/.test(p)));
  });

  it('reports a value that is not a list, once, and uses nothing', () => {
    for (const raw of ['code', 7, true, { code: 1 }]) {
      const { tags, problems } = sanitizeTagList('content_unformatted', raw);
      assert.deepEqual(tags, []);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /expected a list of tag names/);
    }
  });

  it('names the setting the user has to fix', () => {
    assert.match(sanitizeTagList('void_elements', ['a b']).problems[0], /^tidy\.void_elements:/);
    assert.match(sanitizeTagList('content_unformatted', ['a b']).problems[0], /^tidy\.content_unformatted:/);
  });

  it('keeps every warning one bounded line, whatever the entry holds', () => {
    const hostile = `x\n${'y'.repeat(10_000)}\r\n${'z'.repeat(10_000)}`;
    const { problems } = sanitizeTagList('content_unformatted', [hostile]);
    assert.equal(problems.length, 1);
    assert.ok(problems[0].length < 300, `warning is ${problems[0].length} characters`);
    assert.ok(!/[\r\n]/.test(problems[0]), 'no raw line break leaks into the report');
  });

  it('never writes an em dash', () => {
    const all = [
      ...sanitizeTagList('content_unformatted', ['a b', 5]).problems,
      ...sanitizeTagList('void_elements', ['pre', 'a b']).problems,
      ...sanitizeTagList('void_elements', 'x').problems
    ];
    assert.ok(all.length > 0);
    assert.ok(all.every((p) => !p.includes(EM_DASH)));
  });
});

describe('config/tagList : void_elements refuses what holds verbatim text', () => {
  const VERBATIM = [...HTML_PREFORMATTED_TAGS, 'script', 'style'];

  for (const tag of VERBATIM) {
    it(`refuses <${tag}> as a void element`, () => {
      const { tags, problems } = sanitizeTagList('void_elements', [tag, 'my-icon']);
      assert.deepEqual(tags, ['my-icon']);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /cannot be a void element/);
    });
  }

  it('refuses them whatever the case', () => {
    assert.deepEqual(sanitizeTagList('void_elements', ['PRE', 'Script']).tags, []);
  });

  it('the preformatted set is the guard\'s own list, imported and not copied', () => {
    // If the guard ever learns a sixth verbatim element, void_elements must refuse it
    // too without anyone editing this module. A copy would drift; an import cannot.
    for (const tag of HTML_PREFORMATTED_TAGS) {
      assert.deepEqual(sanitizeTagList('void_elements', [tag]).tags, []);
    }
    const source = readFileSync(
      join(__dirname, '..', '..', '..', 'src', 'config', 'tagList.ts'),
      'utf8'
    );
    assert.match(source, /from '\.\.\/safety\/htmlPreformatted'/);
    for (const tag of HTML_PREFORMATTED_TAGS) {
      assert.ok(!source.includes(`'${tag}'`), `tagList.ts must not spell '${tag}' itself`);
    }
  });

  it('accepts the same elements for content_unformatted (redundant, never harmful)', () => {
    for (const tag of VERBATIM) {
      assert.deepEqual(sanitizeTagList('content_unformatted', [tag]).tags, [tag]);
    }
  });
});

describe('config/tagList : the cap', () => {
  it('takes the first MAX_TAG_LIST_ENTRIES valid names and reports how many it ignored', () => {
    const raw = Array.from({ length: MAX_TAG_LIST_ENTRIES + 5 }, (_, i) => `t${i}`);
    const { tags, problems } = sanitizeTagList('content_unformatted', raw);
    assert.equal(tags.length, MAX_TAG_LIST_ENTRIES);
    assert.equal(tags[0], 't0');
    assert.equal(problems.length, 1);
    assert.match(problems[0], new RegExp(`only the first ${MAX_TAG_LIST_ENTRIES} tag names are used; 5 more ignored`));
  });

  it('counts duplicates and invalid entries against nothing', () => {
    const raw = [
      ...Array.from({ length: MAX_TAG_LIST_ENTRIES }, (_, i) => `t${i}`),
      ...Array.from({ length: 50 }, () => 't0')
    ];
    const { tags, problems } = sanitizeTagList('content_unformatted', raw);
    assert.equal(tags.length, MAX_TAG_LIST_ENTRIES);
    assert.deepEqual(problems, []);
  });
});

describe('config/tagList : what it accepts is safe to embed in a RegExp', () => {
  // js-beautify builds new RegExp('</' + tag + '[\\n\\r\\t ]*?>') from document tag
  // names that are found in these lists. Exhaustively try every string over a small
  // alphabet that is rich in regular-expression syntax: whatever the validator lets
  // through must compile, and must match itself literally and nothing else.
  const ALPHABET = ['a', 'b', '1', '-', '_', '.', '(', ')', '[', ']', '*', '+', '?', '|', '^', '$', '\\', '{', '}', ' ', '/', '<', '>'];

  function* strings(maxLength: number): Generator<string> {
    let frontier = [''];
    yield '';
    for (let length = 1; length <= maxLength; length += 1) {
      const next: string[] = [];
      for (const prefix of frontier) {
        for (const ch of ALPHABET) {
          const s = prefix + ch;
          next.push(s);
          yield s;
        }
      }
      frontier = next;
    }
  }

  it('every accepted name compiles and matches exactly its own closing tag', () => {
    let accepted = 0;
    let examined = 0;
    for (const candidate of strings(4)) {
      examined += 1;
      const { tags } = sanitizeTagList('content_unformatted', [candidate]);
      for (const tag of tags) {
        accepted += 1;
        let re: RegExp | undefined;
        assert.doesNotThrow(() => {
          re = new RegExp(`</${tag}[\\n\\r\\t ]*?>`, 'ig');
        }, `${JSON.stringify(tag)} must be a safe pattern`);
        assert.ok(re!.test(`</${tag}>`), `${tag} matches its own closing tag`);
        assert.equal(re!.source, `<\\/${tag}[\\n\\r\\t ]*?>`, 'no metacharacter survived');
      }
    }
    assert.ok(examined > 100_000, `examined only ${examined} candidates`);
    assert.ok(accepted > 0);
  });
});
