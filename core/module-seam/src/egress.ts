/**
 * EgressGate — network egress enforcement at the module seam.
 *
 * The capability manifest declares one of three egress classes
 * (architecture §2.5):
 * - "none" — no network egress at all.
 * - "first-party" — only paired first-party instance hosts (the host
 *   supplies the current pair list; the gate never invents one).
 * - { vendorHosts: [...] } — EXACTLY those hosts, nothing more. A host that
 *   merely looks related (subdomain, sibling, same registrant) is denied.
 *
 * Fail-closed: anything not declared is denied with a typed
 * `CapabilityDenied`. Hostnames are normalized (lowercase, trailing dot
 * stripped, port stripped) before comparison so `API.Example:443` cannot
 * evade an allowlist entry of `api.example` — and so normalization can never
 * widen the allowlist, only match it.
 */
import { Effect } from "effect"
import { CapabilityDenied } from "./errors.js"
import type { CapabilityManifest } from "./manifest.js"

export interface EgressRequest {
  readonly moduleId: string
  /** The host the module wants to reach. May carry a port, case, trailing dot. */
  readonly host: string
}

export interface EgressContext {
  /** Currently paired first-party instance hosts. Empty when unpaired. */
  readonly firstPartyHosts: ReadonlyArray<string>
}

/**
 * Normalize a host for allowlist comparison. Normalization only ever makes
 * matching stricter (it can turn an allowed host into a denied one, never
 * the reverse): lowercase, strip one trailing dot, strip an explicit port.
 */
export const normalizeHost = (host: string): string => {
  let h = host.trim().toLowerCase()
  if (h.endsWith(".")) h = h.slice(0, -1)
  if (h.startsWith("[")) {
    // IPv6 literal, possibly with port: [::1]:8080
    const end = h.indexOf("]")
    if (end >= 0) h = h.slice(1, end)
    return h
  }
  const lastColon = h.lastIndexOf(":")
  if (lastColon > 0 && h.indexOf(":") === lastColon && /^\d+$/.test(h.slice(lastColon + 1))) {
    h = h.slice(0, lastColon)
  }
  return h
}

const denied = (moduleId: string, requested: string, reason: string) =>
  Effect.fail(new CapabilityDenied({ module: moduleId, capability: "network.egress", requested, reason }))

/**
 * Allow or deny one egress request against the module's manifest.
 * Succeeds (void) when allowed; fails with typed `CapabilityDenied` when not.
 */
export const checkEgress = (
  manifest: CapabilityManifest,
  request: EgressRequest,
  ctx: EgressContext
): Effect.Effect<void, CapabilityDenied> => {
  const host = normalizeHost(request.host)
  if (host === "") {
    return denied(request.moduleId, request.host, "empty egress host; denied")
  }
  const net = manifest.network
  if (net === "none") {
    return denied(
      request.moduleId,
      host,
      `module declares network 'none'; egress to '${host}' denied`
    )
  }
  if (net === "first-party") {
    const allowed = ctx.firstPartyHosts.map(normalizeHost)
    return allowed.includes(host)
      ? Effect.void
      : denied(
          request.moduleId,
          host,
          `'${host}' is not a paired first-party host; egress denied`
        )
  }
  const allowed = net.vendorHosts.map(normalizeHost)
  return allowed.includes(host)
    ? Effect.void
    : denied(
        request.moduleId,
        host,
        `'${host}' is not in the declared vendor-host allowlist ` +
          `[${net.vendorHosts.join(", ")}]; declared-vendor-hosts means exactly those hosts`
      )
}
