import { FailureKind } from './result'

/**
 * Error raised by a scraper for a condition it recognised itself.
 *
 * Historically this meant exactly one thing — an upstream response that could
 * not be understood — and that remains the default: `kind` is `'parse'` unless
 * a caller says otherwise, so every existing `new ScraperError(message)` keeps
 * its meaning. The field exists so that the classification survives the throw
 * and can be lifted onto the `Failure` the consumer eventually sees, instead of
 * being re-derived from the message text.
 *
 * The message is meant to be surfaced to the consumer, so it should name the
 * subsystem that actually failed.
 */
export class ScraperError extends Error {
  readonly kind: FailureKind

  constructor(
    message: string,
    public readonly cause?: unknown,
    kind: FailureKind = 'parse',
  ) {
    super(message)
    this.name = 'ScraperError'
    this.kind = kind
  }
}

/**
 * A response arrived, but with a status the scraper cannot work with.
 *
 * Extends {@link ScraperError} deliberately: services already threw a
 * `ScraperError` for a bad status, and consumers already catch on that type, so
 * narrowing the hierarchy here would change behaviour. What it adds is the
 * `status` as data rather than as a substring of the message.
 */
export class HttpError extends ScraperError {
  constructor(
    message: string,
    public readonly status: number,
    cause?: unknown,
  ) {
    super(message, cause, 'http')
    this.name = 'HttpError'
  }
}
