// The ONE list of HTML elements whose text content is rendered verbatim.
//
// Two consumers must agree on it, and a disagreement between them is a proven
// false accept, not a style nit:
//   - src/safety/guard.ts compares the text inside these elements BYTE FOR BYTE
//     (every space, tab and newline is rendered, so any reflow is a content
//     change);
//   - src/engine/jsbeautify.ts hands the same list to js-beautify as
//     `content_unformatted`, so the printer never reflows inside them.
// When the two lists drifted apart (the guard knew only pre/textarea while
// js-beautify reflowed xmp/listing/plaintext), a TAB inside <xmp> was rewritten
// as four spaces, the rendered text changed, and the guard said "equivalent".
// Hence a single module: neither side can be widened without the other.
//
// The membership rule is the HTML Rendering spec, not our engine's habits: an
// element belongs here when the spec's default style sheet renders it with
// `white-space: pre` or `pre-wrap`, because that is what makes its whitespace
// visible to a reader.
//
//   pre, xmp, plaintext, listing   `white-space: pre`      (spec 15.3.3,
//                                                           "Flow content")
//   textarea                       `white-space: pre-wrap` (spec 15.5.3,
//                                                           "Form controls")
//
// `nobr` and `[nowrap]` are deliberately absent: `white-space: nowrap` collapses
// runs of whitespace exactly like normal text, it only forbids line BREAKING, so
// a reflow there is invisible to a reader and must not be rejected.
//
// PURE: no imports at all, so both the guard and the engine can hold it without
// pulling anything into either side's bundle.

/**
 * Lower-case tag names the HTML Rendering spec renders as preformatted.
 * Sorted so the value read by a human, by js-beautify and by a test is stable.
 */
export const HTML_PREFORMATTED_TAGS: readonly string[] = Object.freeze([
  'listing',
  'plaintext',
  'pre',
  'textarea',
  'xmp'
]);

/** Membership test form of {@link HTML_PREFORMATTED_TAGS}. */
export const HTML_PREFORMATTED_TAG_SET: ReadonlySet<string> = new Set(
  HTML_PREFORMATTED_TAGS
);

/**
 * A fresh, mutable copy for callers that hand the list to a library typed with
 * `string[]` (js-beautify's `content_unformatted`). Copying keeps the exported
 * constant unreachable from a library that might sort or push into what it gets.
 */
export function htmlPreformattedTags(): string[] {
  return [...HTML_PREFORMATTED_TAGS];
}
