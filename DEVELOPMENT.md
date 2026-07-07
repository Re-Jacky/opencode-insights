# Development

Notes for maintaining and publishing `opencode-insights`.

## Local Testing

From this repo:

```bash
cd /Users/zyao/Desktop/opencode-insights
npm install
npm run verify
npm pack
```

Install the packed plugin from your OpenCode config/package directory:

```bash
cd ~/.config/opencode
npm i /Users/zyao/Desktop/opencode-insights/rejacky-opencode-insights-*.tgz
npx opencode-insights configure
```

For local repo development without relying on the installed package binary:

```bash
node /Users/zyao/Desktop/opencode-insights/dist/cli.js configure --config-dir ~/.config/opencode
```

Restart OpenCode after reinstalling or rebuilding. Existing sessions will not gain missing events retroactively, so create a new session to test capture changes.

## Faster Local Iteration

Link instead of packing each time:

```bash
cd /Users/zyao/Desktop/opencode-insights
npm link

cd ~/.config/opencode
npm link @rejacky/opencode-insights
```

After code changes:

```bash
cd /Users/zyao/Desktop/opencode-insights
npm run build
node /Users/zyao/Desktop/opencode-insights/dist/cli.js configure --config-dir ~/.config/opencode
```

## Verification

Run all checks:

```bash
npm run verify
```

Individual commands:

```bash
npm run typecheck
npm test
npm run build
```

## Automated npm Publishing

The repo publishes from GitHub Actions when `package.json` is pushed to `main` or `master` with a version that is not already on npm.

One-time npm setup:

1. Go to npm package settings for `@rejacky/opencode-insights`.
2. Open the package publishing / trusted publishing settings.
3. Add a trusted publisher for this GitHub repository.
4. Use workflow file `.github/workflows/publish.yml`.
5. Keep the package public.

No `NPM_TOKEN` secret is needed when npm trusted publishing is configured. The workflow uses GitHub OIDC plus `npm publish --provenance`.

Release flow:

```bash
git status
npm version patch
git push --follow-tags
```

Use `npm version minor` or `npm version major` for larger releases. The workflow will run verification first, skip publishing if that exact version already exists, and publish only unpublished versions.

Manual fallback:

```bash
npm run verify
npm pack --dry-run
npm publish --access public --provenance
```

## Manual Publish Checklist

Review package contents:

```bash
npm pack
tar -tf rejacky-opencode-insights-0.1.1.tgz
```

Publish manually if GitHub Actions is unavailable:

```bash
npm login
npm publish --access public --provenance
```

After publishing, users should be able to install from their OpenCode config/package directory with:

```bash
cd ~/.config/opencode
npm i @rejacky/opencode-insights
npx opencode-insights configure
```
