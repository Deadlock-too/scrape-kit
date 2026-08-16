import { afterEach, describe, expect, jest, test } from '@jest/globals'
import {
  BaseScraperService,
  clampSimilarity,
  classifyError,
  consoleLogger,
  DEFAULT_USER_AGENTS,
  describeFailure,
  fail,
  failFrom,
  getMatchScore,
  getSimilarity,
  HttpClient,
  HttpError,
  normalize,
  ok,
  ScraperError,
  silentLogger,
  type FailureKind,
  type FetchLike,
  type Logger,
  type ScraperOptions,
} from '../src'

/** A fetch double that resolves once it has recorded the call. */
function recordingFetch(response: () => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchFn: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init })
    return response()
  }
  return { fetchFn, calls }
}

/** A fetch double that never resolves until its `init.signal` aborts. */
const hangingFetch: FetchLike = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    if (!signal) return
    if (signal.aborted) return reject(signal.reason)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })

describe('result', () => {
  test('ok wraps data in a success result', () => {
    expect(ok(42)).toEqual({ success: true, data: 42 })
  })

  test('fail wraps a message in a failure result', () => {
    expect(fail('nope')).toEqual({ success: false, error: 'nope' })
  })

  test('fail omits kind and status entirely when they are not supplied', () => {
    const failure = fail('nope')
    expect(Object.keys(failure)).toEqual(['success', 'error'])
  })

  test('fail attaches a kind and a status when supplied', () => {
    expect(fail('nope', { kind: 'http', status: 503 })).toEqual({
      success: false,
      error: 'nope',
      kind: 'http',
      status: 503,
    })
  })
})

describe('ScraperError', () => {
  test('carries the message and a cause when provided', () => {
    const cause = new Error('root')
    const error = new ScraperError('broke', cause)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ScraperError')
    expect(error.message).toBe('broke')
    expect(error.cause).toBe(cause)
  })

  test('leaves the cause undefined when omitted', () => {
    const error = new ScraperError('broke')
    expect(error.cause).toBeUndefined()
  })

  test('defaults to the parse kind, preserving its original meaning', () => {
    expect(new ScraperError('broke').kind).toBe('parse')
  })

  test('accepts an explicit kind', () => {
    expect(new ScraperError('broke', undefined, 'transport').kind).toBe('transport')
  })
})

describe('HttpError', () => {
  test('carries the status as data and classifies itself as http', () => {
    const error = new HttpError('Search request failed with status 403', 403)
    expect(error.name).toBe('HttpError')
    expect(error.status).toBe(403)
    expect(error.kind).toBe('http')
  })

  test('remains a ScraperError so existing catch clauses keep matching', () => {
    expect(new HttpError('boom', 500)).toBeInstanceOf(ScraperError)
  })

  test('forwards a cause', () => {
    const cause = new Error('root')
    expect(new HttpError('boom', 500, cause).cause).toBe(cause)
  })
})

