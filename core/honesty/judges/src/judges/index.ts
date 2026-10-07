/**
 * honesty/judges/judges/index.ts
 *
 * The reference judge set shipped with M3. Every judge is `judge-id@1.0.0`,
 * pure, and deterministic. Register them with `referenceJudges()` to get a
 * ready-made `JudgeRegistry`.
 */
import { JudgeRegistry } from "../registry.js"
import { claimHasEvidence } from "./claim-has-evidence.js"
import { noUndeclaredSideEffects } from "./no-undeclared-side-effects.js"
import { toolSuccessMatchesSideEffects } from "./tool-success-matches-side-effects.js"

export { claimHasEvidence } from "./claim-has-evidence.js"
export { noUndeclaredSideEffects } from "./no-undeclared-side-effects.js"
export { toolSuccessMatchesSideEffects } from "./tool-success-matches-side-effects.js"

/** A registry pre-loaded with the three M3 reference judges. */
export const referenceJudges = (): JudgeRegistry =>
  JudgeRegistry.from([toolSuccessMatchesSideEffects, noUndeclaredSideEffects, claimHasEvidence])
