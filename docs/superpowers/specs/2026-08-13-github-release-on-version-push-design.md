# GitHub Release on Version Push — Design

Date: 2026-08-13

## Goal

Automatically create a GitHub Release whenever a new package version is pushed to
`main`/`master`. No artifacts are attached; the release note explains what
changed since the last release and links the npm package page.

## Trigger

Unchanged from today: push to `main` or `master` touching relevant paths
(`package.json`, `src/**`, `test/**`, etc. — the existing path filter in
`.github/workflows/publish.yml`). The release is only created when the version is
genuinely new, reusing the existing `should_publish` check from the workflow's
"Check whether version is already published" step.

## Changes to `.github/workflows/publish.yml`

### 1. Permissions

`contents: read` → `contents: write` so the workflow can create the git tag and
release. `id-token: write` stays for npm provenance.

### 2. Version check step — add `release_exists` output

The existing "Check whether version is already published" step also emits
`release_exists` (`true`/`false`) for tag `v<version>` via `gh release view
v<version> --json tagName`. `package_name` and `package_version` outputs are
reused.

### 3. New "Create GitHub Release" step (after `Publish`)

Runs when `should_publish == 'true'` **or** `release_exists == 'false'`. The
second condition covers the rerun case where npm publish succeeded but release
creation failed on a previous run — the step re-creates the missing release
without re-publishing npm.

Step logic:

1. Compute the previous tag: the newest `v*` tag excluding the current version
   (`git tag --sort=-v:refname`). If none exists, fall back to all commits (first
   release).
2. Build release notes in bash:
   - `git log --oneline <previous-tag>..HEAD` (or full history when there is no
     previous tag), filtered to the current branch's commits reachable from HEAD.
   - Group by conventional-commit prefix and render as Markdown sections, in
     `git log` order within each group:

     | Prefix | Section |
     |---|---|
     | `feat:` | `## New Features` |
     | `fix:` | `## Bug Fixes` |
     | anything else (style:, chore:, docs:, …) | `## Other` |

     Commit subjects are cleaned (prefix stripped, leading whitespace trimmed).
   - Footer line, always present:
     `Published to npm: https://www.npmjs.com/package/@rejacky/opencode-insights`
3. Create the release:
   - `gh release create v<version> --title "v<version>" --notes "<notes>"` —
     tag `v<version>` is created automatically, matching the existing tag
     convention (`v0.1.6` … `v0.1.9`).
   - Published immediately, not a draft.
   - The tag `v<version>` is created by `gh release create` when missing; if the
     tag already exists, the release is created pointing at it.
4. Guard: if `gh release view v<version>` already exists, skip (idempotent
   reruns).

## Edge Cases

- **No previous `v*` tag** — first release lists full history. Current repo state
  (tags stop at `v0.1.9`) means the first auto-release (v0.3.1) lists everything
  since `v0.1.9`, including untagged 0.2.x/0.3.0 work. Accepted one-time
  tradeoff.
- **npm published but release step failed** — rerun re-creates the release
  (`release_exists` false) without re-publishing npm.
- **Release exists but version not published** (shouldn't happen normally) — step
  is skipped because `should_publish` is false and `release_exists` is true.
- **Tag exists but release missing** (rare partial failure) — `release_exists`
  is false, so the step runs; `gh release create` reuses the existing tag.
- **Non-version pushes** — step does not run (both conditions false).

## Verification

- Run the notes-generation bash snippet locally against real history
  (`git log v0.1.9..HEAD`) and inspect the rendered Markdown.
- `npm run verify` (workflow change only touches `.github/`, so source tests are
  unaffected, but the gate must stay green).
- Manual smoke test: `gh workflow run` with `workflow_dispatch` on a scratch
  branch is out of scope; the first real run happens at the 0.3.1 push.

## Out of Scope

- Release artifacts (draft/asset upload) — none.
- Draft-then-edit flow — releases are published immediately.
- Changelog file maintenance (CHANGELOG.md) — notes come from commit history.
- Tagging historical versions (0.2.x, 0.3.0) retroactively — the diff against
  v0.1.9 is accepted as-is.
