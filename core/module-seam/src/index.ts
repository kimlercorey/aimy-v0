/**
 * module-seam — the ModuleHost adaptive seam for Project AImy.
 *
 * Out-of-process module system (MCP-style) behind a capability manifest:
 * lifecycle-hook taxonomy, deterministic lifecycle state machine, SKILL.md
 * frontmatter + capability validation, hybrid sandbox posture, instance
 * awareness, and the budget-capped skill index.
 */
export * from "./errors.js"
export * from "./kernel-seam.js"
export * from "./hooks.js"
export * from "./lifecycle.js"
export * from "./manifest.js"
export * from "./sandbox.js"
export * from "./instance.js"
export * from "./skill-index.js"
export * from "./host.js"
