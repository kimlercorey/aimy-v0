/**
 * devtools/seam.ts — the loopback-bound relay the snapshot command publishes to.
 *
 * The MCP exposure is local-only by construction: `bindHost` is typed as the
 * `MCP_BIND_HOST` literal, so an implementation claiming any other bind
 * address fails to typecheck. The unwired default fails closed.
 */
import { Context, Data, Effect } from "effect"
import type { SerializedEntry } from "foldkit/devtools-protocol"

import { MCP_BIND_HOST } from "./model.js"

export class DevtoolsError extends Data.TaggedError("DevtoolsError")<{
  readonly reason: string
}> {}

export interface DevtoolsRelayShape {
  /** Loopback only — the literal type makes a non-loopback bind a type error. */
  readonly bindHost: typeof MCP_BIND_HOST
  readonly publish: (
    entries: ReadonlyArray<SerializedEntry>
  ) => Effect.Effect<void, DevtoolsError>
}

export class DevtoolsRelay extends Context.Service<DevtoolsRelay, DevtoolsRelayShape>()(
  "aimy/ui/DevtoolsRelay"
) {}

/** Fail-closed default: no relay bound, nothing published. */
export const DevtoolsRelayUnwired: DevtoolsRelayShape = {
  bindHost: MCP_BIND_HOST,
  publish: (_entries) => Effect.fail(new DevtoolsError({ reason: "devtools:relay-not-bound" }))
}
