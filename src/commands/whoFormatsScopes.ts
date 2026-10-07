// Scope model of "Tidy: Who Formats This File?" (PURE: no 'vscode', no I/O).
//
// `WorkspaceConfiguration.inspect()` returns one field per scope. This module turns
// those fields into the answer to "which scope set this value?", and says so when it
// cannot be told instead of guessing.
//
// HONESTY about scopes. VS Code applies a LANGUAGE-specific value of any scope over
// every plain value (an extension's `[css]` default even beats a User setting), so the
// order below is highest first. That order is an assumption about the host, so it is
// CHECKED: a scope is named only when its value equals the effective value `get()`
// returns. Otherwise the answer is `undetermined`, with the scopes where the value
// appears.
//
// SINGLE-FOLDER WORKSPACES. Observed in a real host (1.137.0, integration test): when
// one folder is open, `inspect()` reports the folder's `.vscode/settings.json` under
// BOTH the Workspace and the Workspace Folder fields, because it is the same file.
// `foldFolderIntoWorkspace` folds the two together so that one file is never listed
// as two scopes. In a multi-root workspace they are different files and stay apart.

/** The eight per-scope fields of `WorkspaceConfiguration.inspect()`. */
export type LayerKey =
  | 'workspaceFolderLanguageValue'
  | 'workspaceLanguageValue'
  | 'globalLanguageValue'
  | 'defaultLanguageValue'
  | 'workspaceFolderValue'
  | 'workspaceValue'
  | 'globalValue'
  | 'defaultValue';

/** What `inspect()` returned, narrowed to the eight fields (absent = not set there). */
export type SettingLayers = { readonly [K in LayerKey]?: unknown };

interface LayerSpec {
  readonly key: LayerKey;
  readonly describe: (languageId: string) => string;
}

/** Highest precedence first. See the HONESTY note in the header. */
const LAYERS_HIGHEST_FIRST: readonly LayerSpec[] = [
  { key: 'workspaceFolderLanguageValue', describe: (l) => `Workspace Folder settings ([${l}] block)` },
  { key: 'workspaceLanguageValue', describe: (l) => `Workspace settings ([${l}] block)` },
  { key: 'globalLanguageValue', describe: (l) => `User settings ([${l}] block)` },
  { key: 'defaultLanguageValue', describe: (l) => `default ([${l}] block, from VS Code or an extension)` },
  { key: 'workspaceFolderValue', describe: () => 'Workspace Folder settings' },
  { key: 'workspaceValue', describe: () => 'Workspace settings' },
  { key: 'globalValue', describe: () => 'User settings' },
  { key: 'defaultValue', describe: () => 'default (VS Code or an extension)' }
];

/** One scope that holds a value, with a human label for it. */
export interface LayerValue {
  readonly key: LayerKey;
  readonly label: string;
  readonly value: unknown;
}

/** The raw outcome of reading one setting: its effective value and its per-scope values. */
export type SettingProbe =
  | {
      readonly state: 'read';
      readonly effective: unknown;
      /** Undefined when the host gave no per-scope details (old host, or `inspect` failed). */
      readonly layers: SettingLayers | undefined;
    }
  | { readonly state: 'unreadable'; readonly cause: string };

/** Where a scalar setting's effective value comes from. */
export type ScalarSource =
  | {
      readonly kind: 'layer';
      readonly winner: LayerValue;
      /** Other scopes that also hold a value (the plain built-in default is left out). */
      readonly others: readonly LayerValue[];
    }
  | { readonly kind: 'unset' }
  | {
      readonly kind: 'undetermined';
      readonly reason: string;
      readonly candidates: readonly LayerValue[];
    };

/** No value: VS Code reports an unset formatter as null, an empty string counts too. */
export function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false; // a value that cannot be serialised is never "the same" as another.
  }
}

/** Narrow an `inspect()` result to the eight scope fields. Anything else is "no details". */
export function narrowLayers(inspected: unknown): SettingLayers | undefined {
  if (inspected === null || typeof inspected !== 'object') {
    return undefined;
  }
  const source = inspected as Record<string, unknown>;
  return Object.fromEntries(
    LAYERS_HIGHEST_FIRST.filter(({ key }) => source[key] !== undefined).map(
      ({ key }) => [key, source[key]]
    )
  ) as SettingLayers;
}

/**
 * Fold the Workspace Folder fields into the Workspace fields, for a SINGLE-FOLDER
 * workspace where they are the same file (see the header). The folder value wins when
 * both are set, which is the precedence VS Code applies. PURE.
 */
export function foldFolderIntoWorkspace(layers: SettingLayers): SettingLayers {
  const { workspaceFolderValue, workspaceFolderLanguageValue, workspaceValue, workspaceLanguageValue, ...rest } = layers;
  const plain = workspaceFolderValue !== undefined ? workspaceFolderValue : workspaceValue;
  const language = workspaceFolderLanguageValue !== undefined ? workspaceFolderLanguageValue : workspaceLanguageValue;
  return {
    ...rest,
    ...(plain !== undefined ? { workspaceValue: plain } : {}),
    ...(language !== undefined ? { workspaceLanguageValue: language } : {})
  };
}

