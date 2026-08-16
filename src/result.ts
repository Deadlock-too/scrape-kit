/**
 * The category of a {@link Failure}, meant to be branched on by consumers.
 *
 * `error` is a human-readable sentence whose wording is free to change; `kind`
 * is the stable, machine-readable channel. The two are independent: a caller
 * that only logs can keep reading `error`, a caller that has to *decide*
 * something reads `kind`.
 *
 * - `input`     — the arguments were rejected before any request was made.
 * - `transport` — the round trip never completed: DNS, refused connection,
 *                 reset socket, TLS failure.
 * - `timeout`   — the client's own per-request deadline elapsed.
 * - `aborted`   — the caller's `AbortSignal` fired.
 * - `http`      — a response arrived carrying a non-2xx status (see `status`).
 * - `parse`     — a response arrived and could not be understood, which usually
 *                 means the remote site changed shape.
 * - `notFound`  — everything worked; the source simply has no such record. Not
 *                 a malfunction, and worth distinguishing from one.
 * - `unknown`   — the failure could not be attributed to any of the above.
 *
 * `transport`, `timeout` and `http` say the source is unavailable or unhappy;
 * `parse` says the scraper itself needs fixing; `notFound` says nothing is
 * wrong at all. Those distinctions are the reason this type exists.
 */
export type FailureKind = 'input' | 'transport' | 'timeout' | 'aborted' | 'http' | 'parse' | 'notFound' | 'unknown'

/**
 * A discriminated-union result type shared by every public method.
 *
 * Narrowing on `success` lets TypeScript infer that `data` is present on the
 * happy path and that `error` is present on the failure path:
 *
 * ```ts
 * const result = await service.search('Elden Ring')
 * if (result.success) {
 *   result.data // HowLongToBeatEntry[]
 * } else {
 *   result.error // string  — always present
 *   result.kind  // FailureKind | undefined — branch on this
 * }
 * ```
 */
export type Success<T> = { success: true; data: T }

export type Failure = {
  success: false
  /** Human-readable description. Always present; wording is not stable. */
  error: string
  /**
   * Machine-readable category. Optional so that the field could be added
   * without breaking existing producers — services built on this toolkit are
   * expected to set it, but code that predates it still type-checks.
   */
  kind?: FailureKind
  /** The HTTP status. Only meaningful when `kind` is `'http'`. */
  status?: number
}

export type Result<T> = Success<T> | Failure

export interface FailureOptions {
  kind?: FailureKind
  /** Only set this alongside `kind: 'http'`. */
  status?: number
}

export function ok<T>(data: T): Success<T> {
  return { success: true, data }
}

/**
 * Builds a failure result. `kind` and `status` are omitted from the returned
 * object when not supplied, so `fail('boom')` still deep-equals
 * `{ success: false, error: 'boom' }` as it always has.
 */
export function fail(error: string, options: FailureOptions = {}): Failure {
  const failure: Failure = { success: false, error }
  if (options.kind !== undefined) failure.kind = options.kind
  if (options.status !== undefined) failure.status = options.status
  return failure
}
