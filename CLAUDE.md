# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`scrape-kit` is a TypeScript library published to npm as `@deadlock-too/scrape-kit`: the shared toolkit behind Stefan's scraper libraries (metacritic-ts, howlongtobeat-ts, justwatch-ts) — the retrying fetch client, title matching, and the result and failure model they all return. A change here reaches them only after it is released and each of them bumps its dependency, so a change to anything `src/index.ts` exports is a change to four public APIs, not one.

Ideas for this library live in Index (index.ppt.fyi), Stefan's project manager, and not in this repository.

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

**Work reaches `main` through a pull request, and the owner merges it.** An agent working in this repository commits on a branch of its own, pushes that branch, and opens a pull request against `main`: it never pushes to `main`, and it never merges a pull request, its own or the "Version Packages" one included. The branch is named `<type>/<id>-<slug>`: `feat`, `fix`, `chore`, `docs` or `deps` for the type, the id of the Index idea it implements, and a few words of the idea's title in kebab-case (`feat/12-login-github`). Work with no idea behind it drops the id (`chore/node-24`). The name is the owner's standing instruction and overrides the `claude/…` branch a session is started on: create the named branch from `origin/main` before the first commit. One branch holds one piece of work. Its description says what changed and how it was verified. Work that comes from an idea in Index is linked to it with the MCP tool `link_pull_request` as soon as the pull request exists, so the merge closes the idea.

**The owner merges with "Rebase and merge".** GitHub replays the branch onto `main` keeping each commit's author and author date, and the branch is deleted after the merge.

**Every commit is the owner's.** The author _and_ the committer of every commit on the branch are the owner, `Deadlock-too`, with the address of the owner's own commits (`git log --author='^Deadlock-too <' -1 --format='%an <%ae>'`, not the `users.noreply.github.com` address a merge on GitHub records) — older commits in this history authored by `Claude` are the thing this rule replaced, not a precedent. The only acknowledgement an agent gets is a `Co-Authored-By` trailer naming the model and nothing else: no session URL, no harness name. A harness may export `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL`, which beat `.git/config`, so committing as the owner may take `env -u` on all four `GIT_*` identity variables plus an explicit `--author=`; and a global `commit.gpgsign=true` signs with a key that is not the owner's, so turn it off in the clone (`git config commit.gpgsign false`).

**Commit titles follow the history: `type: summary`** (`feat`, `fix`, `test`, `ci`, `docs`, `chore`), in the imperative. **A paragraph in a commit message is one line, however long** — no hard wrapping, since `git log` and GitHub reflow a body themselves. Never commit with `--no-verify`. A history rewrite keeps each commit's original timestamps: `git rebase --committer-date-is-author-date`, and compare `git log --format='%h %aI %cI %s'` before and after.
