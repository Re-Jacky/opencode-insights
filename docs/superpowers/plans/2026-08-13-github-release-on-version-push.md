# Auto GitHub Release on Version Push — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `.github/workflows/publish.yml` so that whenever a new package version is pushed to `main`/`master`, the workflow also creates a GitHub Release (tag `v<version>`, title `v<version>`) whose notes summarize changes since the previous `v*` tag and link the npm package page.

**Architecture:** One task, one file. The existing "Check whether version is already published" step gains a `release_exists` output (via `gh release view`); a new "Create GitHub Release" step after `Publish` runs when the version is new OR the release is missing (idempotent rerun recovery), builds Markdown notes from `git log` grouped by conventional-commit prefix, and calls `gh release create`. No artifacts are attached.

**Tech Stack:** GitHub Actions (YAML), bash, `gh` CLI (preinstalled on `ubuntu-latest`), `git`.

## Global Constraints

(from `docs/superpowers/specs/2026-08-13-github-release-on-version-push-design.md`)

- Trigger unchanged: push to `main`/`master` with the existing path filter; release only when the version is genuinely new.
- `permissions.contents` changes `read` → `write`; `id-token: write` stays.
- Tag and release title are `v<version>`; published immediately, never a draft.
- Notes: sections `## New Features` (feat:), `## Bug Fixes` (fix:), `## Other` (everything else); subjects prefix-stripped and whitespace-trimmed; `Release <version>` commits and merges excluded; footer line always present:
  `Published to npm: https://www.npmjs.com/package/<name>`
- No previous `v*` tag ⇒ list full history (first release).
- Release step condition: `should_publish == 'true'` **or** `release_exists == 'false'`; step internally skips if the release already exists.

---

### Task 1: Extend `publish.yml` with the GitHub Release step

**Files:**
- Modify: `.github/workflows/publish.yml` (permissions block; "Check whether version is already published" step; new step after `Publish`)

**Interfaces:**
- Consumes: nothing (standalone change).
- Produces: workflow behavior — a `v<version>` GitHub Release with auto-generated notes on each new version push.

- [ ] **Step 1: Validate the notes-generation script locally**

Write the following script to `/tmp/release-notes.sh` (or any temp location **outside the repo** — it is a prototype, not a project file) and run it:

```bash
#!/usr/bin/env bash
set -euo pipefail

package_name=$(node -p "require('./package.json').name")
package_version=$(node -p "require('./package.json').version")

previous_tag=$(git tag --sort=-v:refname --format='%(refname:short)' | grep -E '^v[0-9]' | grep -v "^v${package_version}$" | head -1 || true)
if [ -n "$previous_tag" ]; then
  log_range="${previous_tag}..HEAD"
else
  log_range="HEAD"
fi

strip_prefix() {
  local s="$1"
  case "$s" in
    feat:*) s="${s#feat:}" ;;
    fix:*) s="${s#fix:}" ;;
    docs:*) s="${s#docs:}" ;;
    test:*) s="${s#test:}" ;;
    style:*) s="${s#style:}" ;;
    chore:*) s="${s#chore:}" ;;
    refactor:*) s="${s#refactor:}" ;;
  esac
  s="${s#"${s%%[![:space:]]*}"}"
  printf '%s' "$s"
}

build_section() {
  local name="$1"
  local items="$2"
  if [ -z "$items" ]; then
    return 0
  fi
  printf '\n## %s\n%s' "$name" "$items"
}

features=""
fixes=""
other=""
while IFS= read -r subject; do
  case "$subject" in
    feat:*) features+="- $(strip_prefix "$subject")"$'\n' ;;
    fix:*) fixes+="- $(strip_prefix "$subject")"$'\n' ;;
    Release*) ;;
    *) other+="- $(strip_prefix "$subject")"$'\n' ;;
  esac
done < <(git log --no-merges --pretty=format:%s "$log_range")

notes="# Release v${package_version}"
notes+="$(build_section "New Features" "$features")"
notes+="$(build_section "Bug Fixes" "$fixes")"
notes+="$(build_section "Other" "$other")"
notes+=$'\n\n---\nPublished to npm: https://www.npmjs.com/package/'"${package_name}"

printf '%s\n' "$notes"
```

Run (from the repo root, so `git` sees the real history):

```bash
bash /tmp/release-notes.sh
```

Expected: three sections (`## New Features`, `## Bug Fixes`, `## Other`) with `- ` bullets, no leading whitespace after the bullet (i.e. `- revert-debug command…`, never `-  revert-debug…`), no `Release 0.x.y` lines, no merge commits, and the final line `Published to npm: https://www.npmjs.com/package/@rejacky/opencode-insights`. With the current repo state (tags stop at `v0.1.9`) the diff covers `v0.1.9..HEAD` — 50 commits — which is the accepted one-time tradeoff.

If the output matches, proceed. This prototype's logic is copied verbatim into the workflow step in Step 3 (with `package_name`/`package_version` from step outputs instead of `node -p`).

