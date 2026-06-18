import { afterEach, describe, expect, jest, test } from '@jest/globals'
import {
  BaseScraperService,
  clampSimilarity,
  consoleLogger,
  DEFAULT_USER_AGENTS,
  fail,
  getMatchScore,
  getSimilarity,
  HttpClient,
  normalize,
  ok,
  ScraperError,
  silentLogger,
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
