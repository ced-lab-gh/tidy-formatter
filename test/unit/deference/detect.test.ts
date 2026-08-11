// Unit tests for the PURE competing-formatter detector (Axe 4 / 4.T4).
//
// PURE (no 'vscode'): we import only the pure functions + label/constant exports.
// `detectCompetingFormatters` loads 'vscode' lazily INSIDE its body, so importing
// this module does NOT pull in 'vscode' : a regression that hoisted a top-level
// 'vscode' import would make this file fail to load (the point).
//
// Coverage focus (ROADMAP 4.T4 acceptance):
//   - recognises `.prettierrc*` variants / biome.json / dprint.json;
//   - recognises `.eslintrc*` / `eslint.config.*` variants (ADD-07);
//   - recognises the package.json `prettier` and `eslintConfig` key signals;
//   - `.prettierignore` (and `.eslintignore`) ALONE activates nothing (CFG-07);
//   - stable ordering + de-duplication across signals and folders;
//   - defensive against malformed input (non-array / non-string entries).
import assert from 'node:assert/strict';
import {
  detectFromFilenames,
  mergeDetected,
  packageJsonDeclaresPrettier,
  packageJsonDeclaresEslintConfig,
  FORMATTER_PRETTIER,
  FORMATTER_BIOME,
  FORMATTER_DPRINT,
  FORMATTER_ESLINT,
  PACKAGE_JSON_FILENAME
} from '../../../src/deference/detect';

describe('deference/detect : constants', () => {
  it('exposes stable formatter labels', () => {
    assert.equal(FORMATTER_PRETTIER, 'Prettier');
    assert.equal(FORMATTER_BIOME, 'Biome');
    assert.equal(FORMATTER_DPRINT, 'dprint');
    assert.equal(FORMATTER_ESLINT, 'ESLint');
  });

  it('exposes the package manifest filename', () => {
    assert.equal(PACKAGE_JSON_FILENAME, 'package.json');
  });
});

describe('deference/detect : detectFromFilenames (Prettier variants)', () => {
  const prettierVariants = [
    '.prettierrc',
    '.prettierrc.json',
    '.prettierrc.json5',
    '.prettierrc.yaml',
    '.prettierrc.yml',
    '.prettierrc.js',
    '.prettierrc.cjs',
    '.prettierrc.mjs',
    '.prettierrc.ts',
    '.prettierrc.cts',
    '.prettierrc.mts',
    '.prettierrc.toml',
    'prettier.config.js',
    'prettier.config.cjs',
    'prettier.config.mjs',
    'prettier.config.ts',
    'prettier.config.cts',
    'prettier.config.mts'
  ];

  for (const file of prettierVariants) {
    it(`recognises ${file} as Prettier`, () => {
      assert.deepEqual(detectFromFilenames([file]), [FORMATTER_PRETTIER]);
    });
  }
});

describe('deference/detect : detectFromFilenames (Biome / dprint)', () => {
  it('recognises biome.json and biome.jsonc', () => {
    assert.deepEqual(detectFromFilenames(['biome.json']), [FORMATTER_BIOME]);
    assert.deepEqual(detectFromFilenames(['biome.jsonc']), [FORMATTER_BIOME]);
  });

  it('recognises dprint.json and dotfile/jsonc variants', () => {
    assert.deepEqual(detectFromFilenames(['dprint.json']), [FORMATTER_DPRINT]);
    assert.deepEqual(detectFromFilenames(['dprint.jsonc']), [FORMATTER_DPRINT]);
    assert.deepEqual(detectFromFilenames(['.dprint.json']), [FORMATTER_DPRINT]);
    assert.deepEqual(detectFromFilenames(['.dprint.jsonc']), [FORMATTER_DPRINT]);
  });
});

describe('deference/detect : CFG-07 (.prettierignore alone activates nothing)', () => {
  it('does NOT detect Prettier from .prettierignore by itself', () => {
    assert.deepEqual(detectFromFilenames(['.prettierignore']), []);
  });

  it('still detects Prettier when a real config sits next to .prettierignore', () => {
    assert.deepEqual(detectFromFilenames(['.prettierignore', '.prettierrc']), [
      FORMATTER_PRETTIER
    ]);
  });
});

describe('deference/detect : package.json prettier key', () => {
  it('detects Prettier when the package.json prettier flag is true', () => {
    assert.deepEqual(detectFromFilenames(['package.json'], true), [FORMATTER_PRETTIER]);
  });

  it('does NOT detect Prettier when package.json has no prettier key', () => {
    assert.deepEqual(detectFromFilenames(['package.json'], false), []);
  });

  it('de-duplicates a package.json key with a co-present .prettierrc', () => {
    assert.deepEqual(detectFromFilenames(['.prettierrc', 'package.json'], true), [
      FORMATTER_PRETTIER
    ]);
  });
});

