import { z } from "zod";

/**
 * The mandatory compliance webhook payloads (CLAUDE.md section 2.1.6), parsed at
 * the boundary. `passthrough` is deliberate: Shopify adds fields over time and a
 * strict schema would turn a new field into a failed redaction.
 */
const customerRef = z
  .object({
    id: z.union([z.number(), z.string()]).optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
  })
  .passthrough();

export const shopRedactSchema = z
  .object({
    shop_id: z.union([z.number(), z.string()]),
    shop_domain: z.string(),
  })
  .passthrough();

export const customersRedactSchema = z
  .object({
    shop_id: z.union([z.number(), z.string()]),
    shop_domain: z.string(),
    customer: customerRef,
    orders_to_redact: z.array(z.union([z.number(), z.string()])).default([]),
  })
  .passthrough();

export const customersDataRequestSchema = z
  .object({
    shop_id: z.union([z.number(), z.string()]),
    shop_domain: z.string(),
    customer: customerRef,
    orders_requested: z.array(z.union([z.number(), z.string()])).default([]),
    data_request: z
      .object({ id: z.union([z.number(), z.string()]) })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type ShopRedactPayload = z.infer<typeof shopRedactSchema>;
export type CustomersRedactPayload = z.infer<typeof customersRedactSchema>;
export type CustomersDataRequestPayload = z.infer<
  typeof customersDataRequestSchema
>;

/** The envelope every webhook-triggered job carries. */
export const webhookJobSchema = z.object({
  shopDomain: z.string().min(1),
  webhookId: z.string().min(1),
  topic: z.string().min(1),
  payload: z.unknown(),
});

export type WebhookJob = z.infer<typeof webhookJobSchema>;
