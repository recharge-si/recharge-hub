/**
 * The vocabulary the allocator works in.
 *
 * Deliberately none of it is a database row. `domain/` imports nothing from
 * `adapters/` (CLAUDE.md section 5), so the job maps Prisma models into these
 * shapes and maps the answer back. That is what keeps the highest-risk logic in
 * the system testable in milliseconds.
 */

export interface AllocationLine {
  /** `order_line.id`. Opaque here. */
  lineId: string;
  sku: string;
  quantity: number;
}

export type SourceKind = "own" | "partner";

/** How much of one SKU one supply source can currently offer. */
export interface SupplyLevel {
  sourceId: string;
  /** Used in the tie-break and in `count_code`, so it is part of the decision. */
  sourceCode: string;
  sku: string;
  /** Stock this app believes is free to sell. Never negative. */
  available: number;
  kind: SourceKind;
  /** Lower runs first. */
  priority: number;
  /**
   * False means this source will not take part of a line: it fills the whole
   * remaining quantity or none of it. A partner who will not accept a partial
   * order is the case this exists for.
   */
  canSplit: boolean;
  enabled: boolean;
}

/**
 * v1 has one rule and it is expressed as an ordering, not as data. M6 moves it
 * into `allocation_rule` rows; the shape is here so that move does not change
 * the allocator's signature.
 */
export interface AllocationRule {
  id: string;
  /** Only "prefer" exists in v1: order the sources and take them in turn. */
  kind: "prefer";
  /** Source kinds in the order they should be tried. */
  order: SourceKind[];
  /** Whether a line may be spread across more than one source at all. */
  allowSplit: boolean;
}

/** Own stock first, then partners, splitting allowed. CLAUDE.md section 13, M4. */
export const DEFAULT_RULE: AllocationRule = {
  id: "own-first",
  kind: "prefer",
  order: ["own", "partner"],
  allowSplit: true,
};

/**
 * Why one quantity went where it did. Stored on `allocation.reason` and shown
 * on the order page: the audit trail is a product feature, not debug output
 * (section 6), and "why did this go to the partner" is the question this app
 * exists to answer.
 */
export interface AllocationReason {
  rule: string;
  /** A sentence a merchant can read. */
  detail: string;
  /** What the numbers were at the moment of the decision. */
  availableAtSource: number;
  remainingBefore: number;
}

export interface LineAllocation {
  lineId: string;
  sku: string;
  /** Null when nothing could satisfy it and a human has to decide. */
  sourceId: string | null;
  quantity: number;
  reason: AllocationReason;
}

export interface Shortfall {
  lineId: string;
  sku: string;
  /** How much of the line nothing could cover. */
  quantity: number;
}

export interface AllocationResult {
  allocations: LineAllocation[];
  /** Lines that could not be filled. Each becomes an exception (section 8.2). */
  shortfalls: Shortfall[];
}

export interface AllocationInput {
  lines: AllocationLine[];
  supply: SupplyLevel[];
  rules: AllocationRule[];
  /** Injected, never read from the clock (section 5). */
  now: Date;
}
