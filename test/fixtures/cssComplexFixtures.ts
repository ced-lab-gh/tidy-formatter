// Complex CSS / SCSS / LESS corpus for the safety guard (SPEC SAFE-02/03,
// ENG-05). Two disjoint property sets:
//
//  - acceptFixtures: real-world, non-trivial stylesheets (native nesting,
//    @media/@supports/@container, custom properties, nested calc(), multi-line
//    grid templates, :is()/:where()/:nth-child(an+b), pseudo-elements, SCSS
//    mixins/@include/@extend/@if/@each/maps/interpolation, LESS variables +
//    parametric mixins, comments, @font-face, @keyframes). Each is run through
//    the REAL dispatcher (js-beautify) and the guard MUST report `equivalent`
//    AND the second pass MUST be a byte-for-byte no-op (idempotence). These
//    guard against the "safe but does nothing" false positive on advanced CSS.
//
//  - rejectFixtures: adversarial corruptions injected directly as the
//    formatter "output". Each changes meaning (a value, an operator, an nth
//    coefficient, an interpolation token, a dropped declaration, a changed
//    media query, ...) and the guard MUST reject it via cssTreeEqual. These are
//    the security core: the guard must NEVER let a meaning-changing output pass.
//
// Historical lonefy edge cases are tagged in `ref` (#78 comma-values, #77
// pseudo-class spacing / @extend, #74 calc interpolation, #67 combinator,
// #17 :not/:nth-child).
import type { LangId } from '../../src/types';

export interface CssAcceptFixture {
  id: string;
  desc: string;
  ref: string;
  lang: LangId;
  /** Messy but valid input; formatted via the real engine, then guard-checked. */
  input: string;
}

export interface CssRejectFixture {
  id: string;
  desc: string;
  ref: string;
  lang: LangId;
  /** Valid input. */
  input: string;
  /** A corrupting "formatted output" the guard MUST reject. */
  output: string;
}

