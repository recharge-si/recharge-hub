/**
 * Quality gate for the rig builder (docs/rig-builder.md § Quality gate).
 *
 *   npx tsx scripts/rig-eval.ts --csv rows.csv --snapshot snapshot.json
 *   npx tsx scripts/rig-eval.ts --csv rows.csv --shop store.myshopify.com [--export snapshot.json]
 *
 * Runs every row of the CSV through the engine and prints pass/fail per row
 * and per rule. Exit code 1 when any row fails, 2 for unusable input. No model
 * is involved, and the shop is only read: `--shop` reads the catalogue
 * snapshot from the database (set DATABASE_URL and ENCRYPTION_KEY, and the
 * Shopify variables the app needs), `--export` saves it so the same run can be
 * repeated offline with `--snapshot`.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { candidatesFrom, type RigSnapshotProduct } from "~/domain/rig/candidates";
import { evaluateCase, parseEvalCases } from "~/domain/rig/eval";
import { placeholderRules } from "~/domain/rig/rules";
import { parseAttributeSchema } from "~/domain/attributes/schema";
import type { AttributeSchema } from "~/domain/attributes/types";

interface SnapshotFile {
  shopId: string;
  plan: unknown;
  products: RigSnapshotProduct[];
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function loadSnapshot(): Promise<{
  shopId: string;
  plan: AttributeSchema;
  products: RigSnapshotProduct[];
}> {
  const file = argument("snapshot");
  const shop = argument("shop");
  let raw: SnapshotFile;
  if (file) {
    raw = JSON.parse(readFileSync(file, "utf8")) as SnapshotFile;
  } else if (shop) {
    const [{ loadRigSource }, { serviceToken }] = await Promise.all([
      import("~/adapters/db/repositories/rig.server"),
      import("~/domain/types"),
    ]);
    const source = await loadRigSource(serviceToken(shop, "rig-eval"));
    raw = { shopId: source.shopId, plan: source.plan, products: source.products };
    const out = argument("export");
    if (out) writeFileSync(out, JSON.stringify(raw));
  } else {
    throw new Error("Give --snapshot FILE or --shop DOMAIN.");
  }
  const plan = parseAttributeSchema(raw.plan);
  if (!plan.ok) throw new Error(`The snapshot plan is invalid: ${plan.message}`);
  return { shopId: raw.shopId, plan: plan.schema, products: raw.products };
}

async function main(): Promise<number> {
  const csv = argument("csv");
  if (!csv) {
    console.error("Give --csv FILE (see tests/fixtures/rig/eval-sample.csv).");
    return 2;
  }
  const { cases, errors } = parseEvalCases(readFileSync(csv, "utf8"));
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    return 2;
  }
  const snapshot = await loadSnapshot();
  const candidates = candidatesFrom(snapshot.plan, snapshot.products);
  const rules = placeholderRules();
  if (rules.placeholder) {
    console.warn(
      `WARNING: rules table ${rules.id} is a PLACEHOLDER. A pass here proves nothing about the real rules.`,
    );
  }

  let failed = 0;
  for (const evalCase of cases) {
    const outcome = evaluateCase(evalCase, candidates, rules, snapshot.shopId);
    if (!outcome.pass) failed += 1;
    console.log(`${outcome.pass ? "PASS" : "FAIL"}  line ${outcome.line}  ${evalCase.text.slice(0, 60)}`);
    for (const rule of outcome.rules) {
      console.log(`        ${rule.ok ? "ok  " : "FAIL"} ${rule.rule.padEnd(12)} ${rule.detail}`);
    }
  }
  console.log(`\n${cases.length - failed} of ${cases.length} rows pass.`);
  return failed > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  },
);
