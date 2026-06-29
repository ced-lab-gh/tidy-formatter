# Publishing Guide — Tidy Formatter

This guide explains how a maintainer publishes **Tidy Formatter** to both the
**Visual Studio Marketplace** and **Open VSX** (the open registry used by Cursor,
Windsurf, VSCodium, Gitpod, code-server, and other VS Code forks).

Publishing is automated by [`.github/workflows/release.yml`](.github/workflows/release.yml):
**push a `v*` tag and the workflow packages the extension and publishes it to
whichever registries have a token configured.** No manual upload is required for
the normal path.

> **You never need real secrets in this repository.** Tokens live only in GitHub
> Actions secrets (or, for the local fallback, in your own shell environment).
> Never commit a token to git.

---

## 0. Identifiers (do not change casually)

| Field        | Value                          |
| ------------ | ------------------------------ |
| Extension id | `tidy-formatter`               |
| Publisher    | `ced-lab`                      |
| Full id      | `ced-lab.tidy-formatter`       |
| Namespace    | `ced-lab` (same on both registries) |

The publisher / namespace are effectively **irreversible** once the first version
is published. Confirm name availability on **both** registries before the first
publish.

---

## 1. One-time setup

You only do this section once (per registry).

### 1.1 VS Marketplace publisher + Personal Access Token (PAT)

1. Create (or sign in to) an **Azure DevOps** organization:
   <https://dev.azure.com>.
2. Create a **Marketplace publisher** with id `ced-lab`:
   <https://marketplace.visualstudio.com/manage>.
3. Generate a **Personal Access Token**:
   - User settings → **Personal Access Tokens** → **New Token**.
   - **Organization:** *All accessible organizations*.
   - **Scopes:** *Custom defined* → **Marketplace → Manage**.
   - Set a sensible expiry and **copy the token now** (it is shown once).
4. (Optional, recommended) Verify the token locally before trusting CI:
   ```bash
   npx @vscode/vsce verify-pat ced-lab -p "<YOUR_VSCE_PAT>"
   ```

This token is your **`VSCE_PAT`**.

### 1.2 Open VSX account, Eclipse Publisher Agreement + namespace

1. Sign in to <https://open-vsx.org> with GitHub.
2. Go to your **profile settings** and **sign the Eclipse Foundation Publisher
   Agreement** (required before you can publish anything to Open VSX).
3. Generate an **Access Token** from your Open VSX profile and copy it.
4. Create the namespace once (the token's owner becomes its owner):
   ```bash
   npx ovsx create-namespace ced-lab -p "<YOUR_OVSX_PAT>"
   ```

This token is your **`OVSX_PAT`**.

### 1.3 Add the tokens as GitHub Actions secrets

In the GitHub repository:

**Settings → Secrets and variables → Actions → New repository secret**

| Secret name | Value                              |
| ----------- | ---------------------------------- |
| `VSCE_PAT`  | the Azure DevOps PAT from step 1.1 |
| `OVSX_PAT`  | the Open VSX token from step 1.2   |

> **Either secret may be omitted.** The release workflow publishes only to the
> registries whose secret is present and **skips the other cleanly** (the run
> still succeeds and still uploads the `.vsix` artifact). This means you can:
> - configure only `OVSX_PAT` to publish to Open VSX alone, or
> - configure neither and push a tag to get a packaged, downloadable `.vsix`
>   without publishing anywhere (a dry/staging run).

---

## 2. Publishing a release (the normal path)

1. Bump `version` in `package.json` (follow [SemVer](https://semver.org/)).
2. Add a dated entry to [`CHANGELOG.md`](CHANGELOG.md).
3. Commit, then create and push a matching tag:
   ```bash
   git commit -am "release: vX.Y.Z"
   git tag vX.Y.Z          # the tag MUST match package.json "version"
   git push origin main --tags
   ```
4. The **Release** workflow runs: install → compile → unit tests →
   integration tests → package → conditional publish to each registry →
   upload the `.vsix` artifact.
5. Verify:
   - Marketplace: <https://marketplace.visualstudio.com/items?itemName=ced-lab.tidy-formatter>
   - Open VSX: `npx ovsx get ced-lab.tidy-formatter`

### Pre-release / beta tags

Tags such as `vX.Y.Z-rc.1` or `vX.Y.Z-beta.1` follow the same flow. To publish a
build to the editors' "Pre-Release" channel, add `--pre-release` to the publish
commands (and document the intent in the CHANGELOG).

---

## 3. Local fallback (manual publish)

Use this only if GitHub Actions is unavailable. Run everything from this
directory. **Never** paste a token into a file or commit it — export it in your
shell instead.

```bash
# 1. Install, build, and package.
npm ci
npm run compile
npm test
npx @vscode/vsce package --no-dependencies -o tidy-formatter.vsix

# 2. Publish to VS Marketplace.
#    Either log in once (interactive) and then `vsce publish`,
#    or pass the token inline:
export VSCE_PAT="<YOUR_VSCE_PAT>"
npm run publish:vsce            # = vsce publish   (uses the same .vsix workflow)
#   or, against the already-built package:
npx @vscode/vsce publish -p "$VSCE_PAT" --packagePath tidy-formatter.vsix

# 3. Publish to Open VSX.
export OVSX_PAT="<YOUR_OVSX_PAT>"
npm run publish:ovsx            # = ovsx publish
#   or, against the already-built package:
npx ovsx publish tidy-formatter.vsix -p "$OVSX_PAT"
```

> `npm run publish:vsce` and `npm run publish:ovsx` are thin aliases for
> `vsce publish` / `ovsx publish` defined in `package.json`. They pick up the
> `VSCE_PAT` / `OVSX_PAT` environment variables automatically.

---

## 4. Token hygiene

- Tokens are **secrets** — store them only in GitHub Actions secrets or a local
  secret manager; never in the repo, never in a commit message.
- Set an **expiry** on every token and rotate before it lapses.
- If a token is ever exposed, **revoke it immediately** at its source (Azure
  DevOps / Open VSX) and issue a new one.
- The Azure DevOps PAT model is being retired in favour of Entra ID; track the
  Marketplace deprecation timeline and migrate the auth method when required.
