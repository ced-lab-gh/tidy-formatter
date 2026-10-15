// Unit tests for the pure Vue SFC splitter (ADD-15). No 'vscode', no engines.
import assert from 'node:assert/strict';
import {
  splitVueSfc,
  skeletonSegments,
  isSupportedTemplateBlock,
  styleGuardLangFor
} from '../../../src/vue/sfcBlocks';

describe('vue/sfcBlocks : splitVueSfc block discovery', () => {
  const source =
    '<!-- head -->\n<template>\n<div>x</div>\n</template>\n\n' +
    '<script setup>\nlet a=1\n</script>\n<style lang="scss">.a{}</style>\n';

  it('finds template, script and style blocks in document order with exact offsets', () => {
    const split = splitVueSfc(source);
    assert.ok(split, 'the SFC must split');
    const blocks = split!.blocks;
    assert.deepEqual(
      blocks.map((b) => b.tagName),
      ['template', 'script', 'style']
    );
    // Offsets are trustworthy: slicing outer spans reproduces the source blocks.
    assert.equal(
      source.slice(blocks[0].outerStart, blocks[0].outerEnd),
      '<template>\n<div>x</div>\n</template>'
    );
    assert.equal(
      source.slice(blocks[1].innerStart, blocks[1].innerEnd),
      '\nlet a=1\n'
    );
    assert.equal(source.slice(blocks[2].innerStart, blocks[2].innerEnd), '.a{}');
  });

  it('classifies kinds and captures attrs (setup flag, lang value)', () => {
    const blocks = splitVueSfc(source)!.blocks;
    assert.equal(blocks[0].kind, 'template');
    assert.equal(blocks[1].kind, 'script');
    assert.ok(blocks[1].attrs.some((a) => a.name === 'setup'));
    assert.equal(blocks[2].kind, 'style');
    assert.equal(blocks[2].lang, 'scss');
  });

  it('normalises the lang attribute (trim + lower-case)', () => {
    const split = splitVueSfc('<style lang=" SCSS ">.a{}</style>');
    assert.equal(split!.blocks[0].lang, 'scss');
  });

  it('treats an unknown top-level tag as a custom block', () => {
    const split = splitVueSfc('<docs>hello</docs>');
    assert.equal(split!.blocks[0].kind, 'custom');
    assert.equal(split!.blocks[0].tagName, 'docs');
  });

  it('returns an empty block list for a blockless document', () => {
    assert.deepEqual(splitVueSfc('just text\n')!.blocks, []);
    assert.deepEqual(splitVueSfc('')!.blocks, []);
  });
});

describe('vue/sfcBlocks : splitVueSfc refuses what it cannot slice safely', () => {
  it('returns undefined when an end tag is missing', () => {
    assert.equal(splitVueSfc('<template>\n<div>x</div>\n'), undefined);
  });

  it('returns undefined for a self-closing <template/> (parse5 repairs it)', () => {
    assert.equal(
      splitVueSfc('<template/>\n<style>.a{}</style>\n'),
      undefined
    );
  });

  it('returns undefined on foster-parented structures (top-level <table><div>)', () => {
    // parse5 hoists the <div> OUT of the table as a preceding sibling: its
    // source range overlaps the table's, which the monotonicity check refuses.
    assert.equal(splitVueSfc('<table><div>x</div></table>'), undefined);
  });
});

describe('vue/sfcBlocks : skeletonSegments', () => {
  it('returns blocks.length + 1 segments covering every inter-block byte', () => {
    const source = 'A<template>t</template>B<style>s</style>C';
    const blocks = splitVueSfc(source)!.blocks;
    const segments = skeletonSegments(source, blocks);
    assert.deepEqual(segments, ['A', 'B', 'C']);
  });
});

describe('vue/sfcBlocks : language classification helpers', () => {
  const block = (src: string) => splitVueSfc(src)!.blocks[0];

  it('supports plain and lang="html" templates only', () => {
    assert.equal(isSupportedTemplateBlock(block('<template>x</template>')), true);
    assert.equal(
      isSupportedTemplateBlock(block('<template lang="html">x</template>')),
      true
    );
    assert.equal(
      isSupportedTemplateBlock(block('<template lang="pug">x</template>')),
      false
    );
  });

  it('maps style dialects and refuses everything else', () => {
    assert.equal(styleGuardLangFor(block('<style>.a{}</style>')), 'css');
    assert.equal(styleGuardLangFor(block('<style lang="css">.a{}</style>')), 'css');
    assert.equal(styleGuardLangFor(block('<style lang="scss">.a{}</style>')), 'scss');
    assert.equal(styleGuardLangFor(block('<style lang="less">.a{}</style>')), 'less');
    assert.equal(styleGuardLangFor(block('<style lang="stylus">.a{}</style>')), undefined);
    // A hostile lang can never walk the prototype chain into a false positive.
    assert.equal(
      styleGuardLangFor(block('<style lang="__proto__">.a{}</style>')),
      undefined
    );
    assert.equal(styleGuardLangFor(block('<template>x</template>')), undefined);
  });
});
