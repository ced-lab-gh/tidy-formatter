// Manifest assertions for the Vue SFC addition (ADD-15): activation stays
// anti-hijack clean and the per-language toggle is declared like its siblings.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');

interface Manifest {
  activationEvents: string[];
  contributes: {
    configuration: Array<{
      properties: Record<
        string,
        { type?: string; default?: unknown; description?: string }
      >;
    }>;
  };
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')
) as Manifest;

describe('manifest : Vue SFC contribution (ADD-15)', () => {
  it('activates on onLanguage:vue and on NOTHING broader', () => {
    assert.ok(manifest.activationEvents.includes('onLanguage:vue'));
    for (const event of manifest.activationEvents) {
      assert.ok(
        event.startsWith('onLanguage:'),
        `every activation event must stay onLanguage:* (got '${event}')`
      );
    }
  });

  it('declares tidy.vue.enable as a boolean defaulting to true, in English', () => {
    // The configuration is an array of titled sections: look the key up in all.
    const properties = Object.assign(
      {},
      ...manifest.contributes.configuration.map((section) => section.properties)
    ) as Manifest['contributes']['configuration'][number]['properties'];
    const prop = properties['tidy.vue.enable'];
    assert.ok(prop, 'tidy.vue.enable must be declared');
    assert.equal(prop.type, 'boolean');
    assert.equal(prop.default, true);
    assert.ok(prop.description!.includes('Vue single-file components'));
    assert.ok(
      !prop.description!.includes(String.fromCharCode(0x2014)),
      'no em dash in shipped copy'
    );
  });
});
