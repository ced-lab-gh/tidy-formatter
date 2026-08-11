// Regression corpus for the CSS/SCSS/LESS fallback pipeline (ADD-01), derived
// from the incumbent's mined issue tracker (issue number + title only). Each
// entry is a REAL stylesheet file in this directory plus the EXPECTED final
// status of the full pipeline (js-beautify -> guard -> postcss fallback ->
// guard). The runner (test/unit/engine/cssFallback.corpus.test.ts) locks these
// statuses so that:
//  - a guard change can never silently push part of the family back into a
//    permanent no-op (an 'applied-*' turning 'guard-rejected' fails the suite);
//  - the fallback can never apply anything the guard did not verify (a
//    'guard-rejected' turning 'applied-*' also fails the suite and must be a
//    conscious manifest update).
//
// Files here are READ-ONLY unit fixtures: no test ever writes into this
// directory (throwaway integration workspaces are the writable ones).
//
// STATUS BASELINE. The expectations below were measured against the guard as it
// ships today (v0.2.2 + the v0.3.0 first wave). Three SCSS entries
// (CSSFB-INCLUDE-KWARGS, CSSFB-MIXIN-DEFAULT, CSSFB-FUNCTION-DEFAULT) are
// currently 'guard-rejected' by BOTH engines: the guard compares the ':' spacing
// inside an at-rule params span verbatim, and every engine spaces a
// '$var:value' binding. Unlocking them needs a bounded guard change (an at-rule
// params normalisation for '$var:' only) that is deliberately NOT part of this
// lot. They are locked as 'guard-rejected' so the day that change lands, this
// suite fails loudly and the manifest must be updated on purpose.
import type { LangId } from '../../../src/types';

export type CorpusExpectation =
  | 'applied-jsbeautify' // first candidate accepted by the guard
  | 'applied-fallback' // js-beautify rejected, postcss candidate accepted
  | 'guard-rejected'; // both candidates rejected: deliberate safe no-op

export interface CssCorpusEntry {
  /** Stable id used in the test title. */
  id: string;
  /** File name inside test/fixtures/css-sass/. */
  file: string;
  lang: LangId;
  /** Mined evidence (incumbent issue number and title, or cluster name). */
  ref: string;
  desc: string;
  expected: CorpusExpectation;
}

export const cssCorpus: readonly CssCorpusEntry[] = [
  {
    id: 'CSSFB-77-AMP-PSEUDO',
    file: 'issue-77-amp-pseudo.scss',
    lang: 'scss',
    ref: '#77 "Unnecessary space before pseudo-class in SASS"',
    desc: 'SCSS &:hover / &:before must format without a space creeping in',
    expected: 'applied-jsbeautify'
  },
  {
    id: 'CSSFB-17-NOT-NTH',
    file: 'issue-17-not-nth.css',
    lang: 'css',
    ref: '#17 "css with not and nth-child"',
    desc: ':not() chained with :nth-child() formats and stays glued',
    expected: 'applied-jsbeautify'
  },
  {
    id: 'CSSFB-74-CALC-INTERP',
    file: 'issue-74-calc-interp.scss',
    lang: 'scss',
    ref: '#74 "SASS interpolation breaks CSS calc() statement"',
    desc: 'calc() containing #{...} interpolation survives formatting',
    expected: 'applied-jsbeautify'
  },
  {
    id: 'CSSFB-47-PROGID',
    file: 'issue-47-progid.scss',
    lang: 'scss',
    ref: '#47 "SCSS: IE specific filter with progid: should not be spaced"',
    desc: 'progid: value keeps its inner colon unspaced',
    expected: 'applied-jsbeautify'
  },
  {
    id: 'CSSFB-78-COMMA-STRINGS',
    file: 'issue-78-comma-strings.scss',
    lang: 'scss',
    ref: '#78 "New line between comma-separated strings in SASS"',
    desc: 'comma-separated string list formats without losing a quote',
    expected: 'applied-jsbeautify'
  },
  {
    id: 'CSSFB-67-COMBINATORS',
    file: 'issue-67-combinators.css',
    lang: 'css',
    ref: '#67 "Spaces between css selectors"',
    desc: 'child and descendant combinators keep their meaning',
    expected: 'applied-jsbeautify'
  },
  {
    id: 'CSSFB-138-INLINE-COMMENT',
    file: 'issue-138-inline-comment.scss',
    lang: 'scss',
    ref: '#138 "automatically added new line after comments"',
    desc: 'inline comment between declarations survives formatting',
    expected: 'applied-jsbeautify'
  },
  {
    id: 'CSSFB-21-COLON-BRACKETS',
    file: 'issue-21-colon-brackets.css',
    lang: 'css',
    ref: '#21 "Add an extra space if colon used in brackets"',
    desc: 'colon inside attribute-selector strings stays verbatim',
    expected: 'applied-jsbeautify'
  },
  {
    id: 'CSSFB-INCLUDE-KWARGS',
    file: 'scss-include-kwargs.scss',
    lang: 'scss',
    ref: 'colon cluster (#21/#47/#77): @include keyword arguments',
    desc: '@include m($size:10px,$c:red) is a residual no-op: both engines space the binding colon and the guard compares at-rule params verbatim',
    expected: 'guard-rejected'
  },
  {
    id: 'CSSFB-MIXIN-DEFAULT',
    file: 'scss-mixin-default.scss',
    lang: 'scss',
    ref: 'colon cluster (#21/#47/#77): @mixin default value',
    desc: '@mixin m($size:10px) is a residual no-op for the same at-rule params reason',
    expected: 'guard-rejected'
  },
  {
    id: 'CSSFB-FUNCTION-DEFAULT',
    file: 'scss-function-default.scss',
    lang: 'scss',
    ref: 'colon cluster (#21/#47/#77): @function default value',
    desc: '@function f($x:1) is a residual no-op for the same at-rule params reason',
    expected: 'guard-rejected'
  },
  {
    id: 'CSSFB-LESS-MIXIN-DEFAULT',
    file: 'less-mixin-default.less',
    lang: 'less',
    ref: 'colon cluster, LESS side: parametric mixin default value',
    desc: '.m(@c:red) is rescued by the postcss fallback (js-beautify spaces the selector colon, prettier preserves it)',
    expected: 'applied-fallback'
  },
  {
    id: 'CSSFB-LESS-ESCAPE',
    file: 'less-escape.less',
    lang: 'less',
    ref: 'LESS ~"..." escape: documented residual no-op',
    desc: 'both candidates are rejected today; locked as a deliberate safe no-op so any future guard widening shows up here first',
    expected: 'guard-rejected'
  },
  {
    id: 'CSSFB-MEDIA-COMPACT',
    file: 'media-compact.css',
    lang: 'css',
    ref: 'compact media feature (regression tripwire)',
    desc: '@media (min-width:600px) formats via js-beautify; locks that the primary path never regresses into needing the fallback here',
    expected: 'applied-jsbeautify'
  },
  {
    id: 'CSSFB-GRID-MINMAX',
    file: 'grid-minmax.css',
    lang: 'css',
    ref: 'nested functions repeat(auto-fill,minmax(...)) (regression tripwire)',
    desc: 'nested function arguments format via js-beautify',
    expected: 'applied-jsbeautify'
  }
];
