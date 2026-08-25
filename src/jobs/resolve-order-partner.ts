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

  const client = new MetakockaClient({
    companyId: credential.companyId,
    secretKey: credential.secretKey,
  });

  const resolved = await resolvePartner(client, {
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