- [ ] **Step 2: Edit `publish.yml` — permissions and `release_exists` output**

Change the `permissions` block (lines 22-24):

```yaml
permissions:
  contents: write
  id-token: write
```

Then replace the entire "Check whether version is already published" step (current lines 46-63) with:

```yaml
      - name: Check whether version is already published
        id: published
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          package_name=$(node -p "require('./package.json').name")
          package_version=$(node -p "require('./package.json').version")
          published_version=$(npm view "${package_name}@${package_version}" version 2>/dev/null || true)
          tag="v${package_version}"
          if gh release view "${tag}" --json tagName >/dev/null 2>&1; then
            release_exists=true
          else
            release_exists=false
          fi

          echo "package_name=${package_name}" >> "$GITHUB_OUTPUT"
          echo "package_version=${package_version}" >> "$GITHUB_OUTPUT"
          echo "release_exists=${release_exists}" >> "$GITHUB_OUTPUT"

          if [ "$published_version" = "$package_version" ]; then
            echo "should_publish=false" >> "$GITHUB_OUTPUT"
            echo "${package_name}@${package_version} is already published; skipping."
          else
            echo "should_publish=true" >> "$GITHUB_OUTPUT"
            echo "${package_name}@${package_version} is not published yet; publishing."
          fi
```

(`gh release view` returns exit 1 when the release does not exist, which inside an `if` condition does not trip `set -e`.)

- [ ] **Step 3: Add the "Create GitHub Release" step**

Append after the existing `Publish` step (line 65-67):

```yaml
      - name: Create GitHub Release
        if: steps.published.outputs.should_publish == 'true' || steps.published.outputs.release_exists == 'false'
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          package_name="${{ steps.published.outputs.package_name }}"
          package_version="${{ steps.published.outputs.package_version }}"
          tag="v${package_version}"

          if gh release view "${tag}" --json tagName >/dev/null 2>&1; then
            echo "Release ${tag} already exists; skipping."
            exit 0
          fi

          previous_tag=$(git tag --sort=-v:refname --format='%(refname:short)' | grep -E '^v[0-9]' | grep -v "^${tag}$" | head -1 || true)
          if [ -n "$previous_tag" ]; then
            log_range="${previous_tag}..HEAD"
          else
            log_range="HEAD"
          fi

          strip_prefix() {
            local s="$1"
            case "$s" in
              feat:*) s="${s#feat:}" ;;
              fix:*) s="${s#fix:}" ;;
              docs:*) s="${s#docs:}" ;;
              test:*) s="${s#test:}" ;;
              style:*) s="${s#style:}" ;;
              chore:*) s="${s#chore:}" ;;
              refactor:*) s="${s#refactor:}" ;;
            esac
            s="${s#"${s%%[![:space:]]*}"}"
            printf '%s' "$s"
          }

          build_section() {
            local name="$1"
            local items="$2"
            if [ -z "$items" ]; then
              return 0
            fi
            printf '\n## %s\n%s' "$name" "$items"
          }

          features=""
          fixes=""
          other=""
          while IFS= read -r subject; do
            case "$subject" in
              feat:*) features+="- $(strip_prefix "$subject")"$'\n' ;;
              fix:*) fixes+="- $(strip_prefix "$subject")"$'\n' ;;
              Release*) ;;
              *) other+="- $(strip_prefix "$subject")"$'\n' ;;
            esac
          done < <(git log --no-merges --pretty=format:%s "$log_range")

          notes="# Release v${package_version}"
          notes+="$(build_section "New Features" "$features")"
          notes+="$(build_section "Bug Fixes" "$fixes")"
          notes+="$(build_section "Other" "$other")"
          notes+=$'\n\n---\nPublished to npm: https://www.npmjs.com/package/'"${package_name}"

          gh release create "${tag}" --title "${tag}" --notes "${notes}"
```

Notes on behavior:
- `gh release create` creates the tag `v<version>` automatically when missing; if the tag exists (rare partial failure) it reuses it.
- Step condition covers the rerun case: version already on npm but release missing (previous run failed after publish) → step runs, `npm publish` step stays skipped.
- `--no-merges` and the `Release*)` case keep the notes free of merge commits and `Release <version>` marker commits; `strip_prefix` removes conventional-commit prefixes (feat:/fix:/docs:/test:/style:/chore:/refactor:) and trims whitespace so bullets render `- subject` with a single space.

- [ ] **Step 4: Validate YAML and run the release gate**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/publish.yml')); print('yaml ok')"
```

Expected: `yaml ok` (PyYAML parses `on:` as a boolean key — that is fine, it still proves the file is syntactically valid).

```bash
npm run verify
```

Expected: typecheck + 157 tests + build all pass (workflow-only change; gate stays green).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/publish.yml
git commit -m "ci: create GitHub release with changelog notes on version push"
```

Do **not** push — the release flow runs on the next real version push.
