import { prisma } from "~/adapters/db/client.server";
import { splitOrderMoney, type DocumentShare } from "~/domain/money/split";

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
): Promise<DocumentShare[]> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      totalMinor: true,
      shippingMinor: true,
      discountMinor: true,
      lines: {
        select: {
          unitPriceWithTaxMinor: true,
          allocations: { select: { supplySourceId: true, quantity: true } },
        },
      },
    },
  });
  if (!order) return [];

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
