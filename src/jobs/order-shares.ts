import { prisma } from "~/adapters/db/client.server";
import { splitOrderMoney, type DocumentShare } from "~/domain/money/split";
import { WHOLE_ORDER_DOCUMENT } from "~/domain/orders/reconcile";

/**
 * What each MetaKocka document of one Shopify order is worth (CLAUDE.md §8.6).
 *
 * Shared by the two jobs that need the answer — the one that creates the
 * documents and the one that records the payment against them — because they
 * must agree to the cent. They run minutes or days apart, so "both call
 * `splitOrderMoney` the same way" is not something to leave to two copies of
 * the same twenty lines.
 *
 * The arithmetic itself is pure and lives in `domain/money/split`; this is only
 * the gathering. Note that it reads allocations rather than the documents: the
 * share is a property of what a source was asked to fulfil, so it comes out the
 * same whether or not a document has been written yet.
 */
export async function computeDocumentShares(
  orderId: string,
  options: { wholeOrder?: boolean } = {},
): Promise<DocumentShare[]> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      totalMinor: true,
      shippingMinor: true,
      discountMinor: true,
      customerOrderRef: true,
      lines: {
        select: {
          quantity: true,
          unitPriceWithTaxMinor: true,
          allocations: { select: { supplySourceId: true, quantity: true } },
        },
      },
    },
  });
  if (!order) return [];

  /*
   * An unsplit shop has one document, so there is nothing to divide.
   *
   * It still goes through `splitOrderMoney` rather than being assembled by
   * hand: with one entry that function makes it primary, gives it the whole
   * shipping charge and the whole discount, and lands the rounding remainder on
   * it — which is the same arithmetic every other document gets, and the
   * property the payment path relies on (the shares sum to the order total)
   * holds by the same construction rather than by a second argument.
   *
   * The lines are the order's own, at full quantity, because that is what the
   * document carries: nothing is allocated when nothing is split, including
   * quantity Shopify is fulfilling through a service this app cannot see.
   */
  if (options.wholeOrder) {
    return splitOrderMoney({
      perSource: [
        {
          sourceId: WHOLE_ORDER_DOCUMENT,
          // The count code this document is actually written under, so a
          // message naming the share names something the merchant can find.
          sourceCode: order.customerOrderRef,
          kind: "own",
          lineTotalMinor: order.lines.reduce(
            (total, line) => total + line.quantity * line.unitPriceWithTaxMinor,
            0,
          ),
        },
      ],
      orderTotalMinor: order.totalMinor,
      shippingMinor: order.shippingMinor,
      discountMinor: order.discountMinor,
    });
  }

  const totalsBySource = new Map<string, number>();
  for (const line of order.lines) {
    for (const allocation of line.allocations) {
      if (!allocation.supplySourceId) continue;
      const current = totalsBySource.get(allocation.supplySourceId) ?? 0;
      totalsBySource.set(
        allocation.supplySourceId,
        current + allocation.quantity * line.unitPriceWithTaxMinor,
      );
    }
  }

  if (totalsBySource.size === 0) return [];

  const sources = await prisma.supplySource.findMany({
    where: { id: { in: [...totalsBySource.keys()] } },
    select: { id: true, code: true, kind: true },
  });

  return splitOrderMoney({
    perSource: sources.map((source) => ({
      sourceId: source.id,
      sourceCode: source.code,
      kind: source.kind,
      lineTotalMinor: totalsBySource.get(source.id) ?? 0,
    })),
    orderTotalMinor: order.totalMinor,
    shippingMinor: order.shippingMinor,
    discountMinor: order.discountMinor,
  });
}
