import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import {
  countOutcomes,
  finishRun,
  mirrorMetafields,
  saveProgress,
  startRun,
  type MirrorWrite,
} from "~/adapters/db/repositories/bulk-values.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  readOwnerMetafields,
  writeMetafields,
  type MetafieldClear,
  type MetafieldWrite,
} from "~/adapters/shopify/product-workspace";
import { serviceToken } from "~/domain/types";
import { canonicalStored } from "~/domain/values/cells";
import type { PlannedChange } from "~/domain/values/import";

/**
 * Applying a stored preview of attribute values (docs/attributes.md
 * § Bulk values). Twenty-five values at a time, each batch:
 *
 * 1. re-reads the batch's values from Shopify;
 * 2. leaves alone a value that now differs from the one the preview saw
 *    ("changed meanwhile": someone edited it since), and one that already
 *    holds the wanted value (a run that stopped after writing);
 * 3. writes the rest in one `metafieldsSet` and `metafieldsDelete`, or, if
 *    Shopify refuses the call, value by value so one bad cell does not
 *    take twenty-four with it;
 * 4. mirrors what was written into the catalogue snapshot and stores every
 *    outcome.
 *
 * Resumable and idempotent: a change with an outcome is never visited
 * again, and one without is judged against Shopify as it is then.
 */

export const BATCH = 25;

/** Shopify's answer for a product or variant that has been deleted. */
const OWNER_GONE = /owner does not exist|does not exist/i;

export type Decision =
  | "write"
  | "unchanged"
  | "changed_meanwhile"
  | "gone";

/** What to do with one change given what Shopify holds for it now. */
export function decide(
  change: PlannedChange,
  live: { type: string; value: string } | undefined,
  ownerKnown: boolean,
): Decision {
  if (!ownerKnown) return "gone";
  const now = canonicalStored(change.kind, live);
  if (now === change.afterCanon) return "unchanged";
  if (now !== change.beforeCanon) return "changed_meanwhile";
  return "write";
}

const fullKey = (change: PlannedChange) => `${change.namespace}.${change.key}`;

function failure(
  errors: ReadonlyArray<{ message: string }>,
): `failed:${string}` | "gone" {
  const text = errors.map((error) => error.message).join("; ");
  if (OWNER_GONE.test(text)) return "gone";
  return `failed:${text.slice(0, 200)}`;
}

async function writeOne(
  admin: AdminApiContext,
  change: PlannedChange,
): Promise<"written" | "cleared" | "gone" | `failed:${string}`> {
  const outcome =
    change.op === "clear" || change.value === null
      ? await writeMetafields(admin, [], [clearOf(change)])
      : await writeMetafields(admin, [writeOf(change, change.value)], []);
  if (outcome.ok) return change.op === "clear" ? "cleared" : "written";
  return failure(outcome.errors);
}

const clearOf = (change: PlannedChange): MetafieldClear => ({
  ownerId: change.ownerId,
  namespace: change.namespace,
  key: change.key,
});

const writeOf = (change: PlannedChange, value: string): MetafieldWrite => ({
  ownerId: change.ownerId,
  namespace: change.namespace,
  key: change.key,
  type: change.shopifyType,
  value,
});

/** Works the batch at these indexes; returns each one's outcome. */
export async function applyBatch(
  admin: AdminApiContext,
  changes: readonly PlannedChange[],
  indexes: readonly number[],
): Promise<Map<number, string>> {
  const outcomes = new Map<number, string>();
  const batch = indexes.map((i) => ({ i, change: changes[i] as PlannedChange }));
  const live = await readOwnerMetafields(
    admin,
    batch.map(({ change }) => change.ownerId),
    batch.map(({ change }) => fullKey(change)),
  );

  const toWrite: typeof batch = [];
  for (const { i, change } of batch) {
    const map = live.get(change.ownerId);
    const decision = decide(change, map?.[fullKey(change)], map !== undefined);
    if (decision === "write") toWrite.push({ i, change });
    else outcomes.set(i, decision);
  }
  if (toWrite.length === 0) return outcomes;

  const sets = toWrite.filter(({ change }) => change.op === "set" && change.value !== null);
  const clears = toWrite.filter(({ change }) => !(change.op === "set" && change.value !== null));
  const refused = await writeMetafields(
    admin,
    sets.map(({ change }) => writeOf(change, change.value ?? "")),
    clears.map(({ change }) => clearOf(change)),
  );
  if (refused.ok) {
    for (const { i } of sets) outcomes.set(i, "written");
    for (const { i } of clears) outcomes.set(i, "cleared");
  } else {
    // Shopify refused the call, perhaps for one cell. Each value goes on its
    // own so the rest are written and the refused one says why; a value the
    // refused call had already written is written again, to the same value.
    for (const { i, change } of toWrite) outcomes.set(i, await writeOne(admin, change));
  }
  return outcomes;
}

function mirrorOf(change: PlannedChange, outcome: string): MirrorWrite | null {
  if (outcome === "written" && change.value !== null)
    return {
      ownerId: change.ownerId,
      scope: change.scope,
      name: fullKey(change),
      stored: { type: change.shopifyType, value: change.value },
    };
  if (outcome === "cleared")
    return {
      ownerId: change.ownerId,
      scope: change.scope,
      name: fullKey(change),
      stored: null,
    };
  return null;
}

/**
 * Runs one stored import to its end. Returns when every change has an
 * outcome. A Shopify call that throws leaves the import `failed` with what
 * is done kept, for the person to continue.
 */
export async function runBulkApply(
  admin: AdminApiContext,
  shopDomain: string,
  importId: string,
): Promise<void> {
  const run = await startRun(shopDomain, importId);
  if (!run) return;
  const principal = serviceToken(shopDomain, "bulk-values-apply");
  const { changes, outcomes } = run;

  try {
    const pending = outcomes.flatMap((o, i) => (o === null ? [i] : []));
    for (let start = 0; start < pending.length; start += BATCH) {
      const indexes = pending.slice(start, start + BATCH);
      const result = await applyBatch(admin, changes, indexes);
      const mirrors: MirrorWrite[] = [];
      for (const [i, outcome] of result) {
        outcomes[i] = outcome;
        const mirror = mirrorOf(changes[i] as PlannedChange, outcome);
        if (mirror) mirrors.push(mirror);
      }
      await mirrorMetafields(shopDomain, mirrors);
      await saveProgress(shopDomain, importId, outcomes);
    }
  } catch (error) {
    await saveProgress(shopDomain, importId, outcomes);
    await finishRun(shopDomain, importId, {
      status: "failed",
      lastError:
        "Shopify could not be reached or refused the request part way. Values already written are kept; press Continue to finish the rest.",
    });
    throw error;
  }

  await finishRun(shopDomain, importId, { status: "done" });
  const counts = countOutcomes(outcomes);
  // Counts only, never a value.
  await appendEvent(principal, {
    entityType: "product_values_import",
    entityId: importId,
    event: "product.values_imported",
    detail: { ...counts, total: changes.length },
  });
}