describe('classifyError', () => {
  /** Mirrors how undici surfaces a socket error through `fetch`. */
  function fetchFailure(code: string): TypeError {
    const cause = Object.assign(new Error(`connect ${code} 127.0.0.1:1`), { code })
    return Object.assign(new TypeError('fetch failed'), { cause })
  }

  test('reads the status straight off an HttpError', () => {
    expect(classifyError(new HttpError('boom', 429))).toEqual({ kind: 'http', status: 429 })
  })

  test('trusts the kind a ScraperError carries', () => {
    expect(classifyError(new ScraperError('boom'))).toEqual({ kind: 'parse' })
    expect(classifyError(new ScraperError('boom', undefined, 'transport'))).toEqual({ kind: 'transport' })
  })

  test('recognises a caller abort by name', () => {
    expect(classifyError(new DOMException('This operation was aborted', 'AbortError'))).toEqual({ kind: 'aborted' })
  })

  test('recognises the client timeout by name', () => {
    expect(classifyError(new DOMException('The request timed out', 'TimeoutError'))).toEqual({ kind: 'timeout' })
  })

  test('unwraps a refused connection hidden behind "fetch failed"', () => {
    expect(classifyError(fetchFailure('ECONNREFUSED'))).toEqual({ kind: 'transport' })
  })

  test('prefers a timeout code deeper in the chain over the outer TypeError', () => {
    expect(classifyError(fetchFailure('UND_ERR_HEADERS_TIMEOUT'))).toEqual({ kind: 'timeout' })
  })

  test('recognises DNS failures', () => {
    expect(classifyError(fetchFailure('ENOTFOUND'))).toEqual({ kind: 'transport' })
  })

  test('falls back to transport for a bare fetch TypeError with no cause', () => {
    expect(classifyError(new TypeError('fetch failed'))).toEqual({ kind: 'transport' })
    expect(classifyError(new TypeError('Failed to fetch'))).toEqual({ kind: 'transport' })
  })

  test('treats a JSON SyntaxError as a parse failure', () => {
    let thrown: unknown
    try {
      JSON.parse('{ not json }')
    } catch (error) {
      thrown = error
    }
    expect(classifyError(thrown)).toEqual({ kind: 'parse' })
  })

  test('does not mistake an ordinary TypeError for a transport failure', () => {
    expect(classifyError(new TypeError('x is not a function'))).toEqual({ kind: 'unknown' })
  })

  test('returns unknown for values it cannot attribute', () => {
    expect(classifyError(new Error('socket hang up'))).toEqual({ kind: 'unknown' })
    expect(classifyError('string failure')).toEqual({ kind: 'unknown' })
    expect(classifyError(undefined)).toEqual({ kind: 'unknown' })
  })

  test('does not guess at an errno it does not recognise', () => {
    const error = Object.assign(new Error('boom'), { code: 'ERR_SOMETHING_NEW' })
    expect(classifyError(error)).toEqual({ kind: 'unknown' })
  })

  test('unwraps the AggregateError fetch produces for a dual-stack host', () => {
    // When a hostname resolves to both ::1 and 127.0.0.1, `fetch` tries both
    // and buries the errno two levels down, inside an array.
    const attempts = [
      Object.assign(new Error('connect ECONNREFUSED ::1:8080'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8080'), { code: 'ECONNREFUSED' }),
    ]
    // Built structurally rather than with `new AggregateError`: classification
    // is duck-typed on `errors`, and the real aggregate does not always carry a
    // `code` of its own for the walk to shortcut on.
    const aggregate = Object.assign(new Error(''), { name: 'AggregateError', errors: attempts })
    const error = Object.assign(new TypeError('fetch failed'), { cause: aggregate })

    expect(classifyError(error)).toEqual({ kind: 'transport' })
  })

  test('survives a cycle reached through an AggregateError', () => {
    const inner: { name: string; errors?: unknown[] } = { name: 'Inner' }
    inner.errors = [inner]
    expect(classifyError(inner)).toEqual({ kind: 'unknown' })
  })

  test('survives a cyclic cause chain', () => {
    const a: { cause?: unknown; name: string } = { name: 'A' }
    const b = { name: 'B', cause: a }
    a.cause = b
    expect(classifyError(a)).toEqual({ kind: 'unknown' })
  })
})

describe('failFrom', () => {
  test('keeps the message of an error the toolkit raised itself', () => {
    const failure = failFrom(new ScraperError('missing "data" array'), 'Example')
    expect(failure).toEqual({ success: false, error: 'missing "data" array', kind: 'parse' })
  })

  test('carries the status through from an HttpError', () => {
    const failure = failFrom(new HttpError('Example returned HTTP 403', 403), 'Example')
    expect(failure).toEqual({ success: false, error: 'Example returned HTTP 403', kind: 'http', status: 403 })
  })

  test('generates a correctly attributed message for a foreign error', () => {
    const failure = failFrom(new DOMException('The request timed out', 'TimeoutError'), 'Example')
    expect(failure).toEqual({ success: false, error: 'The Example request timed out', kind: 'timeout' })
  })

  test('reports unknown by default when the error cannot be attributed', () => {
    expect(failFrom(new Error('socket hang up'), 'Example')).toEqual({
      success: false,
      error: 'The Example request failed for an unknown reason',
      kind: 'unknown',
    })
  })

  test('a parse-phase catch claims an unattributable error as its own', () => {
    // Walking a payload that changed shape throws a bare TypeError that looks
    // like nothing in particular — but in a parse `catch` it can only be a
    // parse failure.
    const error = new TypeError("Cannot read properties of undefined (reading 'items')")
    expect(failFrom(error, 'Example', 'parse')).toEqual({
      success: false,
      error: 'Failed to parse the Example response (the site structure may have changed)',
      kind: 'parse',
    })
  })

  test('a fallback kind never overrides a positive identification', () => {
    const aborted = new DOMException('This operation was aborted', 'AbortError')
    expect(failFrom(aborted, 'Example', 'parse').kind).toBe('aborted')
    expect(failFrom(new HttpError('boom', 500), 'Example', 'parse')).toMatchObject({ kind: 'http', status: 500 })
  })
})

describe('describeFailure', () => {
  test('names the subsystem for every kind', () => {
    const kinds: FailureKind[] = ['input', 'transport', 'timeout', 'aborted', 'http', 'parse', 'notFound', 'unknown']
    for (const kind of kinds) {
      expect(describeFailure(kind, 'Example')).toContain('Example')
    }
  })

  test('does not describe an absent record as a malfunction', () => {
    expect(describeFailure('notFound', 'Example')).toBe('Example has no matching entry')
  })

  test('includes the status when there is one', () => {
    expect(describeFailure('http', 'Example', 503)).toBe('Example returned HTTP 503 for the request')
    expect(describeFailure('http', 'Example')).toBe('Example returned an error status')
  })

  test('points a parse failure at the site rather than the network', () => {
    expect(describeFailure('parse', 'Example')).toMatch(/parse the Example response/)
  })

  test('points a transport failure at the network rather than the parser', () => {
    expect(describeFailure('transport', 'Example')).toMatch(/Could not reach Example/)
  })
})

describe('logger', () => {
  test('silentLogger swallows every level without throwing', () => {
    expect(() => {
      silentLogger.error('e')
      silentLogger.warn('w')
      silentLogger.info('i')
    }).not.toThrow()
  })

  test('consoleLogger forwards each level to the matching console method', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {})
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const info = jest.spyOn(console, 'info').mockImplementation(() => {})

    consoleLogger.error('e', 1)
    consoleLogger.warn('w', 2)
    consoleLogger.info('i', 3)

    expect(error).toHaveBeenCalledWith('e', 1)
    expect(warn).toHaveBeenCalledWith('w', 2)
    expect(info).toHaveBeenCalledWith('i', 3)

    error.mockRestore()
    warn.mockRestore()
    info.mockRestore()
  })
})

