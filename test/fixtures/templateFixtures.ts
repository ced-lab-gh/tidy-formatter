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
  }
];
