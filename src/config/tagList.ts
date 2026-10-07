// Validation of the two user-supplied HTML tag lists: tidy.content_unformatted and
// tidy.void_elements.
//
// BOTH ARE ADDITIVE ONLY. The value a user writes is folded INTO the printer's
// built-in list (see src/engine/jsbeautify.ts), never substituted for it, and this
// module is where the value is made safe to fold:
//
//   - content_unformatted: the built-in list is the guard's own list of elements it
//     compares byte for byte (src/safety/htmlPreformatted.ts). A list that REMOVED
//     one (js-beautify's own default keeps only pre and textarea) makes the printer
//     reflow an <xmp> the guard then rejects (probe P16c), so removal is not offered.
//   - void_elements: dropping a standard void element (br, img, ...) would make the
//     printer expect a closing tag that never comes and mis-indent every sibling that
//     follows, so removal is not offered either.
//
// Entries are validated as TAG NAMES, not as free text. js-beautify builds a
// RegExp from the tag name it reads in the document and looks that name up in
// these lists, so an entry such as "a(" or "x+" is not a harmless typo: it is a
// pattern that throws or backtracks when the printer meets it. Only
// [a-z][a-z0-9_-]* is accepted, which contains no regular-expression syntax.
//
// Invalid entries are DROPPED, never fatal, and each one yields a sentence the
// "Show Effective Configuration" report prints (the rest of the list still
// applies). PURE: no I/O, no 'vscode'.
import { HTML_PREFORMATTED_TAG_SET } from '../safety/htmlPreformatted';

/** The two catalogue engine keys that carry a tag list. */
export type TagListKind = 'content_unformatted' | 'void_elements';

/** Whether an engine key names one of the tag-list options. */
export function isTagListKind(engineKey: string): engineKey is TagListKind {
  return engineKey === 'content_unformatted' || engineKey === 'void_elements';
}

/** Longest tag name accepted (HTML has none; 64 covers any real custom element). */
export const MAX_TAG_NAME_LENGTH = 64;

/** Most tag names taken from one list; the rest are ignored and reported. */
export const MAX_TAG_LIST_ENTRIES = 128;

/** Longest raw entry echoed back in a warning. */
const MAX_ECHO = 40;

/** A tag name: a letter, then letters, digits, hyphens or underscores. */
const TAG_NAME = /^[a-z][a-z0-9_-]*$/;

/**
 * Elements that can never be printed as void elements, because the printer (or the
 * guard) treats what sits between their tags as verbatim text:
 *  - the guard's preformatted set (pre, textarea, xmp, listing, plaintext), imported
 *    rather than copied so the two lists cannot drift;
 *  - script and style, whose bodies js-beautify reads as raw text.
 */
const NEVER_VOID: ReadonlySet<string> = new Set<string>([
  ...HTML_PREFORMATTED_TAG_SET,
  'script',
  'style'
]);

/** The outcome of validating one list. */
export interface TagListResult {
  /** Accepted names: lower-case, de-duplicated, in the order written. */
  readonly tags: readonly string[];
  /** One sentence per ignored entry (empty when the list is clean or unset). */
  readonly problems: readonly string[];
}

const EMPTY: TagListResult = { tags: [], problems: [] };

/** A bounded, single-line rendering of a rejected entry for a warning. */
function echo(entry: unknown): string {
  let text: string;
  try {
    text = typeof entry === 'string' ? JSON.stringify(entry) : (JSON.stringify(entry) ?? String(entry));
  } catch {
    text = '[unserializable]';
  }
  return text.length > MAX_ECHO ? `${text.slice(0, MAX_ECHO)}...` : text;
}

/**
 * Validate a raw list value for one of the two options.
 *
 * `undefined` and `null` mean "not set" and yield nothing, silently. Anything else
 * that is not an array is reported once. Each array entry must be a string that,
 * trimmed and lower-cased, is a tag name; for void_elements it must also not be an
 * element whose content is verbatim. Duplicates collapse silently, because two
 * spellings of one tag are harmless, not wrong.
 */
export function sanitizeTagList(kind: TagListKind, raw: unknown): TagListResult {
  // The setting the user wrote, so a warning names what to fix.
  const label = `tidy.${kind}`;
  if (raw === undefined || raw === null) {
    return EMPTY;
  }
  if (!Array.isArray(raw)) {
    return { tags: [], problems: [`${label}: expected a list of tag names, got ${echo(raw)}; ignored.`] };
  }

  const tags: string[] = [];
  const seen = new Set<string>();
  const problems: string[] = [];
  let overflow = 0;

  for (const entry of raw as readonly unknown[]) {
    if (typeof entry !== 'string') {
      problems.push(`${label}: entry ${echo(entry)} is not a string; ignored.`);
      continue;
    }
    const name = entry.trim().toLowerCase();
    if (name.length > MAX_TAG_NAME_LENGTH || !TAG_NAME.test(name)) {
      problems.push(
        `${label}: entry ${echo(entry)} is not a valid tag name (a letter, then letters, digits, hyphens or underscores); ignored.`
      );
      continue;
    }
    if (kind === 'void_elements' && NEVER_VOID.has(name)) {
      problems.push(
        `${label}: "${name}" holds text that must stay exactly as written, so it cannot be a void element; ignored.`
      );
      continue;
    }
    if (seen.has(name)) {
      continue;
    }
    if (tags.length >= MAX_TAG_LIST_ENTRIES) {
      overflow += 1;
      continue;
    }
    seen.add(name);
    tags.push(name);
  }

  if (overflow > 0) {
    problems.push(
      `${label}: only the first ${MAX_TAG_LIST_ENTRIES} tag names are used; ${overflow} more ignored.`
    );
  }
  return { tags, problems };
}