describe('similarity', () => {
  test('normalize strips accents and punctuation', () => {
    expect(normalize('Pokémon')).toBe('pokemon')
    expect(normalize("Marvel's Spider-Man")).toBe('marvel s spider man')
    expect(normalize('  Hello!!!  ')).toBe('hello')
  })

  test('getSimilarity returns 1 for identical strings', () => {
    expect(getSimilarity('test', 'test')).toBe(1)
  })

  test('getSimilarity returns 0 when either side is empty', () => {
    expect(getSimilarity('', 'test')).toBe(0)
    expect(getSimilarity('test', '')).toBe(0)
  })

  test('getSimilarity is case-insensitive but scores edit distance', () => {
    expect(getSimilarity('Test', 'test')).toBe(1)
    expect(getSimilarity('test', 'banana')).toBe(0)
    expect(getSimilarity('Elden Ring', 'Elden Rin')).toBe(0.9)
  })

  test('getMatchScore returns 0 when either side is empty', () => {
    expect(getMatchScore('', 'query')).toBe(0)
    expect(getMatchScore('candidate', '')).toBe(0)
  })

  test('getMatchScore returns 1 on a normalised exact match', () => {
    expect(getMatchScore('Pokémon Red', 'pokemon red')).toBe(1)
  })

  test('getMatchScore falls back to the edit score when the query has no tokens', () => {
    // "!!!" normalises to an empty string, leaving zero query tokens.
    expect(getMatchScore('candidate', '!!!')).toBe(0)
  })

  test('getMatchScore keeps a short query against a long title', () => {
    expect(getMatchScore('The Legend of Zelda: Tears of the Kingdom', 'Zelda')).toBeGreaterThanOrEqual(0.5)
  })

  test('getMatchScore rewards partial token containment', () => {
    // "elden" matches, "zelda" does not — a partial containment score.
    const score = getMatchScore('Elden Ring', 'Elden Zelda')
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(1)
  })
})

