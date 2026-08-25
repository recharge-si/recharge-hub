import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { raiseException } from "~/adapters/db/repositories/exception.server";
import { getCredential } from "~/adapters/db/repositories/metakocka-credential.server";
import { MetakockaClient } from "~/adapters/metakocka/client";
import { findSalesOrder } from "~/adapters/metakocka/documents";
import { MetakockaError } from "~/adapters/metakocka/errors";
import { getLogger } from "~/adapters/observability/logger.server";
import { serviceToken } from "~/domain/types";

/**
 * Reads back what MetaKocka holds for the documents this app wrote.
 *
 * This is the other direction of staleness. The order reconciler watches
 * Shopify get ahead of us; this watches the ERP do it — and **MetaKocka will
 * not tell us.** §3 is explicit that the only event it pushes is a stock
 * update: no order webhook, no document webhook. Everything else is polling by
 * design, not by preference.
 *
 * **[verified against company 6789 on 2026-08-25]** and the probe changed what
 * this job is. `get_document` with `doc_id` set to the `mk_id` from
 * `put_document` returns the whole document — `count_code`, `partner`,
 * `product_list`, `sum_all`, `warehouse`, `profit_center` — and notably **no
 * status field of any kind, and no tracking field**. A sales order in MetaKocka
 * has no workflow state to follow, so there was nothing to poll for it.
 *
 * What the same probe did find is worth much more. Two of the four documents
 * this app had recorded as written answered *"Cannot find document type
 * sales_order with id = …"*: they had been deleted in the MetaKocka UI, and
 * this app had gone on reporting those orders as sent, indefinitely, with no
 * way to ever learn otherwise. So the questions this job asks are the two that
 * turn out to have answers:
 *
 *  - **Is it still there?** A deleted document means the order is not in the
 *    ERP at all and nobody knows.
 *  - **Does it still say what we sent?** A total or a line count that has moved
 *    means somebody edited it, and our audit trail no longer describes the
 *    accounting record it claims to.
 *
 * Neither is fixed automatically. §8.8's rule holds in both directions: a
 * document may already be invoiced, so what happens next is a person's
 * decision, and this job's job is to make sure they are the one making it.
 */

export const pollMetakockaDocumentsJobSchema = z.object({
  shopDomain: z.string().min(1),
  /** Bounded per run: MetaKocka is slow and this is not urgent work. */
  limit: z.number().int().positive().max(500).default(100),
});

/**
 * How long a document goes unread before it is worth asking again.
 *
 * Every question is a call to an ERP that takes seconds to answer, and the
 * things this catches — a document deleted, a document edited — are rare and
 * not urgent. Hourly is attentive without being noise in the merchant's own
 * API log.
 */
const RECHECK_AFTER_MS = 60 * 60 * 1000;

/**
 * How long a document stays interesting.
 *
 * Past this it has been delivered and invoiced and is unlikely to move again,
 * so continuing to ask would be a standing cost with no answer in it.
 */
const FOLLOW_FOR_DAYS = 30;

/**
 * The lines this app sent, read back out of the recorded request body.
 *
 * Null when there is nothing usable to compare against — a body from before
 * this was recorded, or one the §2.4 retention job has been through. Null means
 * "cannot tell", and the poller then says nothing rather than reporting a
 * document as edited because it could not read its own record of it.
 */
function sentQuantities(body: unknown): Map<string, number> | null {
  if (!body || typeof body !== "object") return null;

  const list = (body as { product_list?: unknown }).product_list;
  if (!Array.isArray(list) || list.length === 0) return null;

  const lines = new Map<string, number>();
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const { code, amount } = row as { code?: unknown; amount?: unknown };
    if (typeof code !== "string") continue;

    const quantity = Number(String(amount ?? "0").replace(",", "."));
    if (!Number.isFinite(quantity)) continue;
    lines.set(code, (lines.get(code) ?? 0) + quantity);
  }

  return lines.size > 0 ? lines : null;
}

/**
 * What has changed, in the merchant's words, or null when nothing has.
 *
 * Names the difference rather than reporting one: "the document changed" sends
 * somebody to compare two screens by eye, and §2.8 asks an error to say what is
 * wrong as well as that something is.
 */
function describeLineDrift(
  sent: Map<string, number>,
  held: Map<string, number>,
): string | null {
  const differences: string[] = [];

  for (const [code, quantity] of sent) {
    const now = held.get(code);
    if (now === undefined) differences.push(`${code} is no longer on it`);
    else if (now !== quantity) {
      differences.push(`${code} is ${now} where ${quantity} was sent`);
    }
  }

  for (const [code, quantity] of held) {
    if (!sent.has(code)) differences.push(`${code} (${quantity}) was added`);
  }

  return differences.length > 0 ? differences.join(", ") : null;
}

