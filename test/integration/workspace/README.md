# Integration test workspace

This folder is opened as the `workspaceFolder` by the headless lifecycle tests
(`.vscode-test.mjs` → `test/integration/lifecycle.test.ts`, SPEC QA-04).

Tests write throwaway fixtures under `lifecycle/` at runtime (real on-disk URIs
are needed to exercise the save lifecycle). Those generated files are ignored
via `.gitignore`. Keep this folder otherwise empty so the workspace settings
start from a clean slate and config-precedence assertions are deterministic.
