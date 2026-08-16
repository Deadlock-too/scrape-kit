# @deadlock-too/scrape-kit

## 1.1.0

### Minor Changes

- [#1](https://github.com/Deadlock-too/scrape-kit/pull/1) [`afe8944`](https://github.com/Deadlock-too/scrape-kit/commit/afe8944c2e1624ad7719aabe08aa12df20422c04) Thanks [@Deadlock-too](https://github.com/Deadlock-too)! - Add a machine-readable failure discriminator so consumers can tell an outage from a broken scraper

  `Failure` previously carried only `error: string`, which left a consumer with nothing to branch on: a refused connection, a 403 from the source and a response the parser could not read all arrived as prose, and telling them apart meant matching on message wording that is free to change in a patch release.

  Failures now carry an optional `kind`, and HTTP failures carry the `status`:

  ```ts
  type FailureKind = 'input' | 'transport' | 'timeout' | 'aborted' | 'http' | 'parse' | 'notFound' | 'unknown'
  type Failure = { success: false; error: string; kind?: FailureKind; status?: number }
  ```

  `transport`, `timeout` and `http` say the source is unavailable or unhappy; `parse` says the scraper itself needs fixing; `notFound` says nothing is wrong at all and the source simply has no such record. Those are the distinctions the type exists to make.

  New and changed API:

  - `FailureKind`, and `kind` / `status` on `Failure`.
  - `fail(message, options?)` — accepts `{ kind, status }`. Both are omitted from the returned object when not supplied, so `fail('boom')` still produces exactly `{ success: false, error: 'boom' }`.
  - `ScraperError` gains a readonly `kind`, defaulting to `'parse'`. Every existing `new ScraperError(message)` keeps its current meaning; the field exists so the classification survives the throw instead of being re-derived from message text at the catch site.
  - `HttpError extends ScraperError` — carries `status` as data and reports `kind: 'http'`. It deliberately extends `ScraperError` rather than sitting beside it, because services already threw a `ScraperError` for a bad status and consumers already catch on that type.
  - `classifyError(error)` — attributes any thrown value to a kind. Errors the toolkit raised answer for themselves; everything else is identified by walking the `cause` chain, which is how a refused connection or an elapsed deadline is recovered from undici's bare `TypeError: fetch failed`.
  - `failFrom(error, subject, fallbackKind?)` — the one-liner for a `catch` block: keeps a `ScraperError`'s own message, generates a correctly attributed one otherwise. `fallbackKind` says what to assume when nothing identifies the error; pass `'parse'` from a `catch` that wraps only parsing, where a bare `TypeError` from walking a changed payload can be nothing else. A positive identification always wins over it.
  - `describeFailure(kind, subject, status?)` — the default sentence for a kind, naming the subsystem that actually failed so that a bug report quoting only `error` still points at the right place.

  Minor rather than patch: this adds public API (types, exports, a class, three functions). It is additive only — `error` keeps its meaning and its position, `fail` keeps its single-argument form, no existing symbol changed shape, and code written against the previous version compiles and behaves identically.

  This is shaped to serve every scraper built on the toolkit, not just one. `howlongtobeat-ts` and `metacritic-ts` both adopt it alongside this release, and each needed a different part of it — which is why `notFound` is in the union: `metacritic-ts` fails `getDetail` when the search matched nothing, and that outcome is neither a malfunction nor something the other five kinds describe. Because `kind` is optional, no package is required to move in lockstep.
