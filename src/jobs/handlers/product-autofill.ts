import type { Job } from "pg-boss";
import { z } from "zod";

import {
  failAutofill,
  nextReadyAutofills,
  nextUnaskedProducts,
  queueAutofills,
} from "~/adapters/db/repositories/product-autofill.server";
import { getLogger } from "~/adapters/observability/logger.server";
import {
  applyAutofill,
  autofillAvailability,
  suggestAutofill,
} from "~/adapters/products/autofill.server";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { unauthenticated } from "~/adapters/shopify/shopify.server";
import { serviceToken } from "~/domain/types";

export const productAutofillJobSchema = z.object({
  shopDomain: z.string().min(1),
  productIds: z.array(z.string().min(1)).max(250).default([]),
  /**
   * "Autofill all": walk the catalogue a pass at a time from after this
   * product id (null from the start), instead of a list.
   */
  all: z.object({ after: z.string().nullable() }).optional(),
  /**
   * Apply suggestions instead of asking for them: these products, or with
   * `ids` null every suggestion waiting, walked from after `after`.
   */
  apply: z
    .object({
      ids: z.array(z.string().min(1)).max(250).nullable(),
      after: z.string().nullable(),
    })
    .optional(),
  /** False for a source set to suggest the type only. */
  fillAttributes: z.boolean().default(true),
  /** True for a source set to apply confident suggestions at once. */
  autoApply: z.boolean().default(false),
  requestedBy: z.string().nullable().default(null),
});

/** Products per pass: a categorize batch, then one attribute call each. */
const PASS = 10;

/**
 * AI autofill for a list of products (docs/attributes.md § AI autofill): a
 * pass suggests for the first ten and hands the rest to a fresh job, so a
 * long list never outlives a job's expiry and a crash costs ten products,
 * not all of them. Each product's suggestion or failure is recorded on its
 * `product_autofill` row, which is what the pages watch.
 *
 * Failures the portal or Shopify explain are recorded per product inside
 * `suggestAutofill`. Anything else marks the pass's products failed — a
 * person presses again — rather than retrying the AI calls unseen and
 * leaving the products shown as queued meanwhile.
 */
export async function handleProductAutofill(job: Job<unknown>): Promise<void> {
  const {
    shopDomain,
    productIds,
    fillAttributes,
    autoApply,
    requestedBy,
    all,
    apply,
  } = productAutofillJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "product-autofill");
  if (apply) {
    await applyPass(principal, shopDomain, apply, requestedBy);
    return;
  }
  if (all) {
    await autofillAllPass(principal, shopDomain, all.after, {
      fillAttributes,
      autoApply,
      requestedBy,
    });
    return;
  }
  const pass = productIds.slice(0, PASS);
  const rest = productIds.slice(PASS);

  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    await suggestAutofill(admin, principal, pass, {
      fillAttributes,
      autoApply,
      requestedBy,
    });
  } catch (error) {
    getLogger().error(
      { err: error, shopDomain },
      "Product autofill pass failed",
    );
    for (const id of pass)
      await failAutofill(
        principal,
        id,
        "Suggestions could not be made just now. Try again.",
      );
  }

  if (rest.length > 0)
    await enqueue(QUEUES.productAutofill, {
      shopDomain,
      productIds: rest,
      fillAttributes,
      autoApply,
      requestedBy,
    });
}

/**
 * One pass of "autofill all" (docs/attributes.md § AI autofill): the next
 * ten products the AI has not been asked about are marked queued and
 * suggested for, then the walk hands over to a fresh job from the last
 * product it looked at. It stops at the end of the catalogue, or when the
 * portal cannot be asked, rather than failing every product left.
 */
async function autofillAllPass(
  principal: ReturnType<typeof serviceToken>,
  shopDomain: string,
  after: string | null,
  options: {
    fillAttributes: boolean;
    autoApply: boolean;
    requestedBy: string | null;
  },
): Promise<void> {
  const log = getLogger();
  const available = await autofillAvailability(principal);
  if (!available.ok) {
    log.warn(
      { shopDomain, reason: available.message },
      "Autofill all stopped: the portal cannot be asked",
    );
    return;
  }
  const { ids, next } = await nextUnaskedProducts(principal, after, PASS);
  const queued = await queueAutofills(principal, ids, options.requestedBy);
  if (queued.length > 0) {
    try {
      const { admin } = await unauthenticated.admin(shopDomain);
      await suggestAutofill(admin, principal, queued, options);
    } catch (error) {
      log.error({ err: error, shopDomain }, "Autofill all pass failed");
      for (const id of queued)
        await failAutofill(
          principal,
          id,
          "Suggestions could not be made just now. Try again.",
        );
    }
  }
  if (next !== null)
    await enqueue(QUEUES.productAutofill, {
      shopDomain,
      all: { after: next },
      fillAttributes: options.fillAttributes,
      autoApply: options.autoApply,
      requestedBy: options.requestedBy,
    });
}

/**
 * One pass of a background apply (docs/attributes.md § AI autofill): ten
 * suggestions applied as a press of Apply applies them, then the rest
 * handed to a fresh job. A suggestion Shopify refuses stays waiting and is
 * stepped over; one already decided is a no-op.
 */
async function applyPass(
  principal: ReturnType<typeof serviceToken>,
  shopDomain: string,
  apply: { ids: string[] | null; after: string | null },
  actor: string | null,
): Promise<void> {
  const log = getLogger();
  const batch = apply.ids
    ? apply.ids.slice(0, PASS)
    : await nextReadyAutofills(principal, apply.after, PASS);
  if (batch.length === 0) return;

  const { admin } = await unauthenticated.admin(shopDomain);
  for (const productId of batch) {
    try {
      const outcome = await applyAutofill(admin, principal, {
        productId,
        actor,
        keepType: true,
        keepValues: null,
      });
      if (!outcome.ok)
        log.warn(
          { productId, message: outcome.message },
          "Suggestion not applied",
        );
    } catch (error) {
      log.warn({ err: error, productId }, "Suggestion not applied");
    }
  }

  const following = apply.ids
    ? apply.ids.length > PASS
      ? { ids: apply.ids.slice(PASS), after: null }
      : null
    : batch.length === PASS
      ? { ids: null, after: batch.at(-1) ?? null }
      : null;
  if (following)
    await enqueue(QUEUES.productAutofill, {
      shopDomain,
      apply: following,
      requestedBy: actor,
    });
}
