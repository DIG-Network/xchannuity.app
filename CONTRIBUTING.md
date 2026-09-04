# Contributing to xchannuity.app

Thanks for your interest in improving xchannuity.app. This project is a dApp built on the DIG Network and Chia blockchain — please read this before opening a PR.

## Reporting an issue

File it at [github.com/DIG-Network/xchannuity.app/issues](https://github.com/DIG-Network/xchannuity.app/issues) with:

- what you observed vs. what you expected,
- steps to reproduce,
- the environment (browser/OS/version if applicable).

## Prerequisites

- **Node >= 18** (the package's declared minimum).

## Local development

```bash
# Install dependencies
npm install

# Verify the code
npm run typecheck    # if available
npm run lint         # if available
npm run test         # if available
npm run build        # if available

# Run the dev server (if available)
npm run dev
```

See `package.json` for the actual available scripts in this project.

## Version increment

When opening a PR, bump `package.json`'s `version` to reflect the change (patch/minor/major):
- **patch** — compatible bug fix or docs-only change
- **minor** — compatible new feature or addition
- **major** — breaking change (removed/renamed API, incompatible behavior)

After bumping, run `npm install --package-lock-only` to update `package-lock.json`.

## Commit conventions

Use clear, imperative commit subjects. If the project uses Conventional Commits (checked by CI), follow this format: `type(scope): summary`, where
`type` is one of `feat|fix|docs|style|refactor|perf|test|build|ci|chore`. A breaking change appends `!` and/or a `BREAKING CHANGE:` footer.

## Pull requests

1. Branch from `main`.
2. Verify the changes work locally (build, tests, any relevant scripts).
3. Bump `package.json`'s `version` (patch/minor/major per the change).
4. Run `npm install --package-lock-only` to update the lock.
5. Open a PR with a clear description of what changed and why.
6. Resolve every review thread. On merge, the release workflow publishes the version.

## License

Proprietary — see `LICENSE`.

