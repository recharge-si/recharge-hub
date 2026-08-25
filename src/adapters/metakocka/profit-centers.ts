import type { MetakockaClient } from "~/adapters/metakocka/client";
import { parsePaymentTypes } from "~/adapters/metakocka/payment-types";
import {
  probeDocument,
  SENTINEL_PROFIT_CENTER,
} from "~/adapters/metakocka/probe";

/**
 * Checking a profit centre against the merchant's MetaKocka company.
 *
 * There is no list to fetch. CLAUDE.md §3 says MetaKocka cannot list profit
 * centres, and the trick that works for payment types does not work here: the
 * rejection names the value it refused rather than enumerating the valid set
 * (`"Profit center 'ThisProfitCenterDoesNotExist' doesn't exist."`,
 * docs/metakocka-verification.md item 2). So the register is what the merchant
 * types, and this module is what stops a typo reaching an order — MetaKocka
 * refuses a whole document over a profit centre it does not recognise (§3).
 *
 * ## Why there is a control probe
 *
 * A single probe cannot answer this on its own. Asking about a value means
 * sending it on a document that is guaranteed to fail for another reason, and
 * reading which reason came back:
 *
 *   - the error names the profit centre  -> the profit centre is wrong
 *   - the error lists payment types      -> validation got *past* the profit
 *                                           centre, so it is right
 *
 * That second inference only holds if MetaKocka checks the profit centre before
 * the payment type. Nothing documents the order, and getting it backwards would
 * mean calling every value valid, including the typos — the exact failure this
 * exists to prevent. So the ordering is established rather than assumed: one
 * control probe sends a profit centre that cannot exist. If MetaKocka answers
 * by naming it, the profit centre is checked first and the inference is sound.
 * If it answers about payment types instead, the question is unanswerable and
 * every verdict is `unknown`.
 *
 * `unknown` is a real answer and callers must carry it. It is not a failure and
 * it is never rendered as one: the value is kept, marked unchecked, and the
 * merchant is told the check could not run rather than being blocked.
 *
 * Nothing here writes to MetaKocka. See `probe.ts`.
 */

export type ProfitCenterVerdict =
  /** MetaKocka accepted it. */
  | "valid"
  /** MetaKocka does not have a profit centre by this name. */
  | "invalid"
  /** The check could not be run or could not be read. Not a rejection. */
  | "unknown";

/**
 * Whether a rejection is about the profit centre.
 *
 * Matched on the description, not on `opr_code`: code 6 is a general rejection
 * and also answers a malformed `doc_date` (adapters/metakocka/errors.ts).
 * Both spellings, because the message is MetaKocka's and we do not control it.
 */
export function namesProfitCenter(description: string): boolean {
  return /profit\s*cent(?:er|re)/i.test(description);
}

/** Reads one probe's answer, given that the ordering has been established. */
export function readVerdict(description: string | null): ProfitCenterVerdict {
  if (description === null) return "unknown";
  if (namesProfitCenter(description)) return "invalid";
  // Got far enough to be judged on the payment type, so the profit centre
  // was accepted on the way past.
  if (parsePaymentTypes(description) !== null) return "valid";
  return "unknown";
}

/**
 * Checks each value against the live company. One control probe for the batch,
 * then one probe per value.
 *
 * Blank values are dropped rather than probed: "no profit centre" is a valid
 * choice that sends the field at all, and MetaKocka then applies the company
 * setting.
 */
export async function validateProfitCenters(
  client: MetakockaClient,
  values: string[],
): Promise<Map<string, ProfitCenterVerdict>> {
  const wanted = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
  const verdicts = new Map<string, ProfitCenterVerdict>();
  if (wanted.length === 0) return verdicts;

  const control = await probeDocument(client, {
    profit_center: SENTINEL_PROFIT_CENTER,
  });

  // MetaKocka did not object to a profit centre that cannot exist, so it is not
  // checking the field at this point and no answer about a real one would mean
  // anything. Say so instead of guessing.
  if (control === null || !namesProfitCenter(control)) {
    for (const value of wanted) verdicts.set(value, "unknown");
    return verdicts;
  }

  for (const value of wanted) {
    verdicts.set(
      value,
      readVerdict(await probeDocument(client, { profit_center: value })),
    );
  }

  return verdicts;
}

/** One value, for the settings screen adding a single entry. */
export async function validateProfitCenter(
  client: MetakockaClient,
  value: string,
): Promise<ProfitCenterVerdict> {
  const verdicts = await validateProfitCenters(client, [value]);
  return verdicts.get(value.trim()) ?? "unknown";
}
