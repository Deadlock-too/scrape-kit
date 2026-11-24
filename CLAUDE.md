# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`scrape-kit` is a TypeScript library published to npm as `@deadlock-too/scrape-kit`: the shared toolkit behind Stefan's scraper libraries (metacritic-ts, howlongtobeat-ts, justwatch-ts) — the retrying fetch client, title matching, and the result and failure model they all return. A change here reaches them only after it is released and each of them bumps its dependency, so a change to anything `src/index.ts` exports is a change to four public APIs, not one.

Tasks for this library live in Index (index.ppt.fyi), Stefan's project manager, and not in this repository.

## Commands

```bash
npm run lint           # eslint
npm run format:check   # prettier --check; npm run format rewrites
npm run test:coverage  # the unit tests, as CI runs them (npm test without coverage)
npm run build          # tsdown: the ESM and CommonJS builds in dist/
npx changeset          # write the changeset a release needs (below)
```

Before opening a pull request, run what `.github/workflows/ci.yml` runs — lint, format check, unit tests with coverage, build — and say in the description that it passed.

## Releases

**Releases are changesets, and nothing is published by hand.** A change that should reach npm carries a changeset in the same pull request: `npx changeset`, choosing `patch`, `minor` or `major` by what the change does to the public API, with a summary written for someone reading the changelog. When that merges, `.github/workflows/release.yml` opens or updates the "Version Packages" pull request, and merging _that_ one bumps `version`, writes `CHANGELOG.md` and publishes to npm through trusted publishing (OIDC, no token). So never run `npm publish` or `changeset publish`, and never edit `version` or `CHANGELOG.md` yourself. A change that does not touch what the package ships — tests, CI, this file — needs no changeset.

## Git

**Git follows the rules Index sends.** How a branch is named, how a pull request is opened and described, whose commits they are, what a commit message says and how a rewrite keeps its dates are written once, in the instructions the Index MCP server gives every agent connected to it (they are written down in Index's own repository), so that the owner's repositories cannot drift apart again: the branch named after the task's key (`feat/k3m9qa-login-github`), a pull request the owner merges with "Rebase and merge", the owner as author and committer with one `Co-Authored-By` trailer and no link, English commit messages, a description with no link to the session. An agent without Index connected asks the owner before its first commit. What follows is only what this repository adds to them.

**What this repository adds to them.** The "Version Packages" pull request is the owner's to merge too, like every other. The owner's address is the one on the owner's own commits, `git log --author='^Deadlock-too <' -1 --format='%an <%ae>'`, not the `users.noreply.github.com` address a merge on GitHub records, and the older commits in this history authored by `Claude` are what the rule replaced, not a precedent. A pull request's description follows `.github/pull_request_template.md`, and says that what `.github/workflows/ci.yml` runs passed.

**Commit titles follow the history: `type: summary`** (`feat`, `fix`, `test`, `ci`, `docs`, `chore`), in the imperative. Never commit with `--no-verify`.
