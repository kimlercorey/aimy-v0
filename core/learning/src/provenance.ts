/**
 * provenance.ts — write provenance for the learning loop (architecture §3.7).
 *
 * Every memory/skill write proposed by a review fork carries provenance
 * metadata: origin, execution context, session, profile. Unattributed memory
 * is a bug — `requireProvenance` rejects (typed) any write whose provenance
 * is missing or incomplete, and the write gate calls it before anything
 * else.
 */
import { Data, Effect, Schema } from "effect"

/** Where a proposed write came from. `review-fork` is the unattended path. */
export const WriteOrigin = Schema.Literals(["review-fork", "curator", "user", "import"])
export type WriteOrigin = Schema.Schema.Type<typeof WriteOrigin>

/**
 * Provenance carried on every learning-loop write (architecture §3.7).
 * All four fields are required — partial provenance is unattributed.
 */
export const WriteProvenance = Schema.Struct({
  origin: WriteOrigin,
  executionContext: Schema.Literals(["unattended", "attended"]),
  sessionId: Schema.String,
  profileId: Schema.String
})
export type WriteProvenance = Schema.Schema.Type<typeof WriteProvenance>

/** A write arrived without complete provenance. Typed, never thrown. */
export class UnattributedWrite extends Data.TaggedError("UnattributedWrite")<{
  readonly reason: string
}> {}

/**
 * Validate provenance, failing with `UnattributedWrite` on anything less
 * than the full struct (missing fields, wrong origin literals, non-strings).
 */
export const requireProvenance = (
  provenance: unknown
): Effect.Effect<WriteProvenance, UnattributedWrite> =>
  Schema.decodeUnknownEffect(WriteProvenance)(provenance).pipe(
    Effect.catch(() =>
      Effect.fail(
        new UnattributedWrite({
          reason:
            "write lacks complete provenance: origin, executionContext, sessionId and profileId are all required"
        })
      )
    )
  )
