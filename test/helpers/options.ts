// Test helper: build a minimal ResolvedOptions for engine calls without going
// through the (vscode-dependent) provider layer. Pure — no host required.
import type { ResolvedOptions } from '../../src/types';

export function resolved(overrides: Partial<ResolvedOptions> = {}): ResolvedOptions {
  return {
    tabSize: 2,
    insertSpaces: true,
    engineOptions: {},
    sources: {},
    ...overrides
  };
}