describe('deference/detect : ordering, dedup, irrelevant names', () => {
  it('returns nothing for an empty / unrelated listing', () => {
    assert.deepEqual(detectFromFilenames([]), []);
    assert.deepEqual(detectFromFilenames(['README.md', 'src', 'tsconfig.json']), []);
  });

  it('orders detected formatters stably: Prettier, Biome, dprint', () => {
    assert.deepEqual(
      detectFromFilenames(['dprint.json', 'biome.json', '.prettierrc']),
      [FORMATTER_PRETTIER, FORMATTER_BIOME, FORMATTER_DPRINT]
    );
  });

  it('de-duplicates repeated config files of the same formatter', () => {
    assert.deepEqual(
      detectFromFilenames(['.prettierrc', '.prettierrc.json']),
      [FORMATTER_PRETTIER]
    );
  });
});

describe('deference/detect : defensive against malformed input', () => {
  it('treats a non-array input as empty', () => {
    assert.deepEqual(detectFromFilenames(undefined as unknown as string[]), []);
    assert.deepEqual(detectFromFilenames(null as unknown as string[]), []);
  });

  it('skips non-string entries without throwing', () => {
    const messy = [42, null, undefined, '.prettierrc', {}] as unknown as string[];
    assert.deepEqual(detectFromFilenames(messy), [FORMATTER_PRETTIER]);
  });

  it('trims surrounding whitespace before matching', () => {
    assert.deepEqual(detectFromFilenames(['  biome.json  ']), [FORMATTER_BIOME]);
  });
});

describe('deference/detect : mergeDetected', () => {
  it('merges per-folder results, de-duped and stably ordered', () => {
    assert.deepEqual(
      mergeDetected([FORMATTER_DPRINT], [FORMATTER_PRETTIER], [FORMATTER_PRETTIER]),
      [FORMATTER_PRETTIER, FORMATTER_DPRINT]
    );
  });

  it('returns [] when no folder detected anything', () => {
    assert.deepEqual(mergeDetected([], []), []);
    assert.deepEqual(mergeDetected(), []);
  });

  it('ignores non-array / non-string members defensively', () => {
    const merged = mergeDetected(
      [FORMATTER_BIOME],
      null as unknown as string[],
      [1 as unknown as string, FORMATTER_PRETTIER]
    );
    assert.deepEqual(merged, [FORMATTER_PRETTIER, FORMATTER_BIOME]);
  });
});

describe('deference/detect : packageJsonDeclaresPrettier', () => {
  it('is true only when a top-level prettier key is present', () => {
    assert.equal(packageJsonDeclaresPrettier({ prettier: { semi: false } }), true);
    assert.equal(packageJsonDeclaresPrettier({ prettier: 'tailwind-preset' }), true);
    // Even a null value still means "the key is declared".
    assert.equal(packageJsonDeclaresPrettier({ prettier: null }), true);
  });

  it('is false for objects without the key', () => {
    assert.equal(packageJsonDeclaresPrettier({ name: 'pkg', scripts: {} }), false);
    assert.equal(packageJsonDeclaresPrettier({}), false);
  });

  it('is false (fail-soft) for non-object input', () => {
    assert.equal(packageJsonDeclaresPrettier(null), false);
    assert.equal(packageJsonDeclaresPrettier(undefined), false);
    assert.equal(packageJsonDeclaresPrettier('prettier'), false);
    assert.equal(packageJsonDeclaresPrettier(['prettier']), false);
    assert.equal(packageJsonDeclaresPrettier(42), false);
  });
});

describe('deference/detect : detectFromFilenames (ESLint variants, ADD-07)', () => {
  const eslintVariants = [
    '.eslintrc',
    '.eslintrc.json',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.yaml',
    '.eslintrc.yml',
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
    'eslint.config.mts',
    'eslint.config.cts'
  ];

  for (const file of eslintVariants) {
    it(`recognises ${file} as ESLint`, () => {
      assert.deepEqual(detectFromFilenames([file]), [FORMATTER_ESLINT]);
    });
  }

  it('de-duplicates several ESLint config files into one label', () => {
    assert.deepEqual(detectFromFilenames(['.eslintrc', 'eslint.config.js']), [
      FORMATTER_ESLINT
    ]);
  });

  it('trims surrounding whitespace before matching an ESLint config', () => {
    assert.deepEqual(detectFromFilenames(['  eslint.config.mjs  ']), [FORMATTER_ESLINT]);
  });
});

