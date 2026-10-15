// The Vue template comparison (src/safety/vueTemplate.ts) and the case-exact
// block attributes (audit 21, V1 to V6). Each reject below is a pair the HTML
// comparison used to accept; the compiler oracle test proves the rendering side.
import assert from 'node:assert/strict';
import { vueSfcEqual } from '../../../src/safety/guard';
import { vueTemplateEqual } from '../../../src/safety/vueTemplate';

const accepts = (a: string, b: string): boolean => vueTemplateEqual(a, b).equivalent;

describe('safety/vueTemplate : a component named like svg or math (audit 24, N1)', () => {
  // parse5 enters SVG/MathML content for <Svg> or <MATH> whatever the case; Vue
  // only for lowercase svg and math, so for Vue these are components whose
  // <title> or <textarea> is raw text. The two readings differ: refuse.
  it('refuses a template with <Svg>, <SVG> or <Math>', () => {
    const input = '<Svg><title><x-t>\n</x-t></title><path d="M0"/></Svg>';
    const output = '<Svg>\n  <title><x-t>\n    </x-t></title>\n  <path d="M0" />\n</Svg>';
    assert.equal(vueTemplateEqual(input, output).equivalent, false);
    assert.equal(vueTemplateEqual('<SVG><b>x</b></SVG>', '<SVG>\n  <b>x</b>\n</SVG>').equivalent, false);
    assert.equal(vueTemplateEqual('<Math/>', '<Math />').equivalent, false);
  });

  it('still accepts lowercase svg and math, and names that only start with them', () => {
    assert.equal(vueTemplateEqual('<svg><path d="M0"/></svg>', '<svg>\n  <path d="M0" />\n</svg>').equivalent, true);
    assert.equal(vueTemplateEqual('<div><SvgIcon/></div>', '<div>\n  <SvgIcon />\n</div>').equivalent, true);
  });
});

describe('safety/vueTemplate : whitespace as Vue condenses it (V1, V2)', () => {
  it('rejects a space between two elements becoming a line break', () => {
    assert.equal(accepts('<a/> <b/>', '<a/>\n<b/>'), false);
    assert.equal(accepts('<a>1</a> <a>2</a>', '<a>1</a>\n<a>2</a>'), false);
  });

  it('accepts a line break turning into another line break or a longer gap', () => {
    assert.equal(accepts('<a/>\n<b/>', '<a/>\n\n   <b/>'), true);
    assert.equal(accepts('<a>1</a>\n<a>2</a>', '<a>1</a>\r\n  <a>2</a>'), true);
  });

  it('accepts the gap at either edge of a parent, which Vue always drops', () => {
    assert.equal(accepts('<div><a/></div>', '<div>\n  <a/>\n</div>'), true);
    assert.equal(accepts('<div> <a/> </div>', '<div><a/></div>'), true);
  });

  it('rejects text that gains or loses an edge space', () => {
    assert.equal(accepts('<h2>Inbox<Badge /></h2>', '<h2>Inbox\n<Badge /></h2>'), false);
    assert.equal(accepts('<p>(<Count />)</p>', '<p>( <Count />)</p>'), false);
    assert.equal(accepts('<p>a</p>', '<p> a </p>'), false);
  });

  it('accepts runs of whitespace inside text, which Vue collapses to one space', () => {
    assert.equal(accepts('<p>a b   c</p>', '<p>a\n  b c</p>'), true);
  });

  it('lifts what parse5 nests inside a self-closing component back to its siblings', () => {
    assert.equal(accepts('<div><Star /> <Star /> <Star /></div>', '<div><Star />\n<Star />\n<Star /></div>'), false);
    assert.equal(accepts('<div><Star />\n<Star /></div>', '<div>\n  <Star />\n  <Star />\n</div>'), true);
  });

  it('reads the comment rules in both the development and the production build', () => {
    // Development: the gaps next to the comment go. Production: the comment goes
    // and the two gaps merge into one space.
    assert.equal(accepts('<a/> <!-- c --> <b/>', '<a/>\n<!-- c -->\n<b/>'), false);
    assert.equal(accepts('<a/>\n<!-- c -->\n<b/>', '<a/>\n\n<!-- c -->\n<b/>'), true);
  });

  it('sees the line break after <pre> that parse5 drops and Vue keeps as an empty text', () => {
    assert.equal(accepts('<pre>\n<b>x</b></pre>', '<pre><b>x</b></pre>'), false);
    assert.equal(accepts('<textarea>\n</textarea>', '<textarea></textarea>'), false);
    assert.equal(accepts('<pre>\n<b>x</b></pre>', '<pre>\n<b>x</b></pre>'), true);
  });

  it('refuses a lone carriage return, which parse5 turns into a line feed', () => {
    assert.equal(vueTemplateEqual('<pre>a\rb</pre>', '<pre>a\nb</pre>').equivalent, false);
  });

  it('keeps the text of a preformatted element byte for byte', () => {
    assert.equal(accepts('<pre>a\n  b</pre>', '<pre>a\n    b</pre>'), false);
    assert.equal(accepts('<pre>a\n  b</pre>', '<pre>a\n  b</pre>'), true);
  });
});