describe('clampSimilarity', () => {
  test('clamps below 0, above 1 and leaves in-range values untouched', () => {
    expect(clampSimilarity(-1)).toBe(0)
    expect(clampSimilarity(5)).toBe(1)
    expect(clampSimilarity(0.3)).toBe(0.3)
  })

  test('defaults a NaN to 0.5', () => {
    expect(clampSimilarity(Number.NaN)).toBe(0.5)
  })
})

describe('BaseScraperService', () => {
  class TestService extends BaseScraperService {
    constructor(options?: number | ScraperOptions) {
      super(options)
    }
    get threshold() {
      return this.minSimilarity
    }
    get attachedLogger() {
      return this.logger
    }
  }

  test('accepts a bare number as the similarity threshold', () => {
    expect(new TestService(0.8).threshold).toBe(0.8)
  })

  test('clamps an out-of-range numeric threshold', () => {
    expect(new TestService(2).threshold).toBe(1)
  })

  test('reads the threshold and logger from an options object', () => {
    const logger = silentLogger
    const service = new TestService({ minSimilarity: 0.2, logger })
    expect(service.threshold).toBe(0.2)
    expect(service.attachedLogger).toBe(logger)
  })

  test('applies defaults when constructed without arguments', () => {
    const service = new TestService()
    expect(service.threshold).toBe(0.5)
    expect(service.attachedLogger).toBe(silentLogger)
  })
})