describe('deference/detect : .eslintignore alone activates nothing (CFG-07 parallel)', () => {
  it('does NOT detect ESLint from .eslintignore by itself', () => {
    assert.deepEqual(detectFromFilenames(['.eslintignore']), []);
  });

  it('still detects ESLint when a real config sits next to .eslintignore', () => {
    assert.deepEqual(detectFromFilenames(['.eslintignore', '.eslintrc.json']), [
      FORMATTER_ESLINT
    ]);
  });

  it('does NOT detect ESLint from lookalike or unsupported names', () => {
    assert.deepEqual(
      detectFromFilenames([
        '.eslintrc.json5',
        '.eslintrc.mjs',
        'eslint.config.json',
        'eslint.config.d.ts',
        'ESLINT.CONFIG.JS',
        'my-eslint.config.js'
      ]),
      []
    );
  });
});

describe('deference/detect : package.json eslintConfig key (ADD-07)', () => {
  it('detects ESLint when the package.json eslintConfig flag is true', () => {
    assert.deepEqual(detectFromFilenames(['package.json'], false, true), [
      FORMATTER_ESLINT
    ]);
  });

  it('does NOT detect ESLint when package.json has no eslintConfig key', () => {
    assert.deepEqual(detectFromFilenames(['package.json'], false, false), []);
  });

  it('folds both package.json keys into a stable, de-duplicated order', () => {
    assert.deepEqual(detectFromFilenames(['package.json'], true, true), [
      FORMATTER_PRETTIER,
      FORMATTER_ESLINT
    ]);
  });

  it('de-duplicates the eslintConfig key with a co-present eslint.config.js', () => {
    assert.deepEqual(
      detectFromFilenames(['eslint.config.js', 'package.json'], false, true),
      [FORMATTER_ESLINT]
    );
  });

  it('keeps the two-argument call shape working (no ESLint signal implied)', () => {
    assert.deepEqual(detectFromFilenames(['package.json'], true), [FORMATTER_PRETTIER]);
  });
});

describe('deference/detect : four-way ordering (ADD-07)', () => {
  it('orders detected formatters stably: Prettier, Biome, dprint, ESLint', () => {
    assert.deepEqual(
      detectFromFilenames([
        'eslint.config.js',
        'dprint.json',
        'biome.json',
        '.prettierrc'
      ]),
      [FORMATTER_PRETTIER, FORMATTER_BIOME, FORMATTER_DPRINT, FORMATTER_ESLINT]
    );
  });

  it('mergeDetected keeps ESLint last across folders', () => {
    assert.deepEqual(
      mergeDetected([FORMATTER_ESLINT], [FORMATTER_BIOME], [FORMATTER_ESLINT]),
      [FORMATTER_BIOME, FORMATTER_ESLINT]
    );
  });
});

describe('deference/detect : packageJsonDeclaresEslintConfig (ADD-07)', () => {
  it('is true only when a top-level eslintConfig key is present', () => {
    assert.equal(packageJsonDeclaresEslintConfig({ eslintConfig: { root: true } }), true);
    // Even a null value still means "the key is declared" (same rule as prettier).
    assert.equal(packageJsonDeclaresEslintConfig({ eslintConfig: null }), true);
  });

  it('is false for objects without the key', () => {
    assert.equal(packageJsonDeclaresEslintConfig({ name: 'pkg', prettier: {} }), false);
    assert.equal(packageJsonDeclaresEslintConfig({}), false);
  });

  it('is false (fail-soft) for non-object input', () => {
    assert.equal(packageJsonDeclaresEslintConfig(null), false);
    assert.equal(packageJsonDeclaresEslintConfig(undefined), false);
    assert.equal(packageJsonDeclaresEslintConfig('eslintConfig'), false);
    assert.equal(packageJsonDeclaresEslintConfig(['eslintConfig']), false);
    assert.equal(packageJsonDeclaresEslintConfig(42), false);
  });

  it('ignores a nested eslintConfig (top-level only)', () => {
    assert.equal(packageJsonDeclaresEslintConfig({ config: { eslintConfig: {} } }), false);
  });

  it('keeps the two detectors independent', () => {
    assert.equal(packageJsonDeclaresPrettier({ eslintConfig: {} }), false);
    assert.equal(packageJsonDeclaresEslintConfig({ prettier: {} }), false);
  });
});
