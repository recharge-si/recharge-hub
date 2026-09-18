import { describe, expect, it } from "vitest";

import {
  decideOrderTransfer,
  describeTransferHold,
} from "~/domain/orders/transfer";

const earlier = new Date("2026-09-01T00:00:00Z");
const cutoff = new Date("2026-09-10T00:00:00Z");
const later = new Date("2026-09-15T00:00:00Z");

describe("decideOrderTransfer", () => {
  it("allows everything when the switch is on and there is no cut-off", () => {
    expect(
      decideOrderTransfer(
        { transferOrders: true, transferOrdersSince: null },
        { receivedAt: earlier, hasDocuments: false },
      ),
    ).toEqual({ allowed: true });
  });

  it("holds every order while the switch is off, even one MetaKocka holds", () => {
    const off = { transferOrders: false, transferOrdersSince: null };
    expect(
      decideOrderTransfer(off, { receivedAt: later, hasDocuments: false }),
    ).toEqual({ allowed: false, reason: "transfer_off" });
    expect(
      decideOrderTransfer(off, { receivedAt: earlier, hasDocuments: true }),
    ).toEqual({ allowed: false, reason: "transfer_off" });
  });

  it("holds an order received before the cut-off with nothing written", () => {
    expect(
      decideOrderTransfer(
        { transferOrders: true, transferOrdersSince: cutoff },
        { receivedAt: earlier, hasDocuments: false },
      ),
    ).toEqual({ allowed: false, reason: "received_while_off" });
  });

  it("lets an order MetaKocka already holds keep converging past the cut-off", () => {
    expect(
      decideOrderTransfer(
        { transferOrders: true, transferOrdersSince: cutoff },
        { receivedAt: earlier, hasDocuments: true },
      ),
    ).toEqual({ allowed: true });
  });

  it("allows an order received at or after the cut-off", () => {
    const on = { transferOrders: true, transferOrdersSince: cutoff };
    expect(
      decideOrderTransfer(on, { receivedAt: cutoff, hasDocuments: false }),
    ).toEqual({ allowed: true });
    expect(
      decideOrderTransfer(on, { receivedAt: later, hasDocuments: false }),
    ).toEqual({ allowed: true });
  });

  it("describes every hold in words a log line can carry", () => {
    expect(describeTransferHold("transfer_off")).toMatch(/turned off/);
    expect(describeTransferHold("received_while_off")).toMatch(/received while/);
  });
});
