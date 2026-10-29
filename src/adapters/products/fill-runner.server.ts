import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  failAutofill,
  nextUnaskedProducts,
  recordNothingSuggested,
  saveAutofillSuggestion,
} from "~/adapters/db/repositories/product-autofill.server";
import { assignmentsFor } from "~/adapters/db/repositories/product-type-assignment.server";
import {
  catalogueForFill,
  type FillCatalogueProduct,
} from "~/adapters/db/repositories/rig-catalogue.server";
import { recordUsage } from "~/adapters/db/repositories/translations.server";
import {
  poolResetWaitMs,
  runClaudePool,
  type ClaudePoolResult,
} from "~/adapters/ai/claude-pool.server";
import {
  activeAttributes,
  isWithin,
  pathOf,
} from "~/domain/attributes/resolve";
import { RIG_TYPES, type RigTypeId } from "~/domain/attributes/rig-pack";
import {
  assignableTypes,
  attributeFields,
  inputsFrom,
} from "~/domain/products/attribute-values";
import {
  attributesToFill,
  type AutofillValue,
} from "~/domain/products/autofill";
import {
  FILL_ATTRIBUTE_LIMIT,
  buildFillPrompt,
  parseFillReply,
} from "~/domain/products/fill";
import { typeForProduct } from "~/domain/products/workspace";
import { serviceToken } from "~/domain/types";

/**
 * The operator's bulk filler (docs/attributes.md § Bulk filling with
 * claude-pool): walks the catalogue, asks Claude through claude-pool for the
 * empty attributes of each product that has a type, and stores the answers
 * in `product_autofill` for the usual review. Nothing here writes to Shopify.
 *
 * Progress is the table: a product is written once it has been answered
 * (`ready`, or `discarded` when there was nothing to suggest) or given up
 * on (`failed`), and "autofill all"'s rule — ask products with no row or a
 * failed one — makes a restart pick up where the last run stopped. Pool
 * exhaustion (exit 75) pauses every worker until an account resets and
 * never fails a product.
 */

export const FILL_SOURCE = "claude-pool";
const PROMPT_VERSION = "fill-1";
const PAGE = 50;
/** Replies in a row that may be unusable before one product is given up on. */
export const MAX_ATTEMPTS = 3;

export interface FillRunOptions {
  shopDomain: string;
  /** Only products of these rig types (and types beneath them); null is every type. */
  types: readonly RigTypeId[] | null;
  /** Stop after asking about this many products; null is the whole catalogue. */
  limit: number | null;
  concurrency: number;
  model?: string;
  timeoutMs?: number;
  log: (line: string) => void;
  /** Stops the run after the products in flight. */
  shouldStop?: () => boolean;
  /** Injected so tests need neither a clock nor a pool. */
  ask?: (
    prompt: string,
    options: { model?: string; timeoutMs?: number; maxConcurrent: number },
  ) => Promise<ClaudePoolResult<string>>;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: () => Promise<number>;
}

