/**
 * comms/errors.ts — typed errors for the CommsBanner channel.
 *
 * Contract (substrate/errors.ts): every error is an Effect `Data.TaggedError`
 * and is NEVER thrown across library boundaries.
 */
import { Data } from "effect"

/** A banner log read/write failed (append-only store is unreadable or unwritable). */
export class BannerLogError extends Data.TaggedError("BannerLogError")<{
  readonly reason: string
}> {}

/** The banner payload failed validation (empty title, bad TTL, unknown id shape, ...). */
export class BannerValidationError extends Data.TaggedError("BannerValidationError")<{
  readonly reason: string
}> {}

/** Publish attempted `source: "trusted-broadcast"` without a capability. */
export class TrustedBroadcastCapabilityMissing extends Data.TaggedError(
  "TrustedBroadcastCapabilityMissing"
)<{
  readonly reason: string
}> {}

/**
 * Publish attempted `source: "trusted-broadcast"` with a value that is not a
 * genuine `TrustedBroadcastCapability` (forgery attempt). The local system
 * has no constructor for the capability (see capability.ts), so reaching this
 * error means something fabricated a value.
 */
export class TrustedBroadcastCapabilityInvalid extends Data.TaggedError(
  "TrustedBroadcastCapabilityInvalid"
)<{
  readonly reason: string
}> {}

/** `dismiss()` named an id that is not in the banner store. */
export class BannerNotFound extends Data.TaggedError("BannerNotFound")<{
  readonly id: string
}> {}

/** The union of every error the CommsBanner API can produce. */
export type CommsError =
  | BannerLogError
  | BannerValidationError
  | TrustedBroadcastCapabilityMissing
  | TrustedBroadcastCapabilityInvalid
  | BannerNotFound
