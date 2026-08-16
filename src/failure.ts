import { HttpError, ScraperError } from './errors'
import { fail, Failure, FailureKind } from './result'

/** The outcome of {@link classifyError}. */
export interface FailureClassification {
  kind: FailureKind
  /** Only set when `kind` is `'http'`. */
  status?: number
}

/**
 * Node/undici error codes that mean the round trip never completed. `fetch`
 * hides these behind a bare `TypeError: fetch failed`, exposing the real reason
 * only through `cause`, which is why classification walks the chain.
 */
const TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'EPROTO',
  'EHOSTDOWN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_DESTROYED',
])

/** Codes that mean a deadline elapsed rather than the connection failing. */
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

const FETCH_FAILURE_MESSAGE = /fetch failed|failed to fetch|network(?: request)? (?:error|failed)/i

/** How many links to visit before giving up, in case of a very deep chain. */
const MAX_CAUSE_LINKS = 16

/**
 * Attributes a thrown value to a {@link FailureKind}.
 *
 * Errors the toolkit raised itself already carry their classification, so they
 * are answered directly. Everything else comes from the HTTP layer — an
 * `AbortError` from the caller's signal, a `TimeoutError` from the client's own
 * deadline, or undici's `TypeError: fetch failed` wrapping the real socket
 * error — and is identified by walking the `cause` chain.
 */
export function classifyError(error: unknown): FailureClassification {
  if (error instanceof HttpError) return { kind: 'http', status: error.status }
  if (error instanceof ScraperError) return { kind: error.kind }

  const chain = causeChain(error)

  // A name or an errno is a positive identification, so it beats the
  // constructor-shape heuristics below no matter where in the chain it sits.
  for (const link of chain) {
    const kind = classifyByNameOrCode(link)
    if (kind) return { kind }
  }
  for (const link of chain) {
    const kind = classifyByType(link)
    if (kind) return { kind }
  }

  return { kind: 'unknown' }
}

/**
 * Turns a thrown value into a {@link Failure}, preserving the message of an
 * error the toolkit raised itself and falling back to a generated, correctly
 * attributed sentence for anything else.
 *
 * @param subject Name of the remote source, used to build that sentence — e.g.
 * `'HowLongToBeat'` produces `'Could not reach HowLongToBeat (network error)'`.
 * @param fallbackKind What to assume when the error cannot be attributed. Pass
 * `'parse'` from a `catch` that wraps only parsing: the bytes are already in
 * hand there, so nothing network-shaped can be failing, and a stray
 * `TypeError` from walking a payload that changed shape *is* a parse failure
 * however little it looks like one. Defaults to `'unknown'`, which is the
 * honest answer anywhere the phase is not known.
 */
export function failFrom(error: unknown, subject: string, fallbackKind: FailureKind = 'unknown'): Failure {
  const classified = classifyError(error)
  const kind = classified.kind === 'unknown' ? fallbackKind : classified.kind
  const status = classified.status
  const message = error instanceof ScraperError ? error.message : describeFailure(kind, subject, status)
  return fail(message, { kind, status })
}

/**
 * A default sentence for a failure kind that names the subsystem that actually
 * failed, so that a bug report quoting only `error` still points at the right
 * place.
 */
export function describeFailure(kind: FailureKind, subject: string, status?: number): string {
  switch (kind) {
    case 'input':
      return `Invalid arguments for the ${subject} request`
    case 'transport':
      return `Could not reach ${subject} (network error)`
    case 'timeout':
      return `The ${subject} request timed out`
    case 'aborted':
      return `The ${subject} request was aborted by the caller`
    case 'http':
      return status === undefined
        ? `${subject} returned an error status`
        : `${subject} returned HTTP ${status} for the request`
    case 'parse':
      return `Failed to parse the ${subject} response (the site structure may have changed)`
    case 'notFound':
      return `${subject} has no matching entry`
    default:
      return `The ${subject} request failed for an unknown reason`
  }
}

/**
 * Flattens the error graph reachable from `error`: `cause` links, plus the
 * `errors` of an `AggregateError`.
 *
 * The aggregate matters in practice — when a hostname resolves to both an IPv6
 * and an IPv4 address, `fetch` attempts both and reports the failure as
 * `TypeError: fetch failed` → `AggregateError` → the individual socket errors,
 * so the errno that identifies the failure is two levels down and inside an
 * array. Visited nodes are tracked so a cyclic `cause` cannot loop.
 */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  const queue: unknown[] = [error]

  while (queue.length > 0 && chain.length < MAX_CAUSE_LINKS) {
    const current = queue.shift()
    if (current == null || chain.includes(current)) continue
    chain.push(current)

    const { cause, errors } = current as { cause?: unknown; errors?: unknown }
    if (cause != null) queue.push(cause)
    if (Array.isArray(errors)) queue.push(...errors)
  }
  return chain
}

function classifyByNameOrCode(error: unknown): FailureKind | undefined {
  if (typeof error !== 'object' || error === null) return undefined

  const { name, code } = error as { name?: unknown; code?: unknown }
  if (name === 'AbortError') return 'aborted'
  if (name === 'TimeoutError') return 'timeout'

  if (typeof code === 'string') {
    if (TIMEOUT_CODES.has(code)) return 'timeout'
    if (TRANSPORT_CODES.has(code)) return 'transport'
  }
  return undefined
}

function classifyByType(error: unknown): FailureKind | undefined {
  if (error instanceof SyntaxError) return 'parse'
  // `fetch` reports every connection-level failure as a plain TypeError.
  if (error instanceof TypeError && FETCH_FAILURE_MESSAGE.test(error.message)) return 'transport'
  return undefined
}
