// Template-island protection fixtures (SPEC CFG-04): {{ }}, {% %}, <% %> islands
// inside HTML must survive a format byte-identical. Derived from the incumbent's
// template-mangling bugs: #11 (jinja), #45 (django), #48 (vue), #65 (liquid),
// #66/#16 (custom template separators).
export interface TemplateFixture {
  id: string;
  desc: string;
  ref: string;
  /** HTML containing one or more template islands. */
  html: string;
  /** Island strings that must round-trip verbatim through mask -> format -> restore. */
  islands: string[];
}

export const templateFixtures: TemplateFixture[] = [
  {
    id: 'TPL-MUSTACHE',
    desc: 'Mustache/Vue/Jinja expression {{ var }} preserved',
    ref: '#66 "{{ }} separators"',
    html: '<div>{{ user.name }}</div>',
    islands: ['{{ user.name }}']
  },
  {
    id: 'TPL-JINJA-STATEMENT',
    desc: 'Jinja/Django {% if %}...{% endif %} statements preserved',
    ref: '#11 "jinja templates are formatted as html"',
    html: '<ul>{% if items %}<li>x</li>{% endif %}</ul>',
    islands: ['{% if items %}', '{% endif %}']
  },
  {
    id: 'TPL-EJS-ERB',
    desc: 'EJS/ERB <% ... %> scriptlets preserved',
    ref: '#45 server-side scriptlets',
    html: '<p><%= title %></p>',
    islands: ['<%= title %>']
  },
  {
    id: 'TPL-DJANGO-IN-SCRIPT',
    desc: 'Django variable {{ x }} embedded in a <script> tag preserved (regression #45)',
    ref: '#45 "Passing template variables to html script tags"',
    html: '<script>var x = {{ django_variable }};</script>',
    islands: ['{{ django_variable }}']
  },
  {
    id: 'TPL-MULTILINE',
    desc: 'multi-line {% %} block captured whole',
    ref: '#11 nested blocks',
    html: '<div>{% for item in\n  items %}<span>{{ item }}</span>{% endfor %}</div>',
    islands: ['{% for item in\n  items %}', '{{ item }}', '{% endfor %}']
  },
  {
    id: 'TPL-MIXED',
    desc: 'mixed {{ }} and {% %} in one document all preserved',
    ref: '#11,#45 combined',
    html: '<div>{% if u %}<p>{{ u.name }}</p>{% else %}<p>guest</p>{% endif %}</div>',
    islands: ['{% if u %}', '{{ u.name }}', '{% else %}', '{% endif %}']
  },
  {
    id: 'TPL-JINJA-IN-ATTR',
    desc: 'Jinja islands inside attribute values preserved (href + conditional class)',
    ref: '#48 vue bindings / review "Breaks jinja2 templates"',
    html: '<a href="{{ url_for(\'home\') }}" class="{% if active %}on{% endif %}">home</a>',
    islands: ["{{ url_for('home') }}", '{% if active %}', '{% endif %}']
  },
  {
    id: 'TPL-ADJACENT',
    desc: 'adjacent islands with no separator all restored',
    ref: '#66 custom separators',
    html: '<span>{{ a }}{{ b }}{% set c = 1 %}</span>',
    islands: ['{{ a }}', '{{ b }}', '{% set c = 1 %}']
  },
  {
    id: 'TPL-MULTILINE-STATEMENT',
    desc: 'a {% %} statement spanning three lines captured whole',
    ref: '#11 nested blocks',
    html: '<div>{% for row in rows\n    if row.visible\n%}<i>{{ row.id }}</i>{% endfor %}</div>',
    islands: [
      '{% for row in rows\n    if row.visible\n%}',
      '{{ row.id }}',
      '{% endfor %}'
    ]
  }
];

