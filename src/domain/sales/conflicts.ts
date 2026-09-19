import type { ConflictStrategy } from "~/domain/sales/types";

/**
 * Two campaigns, one variant (docs/sale-campaigns.md § Conflicts).
 *
 * The strategy is the challenger's — the campaign being activated or, under
 * dynamic membership, the one that has just started matching. The holder is
 * whichever campaign currently owns the variant's sale state. Prices never
 * stack: the answer is one campaign or a refusal, never both.
 */

export interface Contender {
  id: string;
  priority: number;
  /** `created_at` as epoch milliseconds. */
  createdAtMs: number;
  /** The reduction this campaign takes on this variant, in basis points. */
  discountBp: number;
}

export type ConflictOutcome = "challenger" | "holder" | "refuse";

export function resolveConflict(
  strategy: ConflictStrategy,
  challenger: Contender,
  holder: Contender,
): ConflictOutcome {
  switch (strategy) {
    case "prevent":
      return "refuse";
    case "priority":
      if (challenger.priority === holder.priority) return "refuse";
      return challenger.priority > holder.priority ? "challenger" : "holder";
    case "largest_discount":
      // A tie keeps the holder: nothing is gained by moving a price to itself.
      return challenger.discountBp > holder.discountBp
        ? "challenger"
        : "holder";
    case "newest":
      if (challenger.createdAtMs === holder.createdAtMs) return "refuse";
      return challenger.createdAtMs > holder.createdAtMs
        ? "challenger"
        : "holder";
  }
}

/** Whether two schedules can be live at the same moment. Null means open-ended. */
export function windowsOverlap(
  a: { startsAt: number | null; endsAt: number | null },
  b: { startsAt: number | null; endsAt: number | null },
): boolean {
  const aStart = a.startsAt ?? Number.NEGATIVE_INFINITY;
  const aEnd = a.endsAt ?? Number.POSITIVE_INFINITY;
  const bStart = b.startsAt ?? Number.NEGATIVE_INFINITY;
  const bEnd = b.endsAt ?? Number.POSITIVE_INFINITY;
  return aStart < bEnd && bStart < aEnd;
}
