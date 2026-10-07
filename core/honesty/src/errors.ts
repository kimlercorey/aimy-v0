/**
 * honesty/errors.ts — the typed error taxonomy for the honesty layer.
 *
 * Contract (substrate/errors.ts): every error is an Effect `Data.TaggedError`
 * and is NEVER thrown across library boundaries.
 */
import { Data } from "effect"

/** No claim with this id exists in the ledger. */
export class ClaimNotFound extends Data.TaggedError("ClaimNotFound")<{
  readonly claimId: string
}> {}

/** A `judge-verdict` evidence record referenced a verdict that was never recorded. */
export class VerdictNotFound extends Data.TaggedError("VerdictNotFound")<{
  readonly verdictId: string
}> {}

/** A claim referenced an evidence record missing from the store (foreign-store corruption). */
export class EvidenceNotFound extends Data.TaggedError("EvidenceNotFound")<{
  readonly evidenceId: string
}> {}

/** A recorded verdict failed structural validation (e.g. non-semver judgeVersion). */
export class InvalidVerdict extends Data.TaggedError("InvalidVerdict")<{
  readonly verdictId: string
  readonly reason: string
}> {}

/** The underlying ledger store failed (reserved for the durable store seam). */
export class LedgerError extends Data.TaggedError("LedgerError")<{
  readonly operation: string
  readonly reason: string
}> {}

/** The union of every typed error raised by HonestyService. */
export type HonestyError = ClaimNotFound | VerdictNotFound | EvidenceNotFound | InvalidVerdict | LedgerError
