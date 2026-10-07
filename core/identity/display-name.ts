/**
 * identity/display-name.ts — instance display-name rename (architecture Part 02 §1.1).
 *
 * The display name ("office", "home-server", "laptop") is the user-editable
 * label on the identity document. `renameDisplayName` rewrites
 * `identity.json` preserving everything else — `version`, `instanceId`,
 * `createdAt`, `publicKey`, `pairingProtocolVersion` — by round-tripping
 * through `migrateIdentityDocument` (so a rename can never silently corrupt
 * the document).
 *
 * Renames are audit-logged, never silent: the operation appends a
 * `display-name-renamed` event to the XDG state audit trail
 * (`identity-audit.jsonl`, 0600) AND returns the event to the caller, so the
 * caller can surface it (banner, UI, logs). Refusals are typed:
 * empty/overlong names → `display-name-invalid`; renaming to the current
 * name → `display-name-unchanged`.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Effect, Schema } from "effect"

import { IdentityError } from "../substrate/errors.js"
import type { AimyPaths } from "../substrate/config.js"
import {
  IDENTITY_FILE_NAME,
  migrateIdentityDocument,
  type IdentityDocument,
  type IdentityServiceShape
} from "./identity.js"

/** Audit-trail file name inside the XDG state dir (JSONL, one event per line). */
export const IDENTITY_AUDIT_FILE_NAME = "identity-audit.jsonl"

/** Max display-name length (characters). */
export const DISPLAY_NAME_MAX_LENGTH = 128

/** The audit event produced by every rename — returned to the caller and appended to the audit trail. */
export interface DisplayNameRenameEvent {
  readonly kind: "display-name-renamed"
  readonly at: string // ISO-8601 UTC
  readonly instanceId: string
  readonly previousDisplayName: string | null
  readonly displayName: string
}

const DisplayNameSchema = Schema.String.pipe(
  Schema.refine((s): s is string => s.trim().length > 0 && s.length <= DISPLAY_NAME_MAX_LENGTH, {
    message: `display name must be 1–${DISPLAY_NAME_MAX_LENGTH} characters`
  })
)

const writeFilePrivate = (file: string, data: string): Effect.Effect<void, IdentityError> =>
  Effect.tryPromise({
    try: async () => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      await fs.writeFile(file, data, { mode: 0o600 })
      await fs.chmod(file, 0o600) // belt-and-braces: umask must not widen this
    },
    catch: () => new IdentityError({ reason: "identity-store-unwritable" })
  })

const appendAuditEvent = (
  paths: AimyPaths,
  event: DisplayNameRenameEvent
): Effect.Effect<void, IdentityError> =>
  Effect.tryPromise({
    try: async () => {
      const file = path.join(paths.state, IDENTITY_AUDIT_FILE_NAME)
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      await fs.appendFile(file, JSON.stringify(event) + "\n", { mode: 0o600 })
      await fs.chmod(file, 0o600)
    },
    catch: () => new IdentityError({ reason: "identity-audit-unwritable" })
  })

/**
 * Rename this instance's display name.
 *
 * Returns the updated document and the audit event. The document is
 * re-validated through `migrateIdentityDocument` before it is written, so
 * the rename preserves `version`, `instanceId`, `createdAt`, `publicKey`,
 * and `pairingProtocolVersion` by construction — a rename can add nothing
 * and corrupt nothing.
 */
export const renameDisplayName = (
  service: IdentityServiceShape,
  paths: AimyPaths,
  displayName: string
): Effect.Effect<
  { readonly document: IdentityDocument; readonly event: DisplayNameRenameEvent },
  IdentityError
> =>
  Effect.gen(function* () {
    const name = yield* Schema.decodeUnknownEffect(DisplayNameSchema)(displayName).pipe(
      Effect.mapError(() => new IdentityError({ reason: "display-name-invalid" }))
    )
    const trimmed = name.trim()
    const previous = service.document.displayName ?? null
    if (previous === trimmed) {
      return yield* Effect.fail(new IdentityError({ reason: "display-name-unchanged" }))
    }
    // Preserve every field except displayName; the migration decode re-validates.
    const document = yield* migrateIdentityDocument({ ...service.document, displayName: trimmed })
    yield* writeFilePrivate(path.join(paths.config, IDENTITY_FILE_NAME), JSON.stringify(document, null, 2) + "\n")
    const event: DisplayNameRenameEvent = {
      kind: "display-name-renamed",
      at: new Date().toISOString(),
      instanceId: service.instanceId,
      previousDisplayName: previous,
      displayName: trimmed
    }
    yield* appendAuditEvent(paths, event)
    return { document, event }
  })
