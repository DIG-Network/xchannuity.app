# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org) and
[Conventional Commits](https://www.conventionalcommits.org).

## [0.1.0] - 2026-07-04

### Features
- Offer file compatibility- **app:** Luxury redesign + favicons/og + XCH picker entry; xch-via-cmojo spec+plan- **app:** Integrate cmojo-core wasm + lib/cmojo.ts- **app:** Atomic XCH wrap+create annuity- **app:** XCH claim auto-melts claimed cMOJO to XCH- **recovery:** Fallback widget to convert stranded cMOJO to XCH- **backup:** .xchannuity backup/import per annuity- **backup:** Explain backup in a modal before downloading

### Bug Fixes
- **app:** XCH claim→melt reconstructed wrong payout amount (UNKNOWN_UNSPENT)- **claim:** Discover claimed cMOJO coin from node before melt- **clawback:** Auto-melt the issuer's reclaimed cMOJO to XCH- **walletconnect:** Use absolute icon URL so Sage shows the logo

### Refactor
- **core:** Extract StreamLayer with SDK Layer impl- **core:** Move owner + clawback helpers into layer modules- **core:** Introduce composition module (puzzle/spend/discovery)- **core:** Parse discovery via composed CatLayer<StreamLayer>- **core:** Drop compat shims, use canonical layer paths

### Documentation
- Add driver layer-composition spec + implementation plan- STATUS reflects layer-composed driver structure- Add proper README

### CI
- Enforce version increment in PRs (package.json / Cargo.toml)- Enforce Conventional Commits with commitlint on PRs- Enforce Conventional Commits with commitlint on PRs- Release automation + auto-publish on version tag (#230 auto-publish-everything)

### Chores
- **changelog:** Add git-cliff config for Conventional-Commit changelog


