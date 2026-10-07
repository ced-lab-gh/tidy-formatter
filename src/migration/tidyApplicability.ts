// Where a `tidy.*` setting REALLY applies (v0.5.0, MIGRATION): the Tidy side of the
// question "may the migration write `"[language]": { "<key>": ... }`?". The
// incumbent's side is lonefySections.ts.
//
// A language-scoped write for a setting that does nothing in that language is noise
// in the user's settings and a small lie in the recap, so a key is written for a
// language only when BOTH hold:
//   1. the option catalogue (src/config/optionCatalog.ts, the single source of truth
//      for every `tidy.*` option, and the place the C-14 work restricts the languages
//      of the blank-line options) declares the setting for that language. Reading it
//      at run time means the migration follows the catalogue when it changes, and a
//      key the catalogue does not know is never written at all;
//   2. the pair is not on the short list below of settings the catalogue still
//      declares for a language whose engine does not consume them.
//
// PURE: no 'vscode'.
import {
  appliesToLanguage,
  findBySettingKey,
  type CatalogLang
} from '../config/optionCatalog';
import type { LangId } from '../types';

/**
 * Settings the catalogue declares for a language but whose engine does not read them
 * there. Each entry cites the code that proves it, and the behavioural unit test
 * (lonefyHonoured.test.ts) fails if an entry is missing or stale.
 *
 *   json  tidy.wrap_line_length : src/engine/jsonFormatter.ts ("NOT consumed, on
 *         purpose: preserve_newlines, max_preserve_newlines, indent_empty_lines and
 *         wrap_line_length"); JSON is pretty-printed by jsonc-parser, which cannot
 *         wrap, and the option's own description says "It has no effect on JSON".
 */
const DECLARED_BUT_INERT: Readonly<Record<string, readonly string[]>> = {
  json: ['tidy.wrap_line_length']
};

/**
 * Whether the migration may write `settingKey` in the `[language]` block: the
 * catalogue declares it for that language and it is not a known-inert pair.
 */
export function tidySettingAppliesTo(settingKey: string, language: LangId): boolean {
  const entry = findBySettingKey(settingKey);
  if (entry === undefined) {
    return false;
  }
  if (!appliesToLanguage(entry, language as CatalogLang)) {
    return false;
  }
  const inert = DECLARED_BUT_INERT[language];
  return inert === undefined || !inert.includes(settingKey);
}