export async function handlePollMetakockaDocuments(
  job: Job<unknown>,
): Promise<void> {
  const { shopDomain, limit } = pollMetakockaDocumentsJobSchema.parse(
    job.data ?? {},
  );
  const principal = serviceToken(shopDomain, "poll-metakocka-documents");
  const log = getLogger();

  const credential = await getCredential(principal);
  if (!credential) return;

  const now = new Date();
  const staleBefore = new Date(now.getTime() - RECHECK_AFTER_MS);
  const oldest = new Date(now.getTime() - FOLLOW_FOR_DAYS * 24 * 60 * 60 * 1000);

  const documents = await prisma.metakockaDocument.findMany({
    where: {
      shop: { domain: shopDomain },
      status: "written",
      mkId: { not: null },
      createdAt: { gte: oldest },
      OR: [{ mkCheckedAt: null }, { mkCheckedAt: { lt: staleBefore } }],
    },
    select: {
      id: true,
      mkId: true,
      countCode: true,
      orderId: true,
      supplySourceId: true,
      mkStatus: true,
      requestBody: true,
      order: { select: { shopifyOrderNumber: true, totalMinor: true } },
    },
    // Never looked at first, then longest unlooked-at.
    orderBy: [
      { mkCheckedAt: { sort: "asc", nulls: "first" } },
      { createdAt: "asc" },
    ],
    take: limit,
  });

  if (documents.length === 0) return;

  const client = new MetakockaClient({
    companyId: credential.companyId,
    secretKey: credential.secretKey,
  });

  let read = 0;
  let missing = 0;
  let changed = 0;

  for (const document of documents) {
    if (!document.mkId) continue;

    try {
      const snapshot = await findSalesOrder(client, document.mkId);
      read += 1;

      /* ------------------------------------------------------------------ */
      /* Gone                                                               */
      /* ------------------------------------------------------------------ */

      if (!snapshot) {
        missing += 1;

        /*
         * Recorded as failed, not as written.
         *
         * "Written" is a claim about MetaKocka, and it has stopped being true.
         * Saying so is also what makes "Send to MetaKocka again" work: the
         * `count_code` claim only lets a row be taken again once it is failed
         * (§8.4), so a document deleted in the ERP would otherwise be
         * permanently unrewritable.
         *
         * Nothing is re-sent automatically. Deleting it may well have been
         * deliberate, and §8.8's rule cuts both ways.
         */
        await prisma.metakockaDocument.update({
          where: { id: document.id },
          data: { mkCheckedAt: now, mkStatus: "missing", status: "failed" },
        });

        await raiseException(principal, {
          orderId: document.orderId,
          kind: "metakocka_document_missing",
          message: `The MetaKocka document ${document.countCode} for order ${document.order.shopifyOrderNumber} no longer exists — it has been deleted in MetaKocka. This app still had it recorded as sent, so nothing else would ever have noticed. If that was deliberate, resolve this. If not, use "Send to MetaKocka again" on the order to write it once more.`,
          detail: { countCode: document.countCode, mkId: document.mkId },
        });

        await appendEvent(principal, {
          entityType: "order",
          entityId: document.orderId,
          event: "order.metakocka_document_missing",
          detail: { countCode: document.countCode, mkId: document.mkId },
        });

        continue;
      }

      /* ------------------------------------------------------------------ */
      /* Still there, but does it still say what we sent?                   */
      /* ------------------------------------------------------------------ */

      /*
       * Compared against the recorded request body, not against the order.
       *
       * The request body is the exact document MetaKocka accepted (§8.4 records
       * it either way), so the comparison answers precisely one question:
       * has somebody edited it there since? Comparing against the order instead
       * would confuse that with the *other* kind of drift — Shopify moving on —
       * which `order_diverged` already covers and which has a different remedy.
       *
       * Codes and quantities rather than money, because what this app sends is
       * gross or net depending on the shop's tax setting (§8.6) while
       * MetaKocka's `sum_all` is always gross: on a tax-exclusive shop a total
       * comparison would report every document as edited, every time.
       */
      const sent = sentQuantities(document.requestBody);

      const drifted =
        sent !== null &&
        snapshot.lines.size > 0 &&
        describeLineDrift(sent, snapshot.lines);

      await prisma.metakockaDocument.update({
        where: { id: document.id },
        data: {
          mkCheckedAt: now,
          mkStatus: drifted ? "edited in MetaKocka" : "in step",
          ...(snapshot.docNumber !== null
            ? { mkDocNumber: snapshot.docNumber }
            : {}),
        },
      });

      if (drifted) {
        changed += 1;

        await raiseException(principal, {
          orderId: document.orderId,
          kind: "metakocka_document_changed",
          message: `The MetaKocka document ${document.countCode} for order ${document.order.shopifyOrderNumber} no longer matches what this app sent: ${drifted}. Nothing was changed automatically, because the document may already be invoiced. Either correct it in MetaKocka, or delete it there and use "Send to MetaKocka again" on the order to write it afresh.`,
          detail: {
            countCode: document.countCode,
            sent: Object.fromEntries(sent),
            inMetakocka: Object.fromEntries(snapshot.lines),
          },
        });

        await appendEvent(principal, {
          entityType: "order",
          entityId: document.orderId,
          event: "order.metakocka_document_changed",
          detail: { countCode: document.countCode, drift: drifted },
        });
      }
    } catch (error) {
      /*
       * One document failing must not stop the sweep, and a failure to *read*
       * is not worth an exception: the order is in MetaKocka and correct, and
       * all that has happened is that this app could not ask. The timestamp is
       * still written so the sweep moves on rather than retrying the same
       * document every run.
       */
      await prisma.metakockaDocument.updateMany({
        where: { id: document.id },
        data: { mkCheckedAt: now },
      });

      log.warn(
        {
          shop: shopDomain,
          countCode: document.countCode,
          err: error instanceof MetakockaError ? error.oprDesc : String(error),
        },
        "Could not read a MetaKocka document back",
      );
    }
  }

  await prisma.shop.updateMany({
    where: { domain: shopDomain },
    data: { documentsPolledThrough: now },
  });

  log.info(
    { shop: shopDomain, read, missing, changed },
    "MetaKocka documents polled",
  );
}