// ---------------------------------------------------------------------------
// ACCEPT: complex but legitimate. dispatchFormat(input) must be guard-equivalent
// to input AND idempotent.
// ---------------------------------------------------------------------------
export const cssAcceptFixtures: CssAcceptFixture[] = [
  // ---- CSS ----
  {
    id: 'CPLX-CSS-NATIVE-NESTING',
    desc: 'native CSS nesting with &, descendant, and &:hover',
    ref: 'SAFE-02; CSS Nesting Module L1',
    lang: 'css',
    input: '.card{color:red;& .title{font-weight:bold}&:hover{color:blue}}'
  },
  {
    id: 'CPLX-CSS-MEDIA-AND',
    desc: '@media with combined min/max-width features',
    ref: 'SAFE-02; @media',
    lang: 'css',
    input: '@media (min-width:600px) and (max-width:900px){.a{display:grid}}'
  },
  {
    id: 'CPLX-CSS-SUPPORTS',
    desc: '@supports feature query with and()',
    ref: 'SAFE-02; @supports',
    lang: 'css',
    input: '@supports (display:grid) and (gap:1rem){.a{display:grid;gap:1rem}}'
  },
  {
    id: 'CPLX-CSS-CONTAINER',
    desc: '@container query with named container',
    ref: 'SAFE-02; CSS Containment L3',
    lang: 'css',
    input: '@container sidebar (min-width:400px){.card{display:flex}}'
  },
  {
    id: 'CPLX-CSS-CUSTOM-PROPS',
    desc: 'custom properties on :root and var() with fallback',
    ref: 'SAFE-02; CSS Custom Properties',
    lang: 'css',
    input: ':root{--main-color:#333;--gap:1rem}.a{color:var(--main-color);margin:var(--gap,2rem)}'
  },
  {
    id: 'CPLX-CSS-CALC-NESTED',
    desc: 'nested calc() mixing var(), %, *, /, and parenthesised subexpression',
    ref: '#74 calc interpolation; SAFE-02',
    lang: 'css',
    input: '.a{width:calc(100% - calc(2 * var(--gap)));height:calc((100vh - 2rem) / 3)}'
  },
  {
    id: 'CPLX-CSS-GRID-MULTILINE',
    desc: 'grid-template across multiple lines with area strings and track sizes',
    ref: 'SAFE-02; CSS Grid',
    lang: 'css',
    input: '.grid{grid-template:\n  "header header" auto\n  "nav main" 1fr\n  / 200px 1fr}'
  },
  {
    id: 'CPLX-CSS-IS-WHERE',
    desc: ':is()/:where() with selector lists',
    ref: 'SAFE-02; Selectors L4',
    lang: 'css',
    input: ':is(h1, h2, h3):where(.title){margin:0}'
  },
  {
    id: 'CPLX-CSS-NTH-ANB',
    desc: ':nth-child(an+b) variants (3n+1, -n+3, odd, of-type)',
    ref: '#77/#78 selector spacing; SAFE-02',
    lang: 'css',
    input: 'li:nth-child(3n+1){color:red}li:nth-child(-n+3){color:blue}li:nth-of-type(odd){color:green}'
  },
  {
    id: 'CPLX-CSS-PSEUDO-ELEMENTS',
    desc: 'pseudo-elements ::before/::after with content incl. escaped unicode',
    ref: 'SAFE-02; pseudo-elements',
    lang: 'css',
    input: '.a::before{content:""}.b::after{content:"\\2014"}'
  },
  {
    id: 'CPLX-CSS-COMMA-TRANSITION',
    desc: 'comma-separated multi-value transition (historical comma-value ruination)',
    ref: '#78 comma-values; ENG-05',
    lang: 'css',
    input: '.a{transition:color .2s ease,background-color .3s ease-in-out,transform .1s linear}'
  },
  {
    id: 'CPLX-CSS-FONT-FAMILY-COMMA',
    desc: 'font shorthand + comma font-family stack',
    ref: '#78 comma-values; review 126',
    lang: 'css',
    input: '.a{font:italic bold 14px/1.5 "Helvetica Neue",Helvetica,Arial,sans-serif}'
  },
  {
    id: 'CPLX-CSS-GRID-REPEAT',
    desc: 'grid-template-columns repeat()/minmax() and two-value gap',
    ref: 'SAFE-02; CSS Grid functions',
    lang: 'css',
    input: '.g{grid-template-columns:repeat(3, minmax(0, 1fr));gap:1rem 2rem}'
  },
  {
    id: 'CPLX-CSS-BOX-SHADOW',
    desc: 'multiple comma-separated box-shadows with rgba()',
    ref: '#78 comma-values',
    lang: 'css',
    input: '.a{box-shadow:0 1px 2px rgba(0,0,0,.1),0 2px 4px rgba(0,0,0,.2)}'
  },
  {
    id: 'CPLX-CSS-PSEUDO-CLASS-CHAIN',
    desc: 'chained pseudo-classes a:not(.active):hover (historical pseudo-class spacing)',
    ref: '#77 pseudo-class space; #17 :not',
    lang: 'css',
    input: 'a:not(.active):hover{color:red}'
  },
  {
    id: 'CPLX-CSS-ATTR-SELECTORS',
    desc: 'attribute selectors with ^= operator and quoted values',
    ref: 'SAFE-02; attribute selectors',
    lang: 'css',
    input: 'input[type="text"], a[href^="https"]{color:red}'
  },
  {
    id: 'CPLX-CSS-COMBINATORS',
    desc: 'child/sibling combinators (>, +, ~) — js-beautify tightens whitespace (false-positive guard)',
    ref: '#67 combinator false-positive',
    lang: 'css',
    input: '.menu > .item + .item ~ .last{color:red}'
  },
  {
    id: 'CPLX-CSS-COMMENT',
    desc: 'block comments between rules and declarations preserved',
    ref: 'SAFE-02; comments are style',
    lang: 'css',
    input: '/* header */\n.a{color:red /* inline */;margin:0}\n/* footer */'
  },

  // ---- SCSS ----
  {
    id: 'CPLX-SCSS-MIXIN-INCLUDE',
    desc: '@mixin with default arg + @include with explicit arg',
    ref: 'SAFE-02; SCSS mixins',
    lang: 'scss',
    input: '@mixin flex($dir: row){display:flex;flex-direction:$dir}.a{@include flex(column)}'
  },
  {
    id: 'CPLX-SCSS-EXTEND-PLACEHOLDER',
    desc: '%placeholder + @extend %placeholder',
    ref: '#77 @extend; SCSS placeholders',
    lang: 'scss',
    input: '%base{padding:1rem}.box{@extend %base;color:red}'
  },
  {
    id: 'CPLX-SCSS-EXTEND-PSEUDO',
    desc: '@extend a:hover (the exact historical pseudo-class @extend case)',
    ref: '#77 "@extend a: hover"',
    lang: 'scss',
    input: '.hoverlink{@extend a:hover}'
  },
  {
    id: 'CPLX-SCSS-IF-ELSE',
    desc: '@if/@else control flow inside a mixin',
    ref: 'SAFE-02; SCSS control flow',
    lang: 'scss',
    input: '@mixin theme($dark){@if $dark{background:black}@else{background:white}}'
  },
  {
    id: 'CPLX-SCSS-EACH',
    desc: '@each over a list of key/value pairs with interpolation',
    ref: 'SAFE-02; SCSS @each + interpolation',
    lang: 'scss',
    input: '@each $name, $glyph in (a: 1, b: 2){.icon-#{$name}{content:$glyph}}'
  },
  {
    id: 'CPLX-SCSS-INTERPOLATION',
    desc: 'interpolation #{$x} in selector, value, and string',
    ref: 'SAFE-02; SCSS interpolation',
    lang: 'scss',
    input: '.a-#{$x}{width:#{$w}px;content:"#{$msg}"}'
  },
  {
    id: 'CPLX-SCSS-MAP',
    desc: 'SCSS map literal with multiple key/value pairs',
    ref: 'SAFE-02; SCSS maps',
    lang: 'scss',
    input: '$breakpoints: (small: 576px, medium: 768px, large: 992px);'
  },
  {
    id: 'CPLX-SCSS-NESTED-MEDIA',
    desc: '@media nested inside a rule (SCSS bubbling)',
    ref: 'SAFE-02; SCSS nested @media',
    lang: 'scss',
    input: '.a{color:red;@media (min-width:600px){color:blue}}'
  },
  {
    id: 'CPLX-SCSS-FUNCTION',
    desc: '@function with @return and call site',
    ref: 'SAFE-02; SCSS functions',
    lang: 'scss',
    input: '@function double($n){@return $n * 2}.a{width:double(5px)}'
  },
  {
    id: 'CPLX-SCSS-COMMENTS-MIXED',
    desc: 'SCSS // line comment and /* block */ comment together',
    ref: 'SAFE-02; SCSS comments',
    lang: 'scss',
    input: '// line comment\n.a{color:red;/* block */}'
  },
  {
    id: 'CPLX-SCSS-BEM-NESTING',
    desc: 'deep BEM nesting with &__element and &--modifier',
    ref: 'SAFE-02; SCSS &-nesting',
    lang: 'scss',
    input: '.menu{&__item{color:red;&--active{color:blue}}}'
  },
  {
    id: 'CPLX-SCSS-FOR',
    desc: '@for loop with interpolation and arithmetic',
    ref: 'SAFE-02; SCSS @for',
    lang: 'scss',
    input: '@for $i from 1 through 3{.col-#{$i}{width:$i * 10%}}'
  },

  // ---- LESS ----
  {
    id: 'CPLX-LESS-VARS',
    desc: 'LESS @variables used in declarations',
    ref: 'SAFE-02; LESS variables',
    lang: 'less',
    input: '@color: #333;@margin: 1rem;.a{color:@color;margin:@margin}'
  },
  {
    id: 'CPLX-LESS-PARAM-MIXIN',
    desc: 'LESS parametric mixin .m(@arg) with default + call site',
    ref: 'SAFE-02; LESS mixins',
    lang: 'less',
    input: '.bordered(@width: 1px){border:@width solid black}.a{.bordered(2px)}'
  },
  {
    id: 'CPLX-LESS-NESTED',
    desc: 'LESS nested rules with & parent reference',
    ref: 'SAFE-02; LESS nesting',
    lang: 'less',
    input: '.a{.b{color:red}&:hover{color:blue}}'
  },
  {
    id: 'CPLX-LESS-OPERATIONS',
    desc: 'LESS arithmetic operations in values',
    ref: 'SAFE-02; LESS operations',
    lang: 'less',
    input: '@base: 5px;.a{width:@base * 2;padding:@base + 10px}'
  },
  {
    id: 'CPLX-LESS-GUARD',
    desc: 'LESS mixin guard (when clause)',
    ref: 'SAFE-02; LESS guards',
    lang: 'less',
    input: '.m(@x) when (@x > 0){width:@x}'
  },
  {
    id: 'CPLX-LESS-ESCAPING',
    desc: 'LESS escaping ~"..." to emit a literal calc()',
    ref: '#74 calc; LESS escaping',
    lang: 'less',
    input: '.a{width:~"calc(100% - 30px)"}'
  },
  {
    id: 'CPLX-LESS-SELECTOR-INTERP',
    desc: 'LESS selector interpolation .@{var}',
    ref: 'SAFE-02; LESS interpolation',
    lang: 'less',
    input: '@my-selector: banner;.@{my-selector}{font-weight:bold}'
  }
];

