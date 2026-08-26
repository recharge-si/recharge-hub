import { prisma } from "~/adapters/db/client.server";
import { getCredential } from "~/adapters/db/repositories/metakocka-credential.server";
import { MetakockaClient } from "~/adapters/metakocka/client";
import { resolvePartner } from "~/adapters/metakocka/partners";
import {
  parseOrderSafe,
  type ParsedAddress,
} from "~/adapters/shopify/order-payload";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { parsePartnerOverride } from "~/domain/orders/partner";
import type { Principal } from "~/domain/types";

/**
 * How long a partner-resolution claim may sit unfinished before another job
 * may take it over. Matched to the MetaKocka client timeout with headroom, the
 * same reasoning as the document and payment claims.
 */
const PARTNER_CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * Makes sure an order knows which MetaKocka partner it belongs to.
 *
 * Called from the allocation job, which is the last point at which exactly one
 * job is handling the order. Resolving later, inside the per-source document
 * jobs, would let the several jobs of a split order look up the same customer
 * at the same time, find nothing, and each create their own partner — the very
 * duplication this is here to prevent.
 *
 * Idempotent: once the order carries an id, it is reused untouched.
 */
export async function ensureOrderPartner(
  principal: Principal,
  orderId: string,
): Promise<{ mkId: string; mkAddressId: string | null } | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      rawPayload: true,
      partnerOverride: true,
      metakockaPartnerMkId: true,
      metakockaPartnerAddressId: true,
    },
  });
  if (!order) return null;

  if (order.metakockaPartnerMkId) {
    return {
      mkId: order.metakockaPartnerMkId,
      mkAddressId: order.metakockaPartnerAddressId,
    };
  }

  /*
   * A hand-entered partner wins here too.
   *
   * It has to: this is what looks the partner up in MetaKocka and records the
   * id the document then references. Resolving from the payload while the
   * document was built from the override would file the order against one
   * customer and name another.
   */
  const override = parsePartnerOverride(order.partnerOverride);

  const parsed = parseOrderSafe(order.rawPayload);
  const address: ParsedAddress | null =
    override ?? parsed?.partner ?? parsed?.receiver ?? null;
  if (!address) return null;

  const credential = await getCredential(principal);
  if (!credential) return null;

  /*
   * Single-flight, refereed by the database.
   *
   * The comment above says allocation resolves the partner while one job owns
   * the order — and it does — but the per-source write jobs also land here as
   * a fallback after a blip, and two of them arriving together would both see
   * no `metakockaPartnerMkId`, both search MetaKocka, both find nothing and
   * both create the customer (§3: inline or duplicate partner creation is
   * exactly what partner resolution exists to prevent). The claim is the same
   * conditional-update pattern as the payment mark: one caller wins, the rest
   * throw and let the retry find the id already stored.
   */
  const now = new Date();
  const staleBefore = new Date(now.getTime() - PARTNER_CLAIM_LEASE_MS);
  const claimed = await prisma.order.updateMany({
    where: {
      id: orderId,
      metakockaPartnerMkId: null,
      OR: [
        { metakockaPartnerClaimedAt: null },
        { metakockaPartnerClaimedAt: { lt: staleBefore } },
      ],
    },
    data: { metakockaPartnerClaimedAt: now },
  });

  if (claimed.count === 0) {
    // Someone else is resolving, or has just finished. Re-read rather than
    // guess: a finished resolution is an answer, a running one is a retry.
    const current = await prisma.order.findUnique({
      where: { id: orderId },
      select: { metakockaPartnerMkId: true, metakockaPartnerAddressId: true },
    });
    if (current?.metakockaPartnerMkId) {
      return {
        mkId: current.metakockaPartnerMkId,
        mkAddressId: current.metakockaPartnerAddressId,
      };
    }
    throw new Error(
      `Partner for order ${orderId} is being resolved by another job; retrying will find it`,
    );
  }

  const client = new MetakockaClient({
    companyId: credential.companyId,
    secretKey: credential.secretKey,
  });

  let resolved;
  try {
    resolved = await resolvePartner(client, {
      customer: address.customer,
      street: address.street,
      postNumber: address.postNumber,
      place: address.place,
      country: address.country,
      taxNumber: override?.taxNumber ?? null,
      email: address.email,
      phone: address.phone,
      isBusiness: address.isBusiness,
    });
  } catch (error) {
    // Give the claim back so a retry does not have to wait out the lease.
    await prisma.order.updateMany({
      where: { id: orderId, metakockaPartnerMkId: null },
      data: { metakockaPartnerClaimedAt: null },
    });
    throw error;
  }

  await prisma.order.update({
    where: { id: orderId },
    data: {
      metakockaPartnerMkId: resolved.mkId,
      metakockaPartnerAddressId: resolved.mkAddressId,
    },
  });

  await appendEvent(principal, {
    entityType: "order",
    entityId: orderId,
    event: resolved.created ? "order.partner_created" : "order.partner_matched",
    detail: {
      mkId: resolved.mkId,
      customer: resolved.customer,
      countCode: resolved.countCode,
    },
  });

  return { mkId: resolved.mkId, mkAddressId: resolved.mkAddressId };
}
