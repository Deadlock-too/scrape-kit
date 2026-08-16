# scrape-kit

[![GitHub](https://img.shields.io/github/license/Deadlock-too/scrape-kit)](https://github.com/Deadlock-too/scrape-kit)
[![npm](https://img.shields.io/npm/v/@deadlock-too/scrape-kit)](https://www.npmjs.com/package/@deadlock-too/scrape-kit)
[![npm](https://img.shields.io/npm/dt/@deadlock-too/scrape-kit)](https://www.npmjs.com/package/@deadlock-too/scrape-kit)

A TypeScript toolkit for building resilient website-scraper clients. It bundles the boring-but-essential plumbing — a retrying `fetch` client, fuzzy title matching, a typed result/error model and a base service to extend — so each scraper only has to deal with its own site-specific request/parse logic.

This is the shared foundation behind my [howlongtobeat-ts](https://github.com/Deadlock-too/howlongtobeat-ts) and [metacritic-ts](https://github.com/Deadlock-too/metacritic-ts) libraries.

> ⚠️ **Use responsibly:** this toolkit makes it easy to talk to third-party websites that may not offer an official API. Respect their terms of service and rate limits, and do not abuse or overload their servers. Use at your own risk.

## Features

- Resilient networking via `HttpClient`: configurable timeouts, retries with exponential backoff, `429 Retry-After` and `5xx` handling, User-Agent rotation, an injectable `fetch` and `AbortSignal` support
- Fuzzy title matching (`getMatchScore`, `getSimilarity`, `normalize`) so short queries still match longer titles
- A discriminated-union `Result<T>` type with `ok` / `fail` helpers — no thrown errors on the happy path
- A machine-readable `FailureKind` on every failure, so a caller can tell "the source is down" from "the scraper is broken" without parsing message text
- A `ScraperError` / `HttpError` pair for failures the scraper recognises, surfaced as actionable messages
- A pluggable `Logger` with a silent default — zero `console` noise unless you opt in
- A `BaseScraperService` base class that owns the HTTP client, logger and (clamped) similarity threshold
- Fully typed, ships both ESM and CommonJS builds

## Installation

```bash
npm install @deadlock-too/scrape-kit
```

Requires Node.js 18 or newer (the toolkit uses the global `fetch`).

## Usage

### Building a scraper

Extend `BaseScraperService`; it gives you a ready-made `http` client, `logger` and `minSimilarity` threshold. Return `Result<T>` from your public methods so callers never have to wrap calls in `try`/`catch`.

```typescript
import {
  BaseScraperService,
  HttpError,
  ScraperError,
  describeFailure,
  fail,
  failFrom,
  getMatchScore,
  ok,
  type Result,
  type ScraperOptions,
} from '@deadlock-too/scrape-kit'

interface Movie {
  title: string
  year: number
}

class TinyMovieScraper extends BaseScraperService {
  constructor(options?: number | ScraperOptions) {
    super(options)
  }

  async search(query: string, signal?: AbortSignal): Promise<Result<Movie[]>> {
    if (!query) return fail(describeFailure('input', 'Example'), { kind: 'input' })

    // Fetch and parse are caught separately so that each failure is reported
    // as what it actually is.
    let payload: { results?: Movie[] }
    try {
      const url = `https://example.com/api/search?q=${encodeURIComponent(query)}`
      const response = await this.http.request(url, {}, signal)
      if (!response.ok) {
        throw new HttpError(describeFailure('http', 'Example', response.status), response.status)
      }
      payload = (await response.json()) as { results?: Movie[] }
    } catch (error) {
      this.logger.error('Example search request failed:', error)
      // Classifies transport / timeout / abort / http and builds the message.
      return failFrom(error, 'Example')
    }

    try {
      if (!payload.results) throw new ScraperError('The Example response structure may have changed')

      const movies = payload.results
        .map((movie) => ({ movie, score: getMatchScore(movie.title, query) }))
        .filter(({ score }) => score >= this.minSimilarity)
        .sort((a, b) => b.score - a.score)
        .map(({ movie }) => movie)

      return ok(movies)
    } catch (error) {
      this.logger.error('Example search parsing failed:', error)
      // 'parse' is the fallback: in this block nothing else can be at fault.
      return failFrom(error, 'Example', 'parse')
    }
  }
}

const scraper = new TinyMovieScraper()
const result = await scraper.search('The Last of Us')
if (result.success) {
  // `data` is only available on the success branch.
  console.log(result.data)
} else {
  // `error` is only available on the failure branch.
  console.error(result.error)
}
```

### Telling an outage from a broken scraper

Every failure carries an optional `kind` alongside the human-readable `error`. Branch on `kind`; treat `error` as text for humans, whose wording may change between releases.

```typescript
const result = await scraper.search('The Last of Us')
if (!result.success) {
  switch (result.kind) {
    case 'transport':
    case 'timeout':
      return 'Example is unreachable right now — try again shortly.'
    case 'http':
      // `status` is set for this kind (403 = blocked, 429 = rate-limited, …).
      return `Example refused the request (HTTP ${result.status}).`
    case 'parse':
      // The site changed shape: this one is a bug in the scraper.
      return 'Example responded, but the scraper could not read it.'
    case 'aborted':
      return 'Cancelled.'
    default:
      return result.error
  }
}
```

### Configuration

Pass an options object to the constructor (a bare `number` is also accepted as `minSimilarity`):

```typescript
import { consoleLogger } from '@deadlock-too/scrape-kit'

const scraper = new TinyMovieScraper({
  minSimilarity: 0.5, // min similarity threshold (0–1), clamped
  timeout: 30_000, // per-request timeout in ms
  retries: 2, // retry attempts on transient failures / 429 / 5xx
  retryDelay: 500, // base backoff delay in ms (grows exponentially)
  logger: consoleLogger, // opt in to diagnostic logging (default: silent)
  // userAgents: ['…'],     // custom User-Agent pool (one is picked per request)
  // fetch: myCustomFetch,  // inject a custom fetch (proxy, undici agent, …)
})

// Cancel an in-flight request.
const controller = new AbortController()
const promise = scraper.search('Halo', controller.signal)
controller.abort()
```

### Using `HttpClient` directly

The HTTP client is useful on its own when you don't need the full service base:

```typescript
import { HttpClient } from '@deadlock-too/scrape-kit'

const http = new HttpClient({ retries: 3, timeout: 10_000 })
const response = await http.request('https://example.com')
```

### Fuzzy matching helpers

```typescript
import { getMatchScore, getSimilarity, normalize } from '@deadlock-too/scrape-kit'

normalize("Marvel's Spider-Man") // "marvel s spider man"
getSimilarity('Elden Ring', 'Elden Rin') // 0.9
getMatchScore('The Legend of Zelda: Tears of the Kingdom', 'Zelda') // >= 0.5
```

## API

### `BaseScraperService`

Abstract base class. Subclasses get three protected members:

- `http: HttpClient` — the configured HTTP client
- `logger: Logger` — the configured logger (silent by default)
- `minSimilarity: number` — the validated, clamped similarity threshold

```typescript
protected constructor(options?: number | ScraperOptions)
```

`ScraperOptions` extends `HttpClientOptions` (`fetch`, `timeout`, `retries`, `retryDelay`, `maxRetryDelay`, `userAgents`, `logger`) with `minSimilarity`.

### `HttpClient`

A thin wrapper around `fetch` that centralises timeouts, retries with exponential backoff, `429 Retry-After` handling, User-Agent rotation and caller-supplied `AbortSignal` propagation.

- `constructor(options?: HttpClientOptions)`
- `request(input, init?, signal?): Promise<Response>` — never throws on `429`/`5xx`; it retries up to `retries` times then returns the last response. Network errors are retried and ultimately rethrown.
- `randomUserAgent(): string`

`DEFAULT_USER_AGENTS` is the built-in pool used when `userAgents` is not supplied.

### `Result<T>`

Discriminated union with helpers:

```typescript
type Success<T> = { success: true; data: T }
type Failure = { success: false; error: string; kind?: FailureKind; status?: number }
type Result<T> = Success<T> | Failure

function ok<T>(data: T): Success<T>
function fail(error: string, options?: { kind?: FailureKind; status?: number }): Failure
```

`error` is always present. `kind` and `status` are optional and are omitted from the object entirely when not supplied, so `fail('boom')` still produces exactly `{ success: false, error: 'boom' }`.

### `FailureKind`

The stable, machine-readable category of a failure. `error` is prose and may be reworded in any release; `kind` is the field to branch on.

| `kind`      | Meaning                                                 | Whose problem      |
| ----------- | ------------------------------------------------------- | ------------------ |
| `input`     | Arguments rejected before any request was made          | the caller         |
| `transport` | Round trip never completed — DNS, refused, reset, TLS   | the network/source |
| `timeout`   | The client's own per-request deadline elapsed           | the network/source |
| `aborted`   | The caller's `AbortSignal` fired                        | the caller         |
| `http`      | A response arrived with a non-2xx status (see `status`) | the source         |
| `parse`     | A response arrived and could not be understood          | the scraper        |
| `notFound`  | Everything worked; the source has no such record        | nobody             |
| `unknown`   | Could not be attributed to any of the above             | —                  |

### `ScraperError` / `HttpError`

- `new ScraperError(message, cause?, kind?)` — throw it for a failure the scraper recognises itself. `kind` defaults to `'parse'`, so an upstream response that can't be understood (e.g. the site changed its structure) needs no extra argument. The message is meant to be surfaced to the consumer via a `Failure`.
- `new HttpError(message, status, cause?)` — a subclass for a non-2xx response; carries `status` as data and reports `kind: 'http'`. It extends `ScraperError`, so existing `instanceof ScraperError` checks keep matching.

### Failure classification

- `classifyError(error): { kind, status? }` — attributes any thrown value. Errors raised by the toolkit answer for themselves; everything else is identified by walking the `cause` chain, which is how a refused connection is recovered from undici's bare `TypeError: fetch failed`.
- `failFrom(error, subject, fallbackKind?): Failure` — the one-liner for a `catch` block. Keeps a `ScraperError`'s own message and generates an attributed one otherwise. Pass `'parse'` as `fallbackKind` from a `catch` that wraps only parsing: the bytes are already in hand there, so a stray `TypeError` from walking a payload that changed shape _is_ a parse failure, however little it looks like one. A positive identification always wins over the fallback.
- `describeFailure(kind, subject, status?): string` — the default sentence for a kind, naming the subsystem that actually failed so a bug report quoting only `error` points at the right place.

### `Logger`

`{ error, warn, info }`. Ships `silentLogger` (default) and `consoleLogger`.

### Similarity helpers

- `normalize(value)` — lowercases and strips accents/punctuation
- `getSimilarity(a, b)` — normalised Levenshtein similarity in `[0, 1]`
- `getMatchScore(candidate, query)` — search-oriented score combining edit distance with token containment
- `clampSimilarity(value)` — clamps to `[0, 1]`, defaulting `NaN` to `0.5`

## Development

```bash
git clone https://github.com/Deadlock-too/scrape-kit.git
cd scrape-kit
npm install

npm run build         # build with tsdown
npm test              # unit tests
npm run test:coverage # unit tests with coverage (100% threshold)
npm run lint          # eslint
npm run format        # prettier
```

Releases are managed with [Changesets](https://github.com/changesets/changesets): run `npm run changeset` to record a change; the release workflow publishes to npm once the generated version PR is merged.

## Issues, Questions & Discussions

If you found a bug, report it as soon as possible by creating an [issue](https://github.com/Deadlock-too/scrape-kit/issues/new); the code is not perfect for sure, and I will be happy to fix it.
If you need a new feature, or want to discuss the current implementation, consider opening a [discussion](https://github.com/Deadlock-too/scrape-kit/discussions/) or proposing a change with a [Pull Request](https://github.com/Deadlock-too/scrape-kit/pulls).

## License

This project is licensed under the MIT License - see the [LICENSE](https://github.com/Deadlock-too/scrape-kit/blob/main/LICENSE) file for details.