describe('HttpClient – construction', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('exposes the default User-Agent pool', () => {
    expect(DEFAULT_USER_AGENTS.length).toBeGreaterThan(0)
    const ua = new HttpClient().randomUserAgent()
    expect(DEFAULT_USER_AGENTS).toContain(ua)
  })

  test('falls back to a custom User-Agent pool when supplied', () => {
    const client = new HttpClient({ userAgents: ['only-one'] })
    expect(client.randomUserAgent()).toBe('only-one')
  })

  test('ignores an empty User-Agent pool and uses the defaults', () => {
    const client = new HttpClient({ userAgents: [] })
    expect(DEFAULT_USER_AGENTS).toContain(client.randomUserAgent())
  })

  test('uses the global fetch when none is provided', async () => {
    const original = globalThis.fetch
    const stub = jest.fn(async () => new Response('ok'))
    globalThis.fetch = stub as unknown as typeof fetch
    try {
      const response = await new HttpClient({ retries: 0 }).request('https://example.com')
      expect(await response.text()).toBe('ok')
      expect(stub).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('HttpClient – headers', () => {
  test('injects a random User-Agent when none is supplied', async () => {
    const { fetchFn, calls } = recordingFetch(() => new Response('ok'))
    await new HttpClient({ fetch: fetchFn, retries: 0 }).request('https://example.com')
    expect(new Headers(calls[0].init?.headers).get('User-Agent')).toBeTruthy()
  })

  test('keeps a caller-supplied User-Agent', async () => {
    const { fetchFn, calls } = recordingFetch(() => new Response('ok'))
    await new HttpClient({ fetch: fetchFn, retries: 0 }).request('https://example.com', {
      headers: { 'User-Agent': 'mine' },
    })
    expect(new Headers(calls[0].init?.headers).get('User-Agent')).toBe('mine')
  })
})

describe('HttpClient – retries', () => {
  test('retries a 429 and honours a numeric retry-after header', async () => {
    let calls = 0
    const fetchFn: FetchLike = async () => {
      calls++
      return calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : new Response('ok')
    }
    const response = await new HttpClient({ fetch: fetchFn, retries: 2, retryDelay: 1 }).request('https://example.com')
    expect(calls).toBe(2)
    expect(await response.text()).toBe('ok')
  })

  test('retries a 500 with backoff when no retry-after is present', async () => {
    const logger: Logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() }
    let calls = 0
    const fetchFn: FetchLike = async () => {
      calls++
      return calls === 1 ? new Response('', { status: 500 }) : new Response('ok')
    }
    const response = await new HttpClient({ fetch: fetchFn, retries: 1, retryDelay: 1, logger }).request(
      'https://example.com',
    )
    expect(calls).toBe(2)
    expect(await response.text()).toBe('ok')
    expect(logger.warn).toHaveBeenCalled()
  })

  test('honours a date-based retry-after header', async () => {
    let calls = 0
    const fetchFn: FetchLike = async () => {
      calls++
      const when = new Date(Date.now() + 5).toUTCString()
      return calls === 1 ? new Response('', { status: 503, headers: { 'retry-after': when } }) : new Response('ok')
    }
    const response = await new HttpClient({ fetch: fetchFn, retries: 1, maxRetryDelay: 50 }).request(
      'https://example.com',
    )
    expect(calls).toBe(2)
    expect(await response.text()).toBe('ok')
  })

  test('ignores an unparseable retry-after header and backs off instead', async () => {
    let calls = 0
    const fetchFn: FetchLike = async () => {
      calls++
      return calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': 'soon' } }) : new Response('ok')
    }
    const response = await new HttpClient({ fetch: fetchFn, retries: 1, retryDelay: 1 }).request('https://example.com')
    expect(calls).toBe(2)
    expect(await response.text()).toBe('ok')
  })

  test('caps the backoff delay at maxRetryDelay', async () => {
    let calls = 0
    const fetchFn: FetchLike = async () => {
      calls++
      return calls === 1 ? new Response('', { status: 500 }) : new Response('ok')
    }
    // A huge base delay would exceed maxRetryDelay, so it is clamped to 1ms.
    const response = await new HttpClient({
      fetch: fetchFn,
      retries: 1,
      retryDelay: 100000,
      maxRetryDelay: 1,
    }).request('https://example.com')
    expect(calls).toBe(2)
    expect(await response.text()).toBe('ok')
  })

  test('returns the error response once retries are exhausted', async () => {
    let calls = 0
    const fetchFn: FetchLike = async () => {
      calls++
      return new Response('', { status: 429 })
    }
    const response = await new HttpClient({ fetch: fetchFn, retries: 0 }).request('https://example.com')
    expect(calls).toBe(1)
    expect(response.status).toBe(429)
  })

  test('retries a thrown Error then succeeds', async () => {
    let calls = 0
    const fetchFn: FetchLike = async () => {
      calls++
      if (calls === 1) throw new Error('boom')
      return new Response('ok')
    }
    const response = await new HttpClient({ fetch: fetchFn, retries: 1, retryDelay: 1 }).request('https://example.com')
    expect(calls).toBe(2)
    expect(await response.text()).toBe('ok')
  })

  test('retries a thrown non-Error value then rethrows when exhausted', async () => {
    let calls = 0
    const fetchFn: FetchLike = async () => {
      calls++
      throw 'string failure'
    }
    await expect(
      new HttpClient({ fetch: fetchFn, retries: 1, retryDelay: 1 }).request('https://example.com'),
    ).rejects.toBe('string failure')
    expect(calls).toBe(2)
  })
})

describe('HttpClient – abort & timeout', () => {
  test('does not retry once the caller has already aborted', async () => {
    let calls = 0
    const fetchFn: FetchLike = async (_input, init) => {
      calls++
      if (init?.signal?.aborted) throw new Error('aborted')
      return new Response('ok')
    }
    const controller = new AbortController()
    controller.abort()
    await expect(
      new HttpClient({ fetch: fetchFn, retries: 3, retryDelay: 1 }).request(
        'https://example.com',
        {},
        controller.signal,
      ),
    ).rejects.toThrow()
    expect(calls).toBe(1)
  })

  test('forwards a mid-flight caller abort without retrying', async () => {
    const controller = new AbortController()
    const promise = new HttpClient({ fetch: hangingFetch, retries: 3, retryDelay: 1 }).request(
      'https://example.com',
      {},
      controller.signal,
    )
    queueMicrotask(() => controller.abort(new Error('cancelled')))
    await expect(promise).rejects.toThrow('cancelled')
  })

  test('aborts with a timeout when the request hangs', async () => {
    await expect(
      new HttpClient({ fetch: hangingFetch, retries: 0, timeout: 5 }).request('https://example.com'),
    ).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  test('cleans up the timeout when an external signal is present but unused', async () => {
    const { fetchFn, calls } = recordingFetch(() => new Response('ok'))
    const controller = new AbortController()
    const response = await new HttpClient({ fetch: fetchFn, retries: 0 }).request(
      'https://example.com',
      {},
      controller.signal,
    )
    expect(await response.text()).toBe('ok')
    expect(calls).toHaveLength(1)
  })
})
