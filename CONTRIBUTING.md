# Contributing

Thanks for your interest! Issues and pull requests are welcome.

## Setup

Requires Node.js 22 or newer.

```sh
npm ci
npm run typecheck
npm run lint
npm test
```

`npm run smoke` checks the live SMARD API (sends a few dozen requests to smard.de; please do not
run it in a loop).

## Guidelines

- Keep pull requests small and focused; add or update tests in `test/`. Tests use an in-memory
  imitation of SMARD (`test/fake-smard.ts`), never the live API.
- Times are always Europe/Berlin; think about DST switch days (23 and 25 hours).
- New SMARD series: check the id against SMARD's module configuration
  (`https://www.smard.de/app/chart_configuration/market_data_configuration.json`) and, where the
  meaning is not obvious, against SMARD's CSV export. Note how you verified it in the pull request.
- Output fields are part of the public interface. After 1.0, renaming or removing a field is a
  breaking change and needs a new major version.
- Tool texts and the README are in English; prompts are in German.

## Releases

Maintainers only: update `CHANGELOG.md` and the version in `package.json`, then tag `vX.Y.Z`.
The release workflow publishes to npm.