describe('safety/vueTemplate : names keep the case written in the source (V3)', () => {
  it('rejects a tag name written in another case', () => {
    assert.equal(accepts('<MyComp/>', '<mycomp/>'), false);
    assert.equal(accepts('<MyComp></MyComp>', '<mycomp></mycomp>'), false);
  });

  it('rejects an attribute name written in another case', () => {
    assert.equal(accepts('<comp :fooBar="x"/>', '<comp :foobar="x"/>'), false);
    assert.equal(accepts('<comp fooBar="x"></comp>', '<comp foobar="x"></comp>'), false);
  });

  it('tells a bare attribute from an empty one (:foo is the same-name shorthand)', () => {
    assert.equal(accepts('<comp :foo />', '<comp :foo="" />'), false);
    assert.equal(accepts('<input disabled>', '<input disabled="">'), false);
    assert.equal(accepts('<input disabled="x">', "<input disabled = 'x'>"), true);
  });

  it('rejects an attribute reorder (v-bind overriding depends on the order)', () => {
    assert.equal(accepts('<a v-bind="o" id="i"></a>', '<a id="i" v-bind="o"></a>'), false);
  });
});

describe('safety/vueTemplate : interpolations verbatim (V5)', () => {
  it('rejects a change inside the expression', () => {
    assert.equal(accepts("<p>{{ x === 'a  b' }}</p>", "<p>{{ x === 'a b' }}</p>"), false);
    assert.equal(accepts('<p>{{ a+b }}</p>', '<p>{{ a + b }}</p>'), false);
  });

  it('accepts the blanks at the edge of the braces, which Vue trims', () => {
    assert.equal(accepts('<p>{{x}}</p>', '<p>{{  x  }}</p>'), true);
  });

  it('refuses an interpolation that runs across markup', () => {
    const verdict = vueTemplateEqual('<p>{{ a <b>x</b> }}</p>', '<p>{{ a <b>x</b> }}</p>');
    assert.equal(verdict.equivalent, false);
    assert.match(verdict.reason ?? '', /unterminated interpolation/);
  });

  it('refuses a brace spelled as an entity (parse5 decodes it, Vue does not)', () => {
    assert.equal(accepts('<p>&#123;&#123; a }}</p>', '<p>&#123;&#123; a }}</p>'), false);
  });
});

describe('safety/vueTemplate : the slash of a non-void tag (V6)', () => {
  it('rejects a sibling becoming the content of a component', () => {
    assert.equal(accepts('<my-comp/><span>x</span>', '<my-comp><span>x</span></my-comp>'), false);
  });

  it('rejects writing the same empty component with and without the slash', () => {
    assert.equal(accepts('<A />', '<A></A>'), false);
    assert.equal(accepts('<A></A>', '<A />'), false);
  });

  it('does not count the slash of a void element', () => {
    assert.equal(accepts('<div><br><hr></div>', '<div><br /><hr /></div>'), true);
  });
});

describe('safety/vueTemplate : markup parse5 and Vue read differently is refused', () => {
  const refused = (source: string): boolean => !vueTemplateEqual(source, source).equivalent;

  it('refuses elements parse5 had to repair', () => {
    assert.equal(refused('<ul><li>a<li>b</ul>'), true);
    assert.equal(refused('<p>a<div>b</div></p>'), true);
    assert.equal(refused('<div><td>x</td></div>'), true);
    // A tag parse5 ignores leaves no trace in its tree: stray end tags, <body>.
    assert.equal(refused('<div></span></div>'), true);
    assert.equal(refused('<p>a</p></p>'), true);
    assert.equal(refused('<br></br>'), true);
    assert.equal(refused('<div><Body>x</Body></div>'), true);
    assert.equal(refused('<table>text<tr><td>a</td></tr></table>'), true);
  });

  it('reads a table without <tbody> as written, although parse5 invents the <tbody>', () => {
    assert.equal(refused('<table><tr><td>a</td></tr></table>'), false);
    assert.equal(
      accepts('<table><tr><td>a</td></tr><tr><td>b</td></tr></table>', '<table>\n  <tr>\n    <td>a</td>\n  </tr>\n  <tr>\n    <td>b</td>\n  </tr>\n</table>'),
      true
    );
  });

  it('refuses tags whose content Vue reads as markup and parse5 as text', () => {
    assert.equal(refused('<xmp><b></xmp>'), true);
    assert.equal(refused('<iframe src="a"></iframe>'), true);
    assert.equal(refused('<noscript><b>x</b></noscript>'), true);
  });

  it('refuses a duplicate attribute and a self-closing tag closed later', () => {
    assert.equal(refused('<a x="1" x="2"></a>'), true);
    assert.equal(refused('<div/>x</div>'), true);
  });

  it('does not count tags that sit in a comment or an attribute value', () => {
    const source = '<div :a="i<n" title="<b>"><!-- <p>old</p> --><span>x</span></div>';
    assert.equal(refused(source), false);
  });

  it('accepts well formed markup compared with itself', () => {
    assert.equal(
      vueTemplateEqual('<ul><li>a</li><li>b</li></ul>', '<ul><li>a</li><li>b</li></ul>').equivalent,
      true
    );
  });
});

describe('safety/vueGuard : block tags and attributes are compared as written (V3)', () => {
  const sfc = (head: string): string => `<template>\n  <p>x</p>\n</template>\n${head}\nlet a = 1;\n</script>\n`;

  it('rejects a block attribute written in another case', () => {
    assert.equal(
      vueSfcEqual(sfc('<script setup lang="ts">'), sfc('<script SETUP lang="ts">')).equivalent,
      false
    );
    assert.equal(
      vueSfcEqual(sfc('<script setup lang="ts">'), sfc('<script setup LANG="ts">')).equivalent,
      false
    );
  });

  it('rejects a block tag written in another case', () => {
    assert.equal(vueSfcEqual(sfc('<script>'), sfc('<SCRIPT>').replace('</script>', '</SCRIPT>')).equivalent, false);
  });

  it('still accepts the same attributes in another order', () => {
    assert.equal(
      vueSfcEqual(sfc('<script setup lang="ts">'), sfc('<script lang="ts" setup>')).equivalent,
      true
    );
  });
});
