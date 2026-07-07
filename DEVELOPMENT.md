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
npm i /Users/zyao/Desktop/opencode-insights/opencode-insights-0.1.0.tgz
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
npm link opencode-insights
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

## Publish Checklist

Before publishing:

```bash
npm run verify
npm pack --dry-run
```

Review package contents:

```bash
npm pack
tar -tf opencode-insights-0.1.0.tgz
```

Publish:

```bash
npm login
npm publish --access public
```

After publishing, users should be able to install from their OpenCode config/package directory with:

```bash
cd ~/.config/opencode
npm i opencode-insights
npx opencode-insights configure
```
