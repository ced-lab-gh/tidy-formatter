// Vue SFC corpus for ADD-15: engine + guard + integration suites share these.
// Every fixture is deliberately messy where Tidy SHOULD act (template/style)
// and byte-sensitive where it MUST NOT (script, custom blocks, skeleton).
export interface VueFixture {
  /** Stable id used in test titles. */
  id: string;
  desc: string;
  input: string;
  /** True when the v1 engine must return the input UNCHANGED (clean no-op). */
  expectNoop: boolean;
  /** Byte spans that must survive VERBATIM in any output (script bodies...). */
  verbatimSpans: string[];
}

export const VUE_BASIC = [
  '<template>',
  '<div   class="card"    v-if="visible"  :title="label"  @click="onClick">',
  '<span>{{ count }}</span>',
  '</div>',
  '</template>',
  '',
  '<script setup lang="ts">',
  'const count = props?.count ?? 0;',
  'function onClick(){emit("pick",count)}',
  '</script>',
  '',
  '<style scoped>',
  '.card{color:red;background:#fff}',
  '</style>',
  ''
].join('\n');

export const vueFixtures: VueFixture[] = [
  {
    id: 'VUE-BASIC',
    desc: 'messy template + compact css are formatted; the script body stays byte-identical',
    input: VUE_BASIC,
    expectNoop: false,
    verbatimSpans: [
      '\nconst count = props?.count ?? 0;\nfunction onClick(){emit("pick",count)}\n'
    ]
  },
  {
    id: 'VUE-MULTI-STYLE',
    desc: 'several style blocks, each formatted with its own dialect (css + scss)',
    input: [
      '<template>',
      '<p    class="a">x</p>',
      '</template>',
      '<style>',
      '.a{color:red}',
      '</style>',
      '<style lang="scss">',
      '.card{ .title{ color : red ; } }',
      '</style>',
      ''
    ].join('\n'),
    expectNoop: false,
    verbatimSpans: []
  },
  {
    id: 'VUE-COMMENTS-BETWEEN-BLOCKS',
    desc: 'comments and blank lines between blocks are part of the skeleton and survive verbatim',
    input: [
      '<!-- app root component -->',
      '<template>',
      '<b   >x</b>',
      '</template>',
      '',
      '<!-- styles below -->',
      '',
      '<style>',
      '.b{color:blue}',
      '</style>',
      ''
    ].join('\n'),
    expectNoop: false,
    verbatimSpans: ['<!-- app root component -->', '<!-- styles below -->']
  },
  {
    id: 'VUE-CUSTOM-BLOCK',
    desc: 'a custom block (<docs>) is preserved byte-for-byte while the rest formats',
    input: [
      '<docs>',
      '  ##   Usage',
      '  keep     this   spacing',
      '</docs>',
      '<template>',
      '<i    >y</i>',
      '</template>',
      ''
    ].join('\n'),
    expectNoop: false,
    verbatimSpans: ['\n  ##   Usage\n  keep     this   spacing\n']
  },
  {
    id: 'VUE-PUG-TEMPLATE',
    desc: 'a pug template makes the whole file a clean no-op',
    input: [
      '<template lang="pug">',
      'div.card',
      '  span hello',
      '</template>',
      '<style>',
      '.a{color:red}',
      '</style>',
      ''
    ].join('\n'),
    expectNoop: true,
    verbatimSpans: []
  },
  {
    id: 'VUE-STYLUS-STYLE',
    desc: 'a stylus style block makes the whole file a clean no-op',
    input: [
      '<template>',
      '<p   >x</p>',
      '</template>',
      '<style lang="stylus">',
      '.a',
      '  color red',
      '</style>',
      ''
    ].join('\n'),
    expectNoop: true,
    verbatimSpans: []
  },
  {
    id: 'VUE-PROTO-STYLE-LANG',
    desc: 'a hostile lang="__proto__" style block is unsupported: clean no-op, never a lookup trap',
    input: [
      '<template>',
      '<p   >x</p>',
      '</template>',
      '<style lang="__proto__">',
      '.a{color:red}',
      '</style>',
      ''
    ].join('\n'),
    expectNoop: true,
    verbatimSpans: []
  },
  {
    id: 'VUE-NO-END-TAG',
    desc: 'a template without its end tag cannot be split safely: clean no-op',
    input: '<template>\n<div>x</div>\n',
    expectNoop: true,
    verbatimSpans: []
  },
  {
    id: 'VUE-SELF-CLOSING-TEMPLATE',
    desc: 'a self-closing <template/> (HTML repairs it) cannot be split safely: clean no-op',
    input: '<template/>\n<style>.a{color:red}</style>\n',
    expectNoop: true,
    verbatimSpans: []
  },
  {
    id: 'VUE-PLACEHOLDER-COLLISION',
    desc: 'a literal mask placeholder in the source forces a clean no-op (collision refusal)',
    input: [
      '<template>',
      '<p>__TIDY_IGNORE_PLACEHOLDER_0__</p>',
      '</template>',
      '<style>',
      '.a{color:red}',
      '</style>',
      ''
    ].join('\n'),
    expectNoop: true,
    verbatimSpans: []
  }
];