export interface FillRunSummary {
  asked: number;
  suggested: number;
  values: number;
  nothing: number;
  failed: number;
  noType: number;
  nothingToFill: number;
  pauses: number;
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The type ids a `--types` filter allows: each named rig type and everything beneath it. */
function allowedTypeIds(
  schema: Awaited<ReturnType<typeof getAttributeSchema>>["schema"],
  wanted: readonly RigTypeId[] | null,
): Set<string> | null {
  if (wanted === null) return null;
  const roots = RIG_TYPES.filter((rig) => wanted.includes(rig.id))
    .map((rig) =>
      schema.types.find((t) => t.name.toLowerCase() === rig.name.toLowerCase()),
    )
    .flatMap((type) => (type ? [type.id] : []));
  return new Set(
    schema.types
      .filter((type) => roots.some((root) => isWithin(schema, type.id, root)))
      .map((type) => type.id),
  );
}

export async function runFill(
  options: FillRunOptions,
): Promise<FillRunSummary> {
  const principal = serviceToken(options.shopDomain, "fill-attributes");
  const ask = options.ask ?? ((prompt, o) => runClaudePool(prompt, o));
  const sleep = options.sleep ?? realSleep;
  const waitMs = options.waitMs ?? (() => poolResetWaitMs());
  const { log } = options;

  const { schema } = await getAttributeSchema(principal);
  if (assignableTypes(schema).length === 0)
    throw new Error(
      "The plan has no product types products can use. Set up Product setup first.",
    );
  const allowed = allowedTypeIds(schema, options.types);
  if (allowed !== null && allowed.size === 0)
    throw new Error("None of the requested types are in the plan.");

  const summary: FillRunSummary = {
    asked: 0,
    suggested: 0,
    values: 0,
    nothing: 0,
    failed: 0,
    noType: 0,
    nothingToFill: 0,
    pauses: 0,
  };

  /** Every worker waits for an account to reset when the pool says it is full. */
  let pausedUntil = 0;
  const gate = async () => {
    for (;;) {
      const left = pausedUntil - Date.now();
      if (left <= 0) return;
      await sleep(left);
    }
  };

  async function fillOne(item: Prepared): Promise<void> {
    summary.asked += 1;
    const asks = chunks(item.ask, FILL_ATTRIBUTE_LIMIT);
    const collected = new Map<string, AutofillValue>();
    let model: string | null = null;
    let failure: string | null = null;

    for (const chunk of asks) {
      const prompt = buildFillPrompt(
        item.row.product,
        { path: pathOf(schema, item.typeId) },
        chunk,
      );
      let attempts = 0;
      for (;;) {
        await gate();
        if (options.shouldStop?.() && attempts === 0 && collected.size === 0) {
          // Stopped before anything was asked: leave the product without a row.
          summary.asked -= 1;
          return;
        }
        const result = await ask(prompt, {
          ...(options.model ? { model: options.model } : {}),
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          maxConcurrent: options.concurrency,
        });
        if (!result.ok && result.reason === "exhausted") {
          const wait = await waitMs();
          pausedUntil = Math.max(pausedUntil, Date.now() + wait);
          summary.pauses += 1;
          log(
            `The pool is full. Waiting ${Math.round(wait / 60000)} min for an account to reset.`,
          );
          continue;
        }
        if (!result.ok) {
          attempts += 1;
          failure =
            result.reason === "error"
              ? result.message
              : `The call ended with ${result.reason}.`;
        } else {
          model = result.model ?? model;
          const reading = parseFillReply(
            result.text,
            item.fields,
            item.inputs,
            item.variantIds,
          );
          await record(
            item.row.productId,
            result.model,
            result.usage,
            reading.valid,
          );
          if (reading.valid) {
            for (const value of reading.values) collected.set(value.key, value);
            failure = null;
            break;
          }
          attempts += 1;
          failure = "The reply was not the JSON that was asked for.";
        }
        if (attempts >= MAX_ATTEMPTS) break;
      }
      if (failure !== null) break;
    }

    if (failure !== null) {
      await failAutofill(principal, item.row.productId, failure, FILL_SOURCE);
      summary.failed += 1;
      log(`failed  ${item.row.productId}: ${failure}`);
      return;
    }
    const values = [...collected.values()];
    if (values.length === 0) {
      await recordNothingSuggested(
        principal,
        item.row.productId,
        { source: FILL_SOURCE, model },
        item.typeId,
      );
      summary.nothing += 1;
      log(`nothing ${item.row.productId}`);
      return;
    }
    await saveAutofillSuggestion(principal, item.row.productId, {
      typeId: item.typeId,
      typeOrigin: "kept",
      typeConfidence: null,
      typeReason: null,
      values,
      engine: FILL_SOURCE,
      source: FILL_SOURCE,
      model,
    });
    summary.suggested += 1;
    summary.values += values.length;
    log(`ready   ${item.row.productId}: ${values.length} values`);
  }

  async function record(
    productId: string,
    model: string | null,
    usage: {
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
    },
    readable: boolean,
  ): Promise<void> {
    // The pool is a subscription: the request is counted, never priced.
    await recordUsage(principal, {
      syncId: null,
      resourceId: productId,
      resourceType: "product",
      sourceLocale: "en",
      targetLocale: "en",
      purpose: "autofill",
      promptVersion: PROMPT_VERSION,
      model: model ?? FILL_SOURCE,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
      result: readable ? "ok" : "failed",
      errorMessage: readable ? null : "Unreadable reply",
      pricingVersion: null,
      estimatedCostMicros: null,
    });
  }

  interface Prepared {
    row: FillCatalogueProduct;
    typeId: string;
    fields: ReturnType<typeof attributeFields>;
    inputs: ReturnType<typeof inputsFrom>;
    variantIds: string[];
    ask: ReturnType<typeof attributesToFill>;
  }

  function prepare(
    row: FillCatalogueProduct,
    chosenTypeId: string | null,
  ): Prepared | "no_type" | "other_type" | "nothing_to_fill" {
    const match = typeForProduct(schema, {
      categoryName: row.categoryName,
      categoryFullName: null,
      productType: row.productType,
      chosenTypeId,
    });
    if (match.kind !== "matched") return "no_type";
    if (allowed !== null && !allowed.has(match.typeId)) return "other_type";
    if (activeAttributes(schema, match.typeId).length === 0)
      return "nothing_to_fill";
    const fields = attributeFields(schema, match.typeId, {
      definitions: new Map(),
      product: row.metafields,
      variants: row.variants.map((variant) => variant.metafields),
    });
    const inputs = inputsFrom(fields, row.metafields, row.variants);
    const variantIds = row.variants.map((variant) => variant.variantId);
    const toAsk = attributesToFill(fields, inputs, variantIds);
    if (toAsk.length === 0) return "nothing_to_fill";
    return {
      row,
      typeId: match.typeId,
      fields,
      inputs,
      variantIds,
      ask: toAsk,
    };
  }

  let after: string | null = null;
  walk: for (;;) {
    if (options.shouldStop?.()) break;
    const page: { ids: string[]; next: string | null } =
      await nextUnaskedProducts(principal, after, PAGE);
    if (page.ids.length > 0) {
      const rows = await catalogueForFill(principal, page.ids);
      const chosen = await assignmentsFor(principal, page.ids);
      const work: Prepared[] = [];
      for (const row of rows) {
        const prepared = prepare(
          row,
          chosen.get(row.productId)?.typeId ?? null,
        );
        if (prepared === "no_type") summary.noType += 1;
        else if (prepared === "nothing_to_fill") summary.nothingToFill += 1;
        else if (prepared !== "other_type") work.push(prepared);
      }
      const room =
        options.limit === null ? work.length : options.limit - summary.asked;
      await parallel(
        work.slice(0, Math.max(0, room)),
        options.concurrency,
        fillOne,
      );
      if (options.limit !== null && summary.asked >= options.limit) break walk;
    }
    if (page.next === null) break;
    after = page.next;
  }

  await appendEvent(principal, {
    entityType: "product_autofill",
    event: "product.autofill_bulk_run",
    detail: { source: FILL_SOURCE, ...summary },
  });
  return summary;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/** `limit` workers over the items; an item's own failure is its own, never the run's. */
async function parallel<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      await work(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
}