// ---------------------------------------------------------------------------
// REJECT: adversarial corruptions. cssTreeEqual(input, output) MUST be
// non-equivalent (the guard refuses to apply; the file stays intact upstream).
// ---------------------------------------------------------------------------
export const cssRejectFixtures: CssRejectFixture[] = [
  // ---- CSS ----
  {
    id: 'CPLX-REJ-CALC-OP',
    desc: 'calc() operator flipped - to + changes the computed value',
    ref: '#74 calc; SAFE-02',
    lang: 'css',
    input: '.a{width:calc(100% - 30px)}',
    output: '.a{width:calc(100% + 30px)}'
  },
  {
    id: 'CPLX-REJ-CALC-MINUS-GLUED',
    desc: 'whitespace dropped before -30px (calc requires space around -), meaning changes',
    ref: '#74 calc whitespace; SAFE-02',
    lang: 'css',
    input: '.a{width:calc(100% - 30px)}',
    output: '.a{width:calc(100% -30px)}'
  },
  {
    id: 'CPLX-REJ-VAR-FALLBACK',
    desc: 'var() fallback value silently changed',
    ref: 'SAFE-02; custom properties',
    lang: 'css',
    input: '.a{color:var(--c, red)}',
    output: '.a{color:var(--c, blue)}'
  },
  {
    id: 'CPLX-REJ-VAR-NAME',
    desc: 'var() name swapped to a different custom property',
    ref: 'SAFE-02; custom properties',
    lang: 'css',
    input: '.a{color:var(--main)}',
    output: '.a{color:var(--secondary)}'
  },
  {
    id: 'CPLX-REJ-NTH-COEFF',
    desc: ':nth-child coefficient b changed (2n+1 -> 2n+2) selects different elements',
    ref: '#77/#78 nth; SAFE-02',
    lang: 'css',
    input: 'li:nth-child(2n+1){color:red}',
    output: 'li:nth-child(2n+2){color:red}'
  },
  {
    id: 'CPLX-REJ-NTH-N-SPLIT',
    desc: ':nth-child(2n) corrupted to (2 n) — the exact historical lonefy breakage',
    ref: '#77,#78 "SASS selector spacing"',
    lang: 'css',
    input: 'li:nth-child(2n){color:red}',
    output: 'li:nth-child(2 n){color:red}'
  },
  {
    id: 'CPLX-REJ-GRID-AREA',
    desc: 'grid-template-areas string changed (layout altered)',
    ref: 'SAFE-02; CSS Grid',
    lang: 'css',
    input: '.g{grid-template-areas:"a b" "c d"}',
    output: '.g{grid-template-areas:"a b" "c c"}'
  },
  {
    id: 'CPLX-REJ-TRANSITION-DROP',
    desc: 'a comma value dropped from a transition shorthand',
    ref: '#78 comma-values; SAFE-02',
    lang: 'css',
    input: '.a{transition:color .2s,transform .3s}',
    output: '.a{transition:color .2s}'
  },
  {
    id: 'CPLX-REJ-TRANSITION-EASING',
    desc: 'transition timing-function changed inside a comma value',
    ref: '#78 comma-values; SAFE-02',
    lang: 'css',
    input: '.a{transition:color .2s ease-in}',
    output: '.a{transition:color .2s ease-out}'
  },
  {
    id: 'CPLX-REJ-DESCENDANT-TO-CHILD',
    desc: 'descendant combinator turned into child (.a .b .c -> .a>.b .c) is a different selector',
    ref: '#67 combinator correctness; SAFE-02',
    lang: 'css',
    input: '.a .b .c{color:red}',
    output: '.a>.b .c{color:red}'
  },
  {
    id: 'CPLX-REJ-PSEUDO-SPACE',
    desc: 'space injected before pseudo-class (.a:hover -> .a :hover) changes the matched element',
    ref: '#77 pseudo-class space; SAFE-02',
    lang: 'css',
    input: '.a:hover{color:red}',
    output: '.a :hover{color:red}'
  },
  {
    id: 'CPLX-REJ-ATTR-OP',
    desc: 'attribute selector operator changed (^= -> *=)',
    ref: 'SAFE-02; attribute selectors',
    lang: 'css',
    input: 'a[href^="http"]{color:red}',
    output: 'a[href*="http"]{color:red}'
  },
  {
    id: 'CPLX-REJ-IMPORTANT-DROP',
    desc: '!important silently dropped changes the cascade',
    ref: 'SAFE-02; importance',
    lang: 'css',
    input: '.a{color:red !important}',
    output: '.a{color:red}'
  },
  {
    id: 'CPLX-REJ-MEDIA-DECL-DROP',
    desc: 'a declaration dropped inside a @media block',
    ref: 'SAFE-02; @media',
    lang: 'css',
    input: '@media (min-width:600px){.a{color:red;margin:0}}',
    output: '@media (min-width:600px){.a{color:red}}'
  },
  {
    id: 'CPLX-REJ-MEDIA-QUERY',
    desc: '@media feature value changed (600px -> 900px) alters the breakpoint',
    ref: 'SAFE-02; @media',
    lang: 'css',
    input: '@media (min-width:600px){.a{color:red}}',
    output: '@media (min-width:900px){.a{color:red}}'
  },
  {
    id: 'CPLX-REJ-BOX-SHADOW-INSET',
    desc: 'box-shadow inset keyword dropped changes the rendering',
    ref: '#78 comma-values; SAFE-02',
    lang: 'css',
    input: '.a{box-shadow:inset 0 0 5px red}',
    output: '.a{box-shadow:0 0 5px red}'
  },
  {
    id: 'CPLX-REJ-MARGIN-REORDER',
    desc: 'margin shorthand sides reordered (1 2 3 4 -> 4 3 2 1) is a value change',
    ref: 'SAFE-02; shorthand order is meaningful',
    lang: 'css',
    input: '.a{margin:1px 2px 3px 4px}',
    output: '.a{margin:4px 3px 2px 1px}'
  },
  {
    id: 'CPLX-REJ-INVALID-OUTPUT',
    desc: 'output that does not re-parse as CSS (unterminated block) is rejected',
    ref: 'SAFE-02 re-tokenise',
    lang: 'css',
    input: '.a{color:red}',
    output: '.a{color:red'
  },

  // ---- SCSS ----
  {
    id: 'CPLX-REJ-SCSS-INTERP-LOST',
    desc: 'interpolation token #{$x} resolved away to a literal changes the selector',
    ref: 'SAFE-02; SCSS interpolation',
    lang: 'scss',
    input: '.a-#{$x}{color:red}',
    output: '.a-x{color:red}'
  },
  {
    id: 'CPLX-REJ-SCSS-INCLUDE-ARG',
    desc: '@include argument changed (column -> row)',
    ref: 'SAFE-02; SCSS @include',
    lang: 'scss',
    input: '.a{@include flex(column)}',
    output: '.a{@include flex(row)}'
  },
  {
    id: 'CPLX-REJ-SCSS-IF-COND',
    desc: '@if condition negated (logic inverted)',
    ref: 'SAFE-02; SCSS control flow',
    lang: 'scss',
    input: '@mixin m($d){@if $d{color:red}}',
    output: '@mixin m($d){@if not $d{color:red}}'
  },
  {
    id: 'CPLX-REJ-SCSS-EXTEND-TARGET',
    desc: '@extend target changed (a:hover -> a:focus)',
    ref: '#77 @extend; SAFE-02',
    lang: 'scss',
    input: '.x{@extend a:hover}',
    output: '.x{@extend a:focus}'
  },
  {
    id: 'CPLX-REJ-SCSS-MAP-VALUE',
    desc: 'a value inside a SCSS map changed (992px -> 1200px)',
    ref: 'SAFE-02; SCSS maps',
    lang: 'scss',
    input: '$bp: (small: 576px, large: 992px);',
    output: '$bp: (small: 576px, large: 1200px);'
  },
  {
    id: 'CPLX-REJ-SCSS-EACH-LIST',
    desc: 'an item dropped from a @each list changes the iteration',
    ref: 'SAFE-02; SCSS @each',
    lang: 'scss',
    input: '@each $i in 1, 2, 3{.c-#{$i}{}}',
    output: '@each $i in 1, 2{.c-#{$i}{}}'
  },
  {
    id: 'CPLX-REJ-SCSS-MIXIN-DEFAULT',
    desc: 'mixin default argument value changed (1px -> 2px)',
    ref: 'SAFE-02; SCSS mixins',
    lang: 'scss',
    input: '@mixin m($x: 1px){width:$x}',
    output: '@mixin m($x: 2px){width:$x}'
  },

  // ---- LESS ----
  {
    id: 'CPLX-REJ-LESS-VAR',
    desc: 'LESS variable value changed (red -> blue)',
    ref: 'SAFE-02; LESS variables',
    lang: 'less',
    input: '@c: red;.a{color:@c}',
    output: '@c: blue;.a{color:@c}'
  },
  {
    id: 'CPLX-REJ-LESS-MIXIN-ARG',
    desc: 'LESS mixin call argument changed (2px -> 4px)',
    ref: 'SAFE-02; LESS mixins',
    lang: 'less',
    input: '.a{.bordered(2px)}',
    output: '.a{.bordered(4px)}'
  },
  {
    id: 'CPLX-REJ-LESS-GUARD',
    desc: 'LESS mixin guard condition flipped (> 0 -> < 0)',
    ref: 'SAFE-02; LESS guards',
    lang: 'less',
    input: '.m(@x) when (@x > 0){width:@x}',
    output: '.m(@x) when (@x < 0){width:@x}'
  },
  {
    id: 'CPLX-REJ-LESS-ESCAPE',
    desc: 'value inside a LESS escaped string changed (30px -> 40px)',
    ref: '#74 calc; LESS escaping',
    lang: 'less',
    input: '.a{width:~"calc(100% - 30px)"}',
    output: '.a{width:~"calc(100% - 40px)"}'
  },
  {
    id: 'CPLX-REJ-LESS-OP',
    desc: 'LESS arithmetic operand changed (* 2 -> * 3)',
    ref: 'SAFE-02; LESS operations',
    lang: 'less',
    input: '@b: 5px;.a{width:@b * 2}',
    output: '@b: 5px;.a{width:@b * 3}'
  }
];
