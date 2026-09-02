/**
 * Per-site deterministic scripted flows, and the guardrails every one of them
 * runs inside.
 *
 * `MODULE_ID` predates the real surface: importing it exercises the workspace
 * link, the package `exports` map, and the build output, so a broken
 * toolchain fails a test rather than surfacing later as a confusing
 * resolution error.
 */
export const MODULE_ID = '@chief-of-staff/playbooks' as const;

export * from './guardrails/index.js';
export * from './runner/index.js';
