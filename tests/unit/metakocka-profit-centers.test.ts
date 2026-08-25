import { describe, expect, it } from "vitest";

import type { MetakockaClient } from "~/adapters/metakocka/client";
import { MetakockaError } from "~/adapters/metakocka/errors";
import {
  namesProfitCenter,
  readVerdict,
  validateProfitCenters,
} from "~/adapters/metakocka/profit-centers";
import { SENTINEL_PROFIT_CENTER } from "~/adapters/metakocka/probe";

/**
 * MetaKocka can neither list profit centres nor validate one, so a value is
 * checked by sending a document designed to fail and reading which field it
 * failed on (CLAUDE.md §3, docs/metakocka-verification.md item 2).
 *
 * The inference only holds if the profit centre is checked before the payment
 * type, so a control probe establishes that first. These tests pin both the
 * reading and the control, because getting the control wrong would call every
 * value valid -- including the typos this exists to catch.
 */

/** The real rejection, recorded against company 6789. */
const missing = (value: string) => `Profit center '${value}' doesn't exist.`;

/** The real payment type rejection, which means validation got past the centre. */
const PAYMENT_TYPES =
  "Paramether 'payment_type' has invalid value : X. " +
  "Valid values : Transakcijski račun,Gotovina,Kartica BA";

/**
 * A client that answers each probe from a lookup on the profit centre it
 * carried. Nothing here reaches the network.
 */
function clientAnswering(
  answers: Record<string, string>,
): MetakockaClient {
  const call = (
    _endpoint: string,
    body: Record<string, unknown>,
  ): Promise<never> => {
    const sent = String(body.profit_center ?? "");
    return Promise.reject(
      new MetakockaError("rejected", {
        endpoint: "put_document",
        kind: "exception",
        oprCode: "6",
        oprDesc: answers[sent] ?? PAYMENT_TYPES,
      }),
    );
  };

  return { call } as unknown as MetakockaClient;
}

describe("namesProfitCenter", () => {
  it("recognises MetaKocka's rejection", () => {
    expect(namesProfitCenter(missing("Partner1"))).toBe(true);
  });

  it("accepts the British spelling, which we do not control", () => {
    expect(namesProfitCenter("Profit centre 'X' doesn't exist.")).toBe(true);
  });

  it("does not read an unrelated rejection as one", () => {
    expect(namesProfitCenter("Not valid date for doc_date")).toBe(false);
    expect(namesProfitCenter(PAYMENT_TYPES)).toBe(false);
  });
});

describe("readVerdict", () => {
  it("calls a named profit centre invalid", () => {
    expect(readVerdict(missing("Nope"))).toBe("invalid");
  });

  it("calls it valid once validation reaches the payment type", () => {
    expect(readVerdict(PAYMENT_TYPES)).toBe("valid");
  });

  it("refuses to decide on anything else", () => {
    expect(readVerdict("Not valid date for doc_date")).toBe("unknown");
    expect(readVerdict(null)).toBe("unknown");
  });
});

describe("validateProfitCenters", () => {
  it("confirms a centre MetaKocka accepts", async () => {
    const client = clientAnswering({
      [SENTINEL_PROFIT_CENTER]: missing(SENTINEL_PROFIT_CENTER),
    });

    const verdicts = await validateProfitCenters(client, ["RCH-Web-stock"]);

    expect(verdicts.get("RCH-Web-stock")).toBe("valid");
  });

  it("rejects a centre MetaKocka does not have", async () => {
    const client = clientAnswering({
      [SENTINEL_PROFIT_CENTER]: missing(SENTINEL_PROFIT_CENTER),
      Typo: missing("Typo"),
    });

    const verdicts = await validateProfitCenters(client, ["Typo"]);

    expect(verdicts.get("Typo")).toBe("invalid");
  });

  it("answers unknown when the control shows the ordering is against us", async () => {
    // MetaKocka did not object to a centre that cannot exist, so it is not
    // checking the field at this point. Calling the real value valid here would
    // wave every typo through.
    const client = clientAnswering({
      [SENTINEL_PROFIT_CENTER]: PAYMENT_TYPES,
    });

    const verdicts = await validateProfitCenters(client, ["Anything"]);

    expect(verdicts.get("Anything")).toBe("unknown");
  });

  it("trims, dedupes and drops blanks before probing", async () => {
    const seen: string[] = [];
    const call = (
      _endpoint: string,
      body: Record<string, unknown>,
    ): Promise<never> => {
      const sent = String(body.profit_center ?? "");
      seen.push(sent);
      return Promise.reject(
        new MetakockaError("rejected", {
          endpoint: "put_document",
          kind: "exception",
          oprCode: "6",
          oprDesc:
            sent === SENTINEL_PROFIT_CENTER
              ? missing(SENTINEL_PROFIT_CENTER)
              : PAYMENT_TYPES,
        }),
      );
    };
    const client = { call } as unknown as MetakockaClient;

    const verdicts = await validateProfitCenters(client, [
      " Partner1 ",
      "Partner1",
      "",
      "   ",
    ]);

    expect([...verdicts.keys()]).toEqual(["Partner1"]);
    expect(seen).toEqual([SENTINEL_PROFIT_CENTER, "Partner1"]);
  });

  it("probes nothing at all for an empty register", async () => {
    const seen: string[] = [];
    const call = (): Promise<never> => {
      seen.push("called");
      return Promise.reject(new Error("should not be reached"));
    };
    const client = { call } as unknown as MetakockaClient;

    const verdicts = await validateProfitCenters(client, ["", "  "]);

    expect(verdicts.size).toBe(0);
    expect(seen).toEqual([]);
  });
});
