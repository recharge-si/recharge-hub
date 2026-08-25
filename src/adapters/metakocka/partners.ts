import { z } from "zod";

import {
  mkEnvelopeSchema,
  type MetakockaClient,
} from "~/adapters/metakocka/client";
import { ENDPOINTS } from "~/adapters/metakocka/endpoints";
import { MetakockaError } from "~/adapters/metakocka/errors";

/**
 * Finding or creating the MetaKocka partner an order belongs to.
 *
 * **[verified] This module exists because inline partner data creates a new
 * partner every time.** Sending `partner: { customer, street, ... }` on a
 * document does not match an existing record — it makes another one. Two
 * documents for the same customer left company 6789 with two "Grega Rotar"
 * partners (`684/2026` and `686/2026`), and a busy shop would accumulate one
 * per order until the partner list is unusable and nobody's history is in one
 * place.
 *
 * So the partner is resolved explicitly: look it up, and only create one when
 * there genuinely is none.
 *
 * **[verified] Linking needs an address as well as an id.** A document sent
 * with `partner: { mk_id }` alone is refused —
 * `"Partner must have mk_address_id or customer and street for address
 * identification."` — so a resolved partner carries its address id too, and a
 * document referencing both links without creating anything.
 */

const addressSchema = z
  .object({
    mk_id: z.union([z.string(), z.number()]).transform(String),
    address_type: z.string().optional(),
    street: z.string().optional(),
  })
  .passthrough();

const partnerSchema = z
  .object({
    mk_id: z.union([z.string(), z.number()]).transform(String),
    count_code: z.string().optional(),
    customer: z.string().optional(),
    partner_delivery_address_list: z.array(addressSchema).default([]),
  })
  .passthrough();

const getPartnerSchema = mkEnvelopeSchema.and(
  z
    .object({
      partner_list: z.array(partnerSchema).default([]),
    })
    .passthrough(),
);

const addPartnerSchema = mkEnvelopeSchema.and(
  z
    .object({
      mk_id: z.union([z.string(), z.number()]).transform(String),
      mk_address_id_list: z
        .array(
          z
            .object({
              mk_id: z.union([z.string(), z.number()]).transform(String),
              street: z.string().optional(),
            })
            .passthrough(),
        )
        .default([]),
    })
    .passthrough(),
);

/** A partner as this app needs to reference it on a document. */
export interface ResolvedPartner {
  mkId: string;
  /** Required alongside the id; MetaKocka refuses an id with no address. */
  mkAddressId: string | null;
  countCode: string | null;
  customer: string;
  /** True when this call created the partner rather than finding one. */
  created: boolean;
}

export interface PartnerLookup {
  customer: string;
  street: string | null;
  postNumber: string | null;
  place: string | null;
  country: string | null;
  taxNumber: string | null;
  email: string | null;
  phone: string | null;
  isBusiness: boolean;
}

/** MetaKocka's way of saying a search matched nothing. */
function isNoMatch(error: unknown): boolean {
  return (
    error instanceof MetakockaError &&
    /no partner with such properties/i.test(error.oprDesc ?? "")
  );
}

function billingAddressOf(
  partner: z.infer<typeof partnerSchema>,
): string | null {
  const addresses = partner.partner_delivery_address_list;
  // "Račun" is the billing address type, and the one a sales order belongs on.
  const billing = addresses.find((address) => address.address_type === "Račun");
  return (billing ?? addresses[0])?.mk_id ?? null;
}

/**
 * Searches for an existing partner.
 *
 * Ordered by how strongly each field identifies a person or company. A tax
 * number is unique by law; an email is unique in practice; a name is neither —
 * searching company 6789 for "Grega Rotar" returns two records, so a name match
 * is a last resort and only trusted when it is unambiguous.
 */
export async function findPartner(
  client: MetakockaClient,
  lookup: PartnerLookup,
): Promise<ResolvedPartner | null> {
  const queries: Record<string, string>[] = [];
  if (lookup.taxNumber?.trim())
    queries.push({ partner_tax_number: lookup.taxNumber.trim() });
  if (lookup.email?.trim())
    queries.push({ partner_email: lookup.email.trim() });
  if (lookup.customer.trim())
    queries.push({ partner_name: lookup.customer.trim() });

  for (const query of queries) {
    // **[verified] "Not found" arrives as a failure, not an empty list.**
    // `get_partner` answers `opr_code 2, "No partner with such properties."`
    // when nothing matches, and the client turns any non-zero code into a throw.
    // Left unhandled that is not a failed search but a failed *job*: it took
    // down the document write after the count_code had been claimed, and the
    // claim then blocked every retry. A search that finds nothing is a normal
    // outcome and moves on to the next one.
    const response = await client
      .call(ENDPOINTS.getPartner, query, getPartnerSchema)
      .catch((error: unknown) => {
        if (isNoMatch(error)) return null;
        throw error;
      });

    if (!response) continue;

    const matches = response.partner_list;
    if (matches.length === 0) continue;

    // The first match wins when a search is ambiguous, which in practice only
    // happens on a name: company 6789 already holds two "Grega Rotar" records.
    // Creating yet another would be the worse answer, and MetaKocka returns
    // them in creation order, so the oldest — the one a customer's history
    // hangs off — is the one taken.
    const partner = matches[0]!;
    return {
      mkId: partner.mk_id,
      mkAddressId: billingAddressOf(partner),
      countCode: partner.count_code ?? null,
      customer: partner.customer ?? lookup.customer,
      created: false,
    };
  }

  return null;
}

/** Creates a partner, flagged as a buyer, and returns it ready to reference. */
export async function addPartner(
  client: MetakockaClient,
  lookup: PartnerLookup,
): Promise<ResolvedPartner> {
  const response = await client.call(
    ENDPOINTS.addPartner,
    {
      partner: {
        business_entity: lookup.isBusiness ? "true" : "false",
        taxpayer: lookup.isBusiness ? "true" : "false",
        foreign_county: "false",
        // Everything this app creates is somebody who bought something.
        buyer: "true",
        supplier: "false",
        ...(lookup.taxNumber ? { tax_id_number: lookup.taxNumber } : {}),
        customer: lookup.customer,
        ...(lookup.street ? { street: lookup.street } : {}),
        ...(lookup.postNumber ? { post_number: lookup.postNumber } : {}),
        ...(lookup.place ? { place: lookup.place } : {}),
        ...(lookup.country ? { country: lookup.country } : {}),
        ...(lookup.email || lookup.phone
          ? {
              partner_contact: {
                name: lookup.customer,
                ...(lookup.email ? { email: lookup.email } : {}),
                ...(lookup.phone
                  ? { phone: lookup.phone, gsm: lookup.phone }
                  : {}),
              },
            }
          : {}),
      },
    },
    addPartnerSchema,
  );

  return {
    mkId: response.mk_id,
    mkAddressId: response.mk_address_id_list[0]?.mk_id ?? null,
    countCode: null,
    customer: lookup.customer,
    created: true,
  };
}

/**
 * The partner for an order: the existing one if there is one, a new one if not.
 *
 * Deliberately not "create and let MetaKocka sort it out". Searching first is
 * what stops a customer's second order becoming their second partner record.
 */
export async function resolvePartner(
  client: MetakockaClient,
  lookup: PartnerLookup,
): Promise<ResolvedPartner> {
  const existing = await findPartner(client, lookup);
  if (existing) return existing;
  return addPartner(client, lookup);
}
