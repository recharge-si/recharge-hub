import type { Allowed } from "./ui-rules";

/** Violations known at the start of PRD 3; each story removes its own. Empty: all fixed or allowlisted with a reason in ui-rules.test.ts. */
export const PENDING: Record<string, Allowed[]> = {};