function populatedLayers(
  layers: SettingLayers,
  languageId: string
): readonly LayerValue[] {
  return LAYERS_HIGHEST_FIRST.filter(({ key }) => layers[key] !== undefined).map(
    ({ key, describe }) => ({ key, label: describe(languageId), value: layers[key] })
  );
}

const isNotBuiltInDefault = (layer: LayerValue): boolean => layer.key !== 'defaultValue';

/**
 * Name the scope a scalar setting's effective value comes from. PURE.
 *
 * The scope is named only when its value EQUALS the effective value (see the header):
 * the highest-precedence populated scope, or else the only scope that holds that
 * value. When neither is unambiguous the answer is `undetermined`, never a guess.
 */
export function resolveScalarSource(
  effective: unknown,
  layers: SettingLayers | undefined,
  languageId: string
): ScalarSource {
  if (layers === undefined) {
    return {
      kind: 'undetermined',
      reason: 'this VS Code did not return per-scope details',
      candidates: []
    };
  }
  const populated = populatedLayers(layers, languageId);
  if (populated.length === 0) {
    return isAbsent(effective)
      ? { kind: 'unset' }
      : {
          kind: 'undetermined',
          reason: 'VS Code returned a value but no scope that holds it',
          candidates: []
        };
  }

  const asLayer = (winner: LayerValue): ScalarSource =>
    winner.key === 'defaultValue' && isAbsent(effective)
      ? { kind: 'unset' }
      : {
          kind: 'layer',
          winner,
          others: populated.filter((l) => l !== winner).filter(isNotBuiltInDefault)
        };

  if (sameValue(populated[0].value, effective)) {
    return asLayer(populated[0]);
  }
  const holders = populated.filter((l) => sameValue(l.value, effective));
  if (holders.length === 1) {
    return asLayer(holders[0]);
  }
  return {
    kind: 'undetermined',
    reason:
      holders.length > 1
        ? 'the same value is set at several scopes and this VS Code does not say which one applies'
        : 'the effective value matches none of the scopes VS Code reported',
    candidates: (holders.length > 1 ? holders : populated).filter(isNotBuiltInDefault)
  };
}

/** One key of an object-typed setting (editor.codeActionsOnSave) with its scope. */
export interface KeyedEntry {
  readonly key: string;
  readonly value: unknown;
  /** Label of the scope that set this key; undefined when it could not be told. */
  readonly source: string | undefined;
}

export type KeyedSource =
  | { readonly kind: 'none' }
  | { readonly kind: 'entries'; readonly entries: readonly KeyedEntry[] }
  | { readonly kind: 'unrecognised'; readonly rendered: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Does this scope's value define `key` with `value` (object form, or legacy array form)? */
function layerDefines(layerValue: unknown, key: string, value: unknown): boolean {
  if (isPlainObject(layerValue)) {
    return Object.prototype.hasOwnProperty.call(layerValue, key) && sameValue(layerValue[key], value);
  }
  if (Array.isArray(layerValue)) {
    return value === true && layerValue.includes(key);
  }
  return false;
}

/**
 * Attribute each key of an object-typed setting to the scope that set it. Objects are
 * merged KEY BY KEY across scopes by VS Code, so one scope does not own the whole
 * value: each key is attributed on its own, again only when a scope's value matches.
 * The legacy array form (`["source.organizeImports"]`) means "run it" and is read as
 * `true`. PURE.
 */
export function resolveKeyedSources(
  effective: unknown,
  layers: SettingLayers | undefined,
  languageId: string
): KeyedSource {
  if (isAbsent(effective)) {
    return { kind: 'none' };
  }
  const pairs: ReadonlyArray<readonly [string, unknown]> = Array.isArray(effective)
    ? effective.filter((item): item is string => typeof item === 'string').map((item) => [item, true] as const)
    : isPlainObject(effective)
      ? Object.entries(effective)
      : [];
  if (pairs.length === 0) {
    return Array.isArray(effective) || isPlainObject(effective)
      ? { kind: 'none' }
      : { kind: 'unrecognised', rendered: renderValue(effective) };
  }
  const populated = layers === undefined ? undefined : populatedLayers(layers, languageId);
  const entries = [...pairs]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]): KeyedEntry => ({
      key,
      value,
      source: populated?.find((layer) => layerDefines(layer.value, key, value))?.label
    }));
  return { kind: 'entries', entries };
}


const MAX_RENDERED_VALUE = 80;

/** A setting value as it would be typed in settings.json, single line and bounded. */
export function renderValue(value: unknown): string {
  if (value === undefined) {
    return '(unset)';
  }
  try {
    const text = JSON.stringify(value) ?? '(unprintable)';
    return text.length > MAX_RENDERED_VALUE ? `${text.slice(0, MAX_RENDERED_VALUE - 3)}...` : text;
  } catch {
    return '(unprintable)';
  }
}