/**
 * Front matter fixtures (incumbent issue 75: a head '---' block reindented or
 * destroyed by the HTML beautifier). Consumed only by the ADD-02 unit tests, and
 * deliberately NOT added to `templateFixtures`: the legacy maskTemplateIslands
 * knows nothing about front matter, so the existing loop over templateFixtures
 * would fail on them.
 */
export interface FrontMatterFixture {
  id: string;
  desc: string;
  html: string;
  /** The exact front matter island (delimiters included, no trailing newline). */
  frontMatter: string;
  /** Additional {{ }} / {% %} / <% %> islands outside the front matter. */
  islands: string[];
}

export const frontMatterFixtures: FrontMatterFixture[] = [
  {
    id: 'FM-BASIC',
    desc: 'a simple YAML front matter block at the head of the document',
    html: '---\ntitle: Home\nlayout: page\n---\n<h1>Home</h1>\n',
    frontMatter: '---\ntitle: Home\nlayout: page\n---',
    islands: []
  },
  {
    id: 'FM-EMPTY',
    desc: 'an empty front matter block (opening line immediately closed)',
    html: '---\n---\n<p>x</p>\n',
    frontMatter: '---\n---',
    islands: []
  },
  {
    id: 'FM-CRLF',
    desc: 'a CRLF front matter block',
    html: '---\r\ntitle: Home\r\n---\r\n<h1>Home</h1>\r\n',
    frontMatter: '---\r\ntitle: Home\r\n---',
    islands: []
  },
  {
    id: 'FM-TRAILING-BLANKS',
    desc: 'delimiter lines with trailing spaces/tabs still delimit',
    html: '---  \ntitle: Home\n---\t\n<h1>Home</h1>\n',
    frontMatter: '---  \ntitle: Home\n---\t',
    islands: []
  },
  {
    id: 'FM-WITH-ISLANDS',
    desc: 'front matter plus template islands in the body',
    html: '---\ntitle: Home\n---\n<h1>{{ title }}</h1>{% if x %}<i>y</i>{% endif %}\n',
    frontMatter: '---\ntitle: Home\n---',
    islands: ['{{ title }}', '{% if x %}', '{% endif %}']
  },
  {
    id: 'FM-BRACES-INSIDE',
    desc: 'a {{ }} living INSIDE the front matter is part of the front matter island, never double-masked',
    html: '---\ntitle: {{ site.name }}\n---\n<h1>hi</h1>\n',
    frontMatter: '---\ntitle: {{ site.name }}\n---',
    islands: []
  },
  {
    id: 'FM-BOM',
    desc: 'a leading BOM does not prevent front matter detection',
    html: '﻿---\ntitle: Home\n---\n<h1>hi</h1>\n',
    frontMatter: '---\ntitle: Home\n---',
    islands: []
  }
];

/**
 * Inputs that must NOT be recognised as front matter. The head '---' rule is
 * deliberately strict: over-recognising would freeze document content that the
 * user does want formatted.
 */
export const nonFrontMatterFixtures: ReadonlyArray<{
  id: string;
  desc: string;
  html: string;
}> = [
  {
    id: 'NFM-UNTERMINATED',
    desc: 'an opening --- with no closing --- is not front matter',
    html: '---\ntitle: Home\n<h1>hi</h1>\n'
  },
  {
    id: 'NFM-FOUR-DASHES',
    desc: '---- is not a delimiter line',
    html: '----\ntitle: Home\n----\n<h1>hi</h1>\n'
  },
  {
    id: 'NFM-TRAILING-TEXT',
    desc: '--- followed by text on the same line is not a delimiter line',
    html: '--- title\nlayout: page\n---\n<h1>hi</h1>\n'
  },
  {
    id: 'NFM-NOT-FIRST-LINE',
    desc: 'a --- block that does not start on line 1 is never front matter',
    html: '<h1>hi</h1>\n---\ntitle: Home\n---\n'
  },
  {
    id: 'NFM-BARE-DELIMITER',
    desc: 'a document that is only --- has no body and no closing line',
    html: '---'
  }
];
