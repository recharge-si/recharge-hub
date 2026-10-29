import { parseArgs } from "node:util";

import { claudeSupportsToolsFlag } from "~/adapters/ai/claude-pool.server";
import { prisma } from "~/adapters/db/client.server";
import { runFill } from "~/adapters/products/fill-runner.server";
import { RIG_TYPES, type RigTypeId } from "~/domain/attributes/rig-pack";

/**
 * Operator run: fill the empty attributes of the catalogue through
 * claude-pool and leave the answers in the AI review queue
 * (docs/attributes.md, Bulk filling with claude-pool).
 *
 *   npx tsx --env-file=.env scripts/fill-attributes.ts --shop my-shop.myshopify.com
 *   npx tsx --env-file=.env scripts/fill-attributes.ts --shop ... --types sails,masts --concurrency 2
 *
 * Runs where claude-pool and the hub's database are reachable, never in the
 * production containers. Safe to stop (Ctrl-C) and run again: products
 * already answered are not asked twice. Nothing is written to Shopify.
 */

const USAGE = `Usage: fill-attributes --shop <domain> [--types sails,masts] [--limit N] [--concurrency N] [--model <alias>] [--timeout <seconds>]

  --shop         the shop's myshopify domain (required)
  --types        only these rig types: ${RIG_TYPES.map((t) => t.id).join(", ")}
  --limit        ask about at most N products this run
  --concurrency  calls in flight, 1 to 10 (default 2)
  --model        passed to claude as --model
  --timeout      seconds per call (default 120)`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function whole(
  name: string,
  text: string | undefined,
  min: number,
  max: number,
): number | undefined {
  if (text === undefined) return undefined;
  const value = Number(text);
  if (!Number.isInteger(value) || value < min || value > max)
    fail(`--${name} must be a whole number from ${min} to ${max}.`);
  return value;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      shop: { type: "string" },
      types: { type: "string" },
      limit: { type: "string" },
      concurrency: { type: "string" },
      model: { type: "string" },
      timeout: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const shop = values.shop?.trim();
  if (!shop)
    fail("--shop is required: the run never guesses which shop to fill.");
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop))
    fail(`"${shop}" is not a myshopify.com domain.`);

  let types: RigTypeId[] | null = null;
  if (values.types) {
    const known = new Set<string>(RIG_TYPES.map((t) => t.id));
    const asked = values.types
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const unknown = asked.filter((t) => !known.has(t));
    if (unknown.length > 0 || asked.length === 0)
      fail(`Unknown type: ${unknown.join(", ") || "(none given)"}.`);
    types = asked as RigTypeId[];
  }
  const limit = whole("limit", values.limit, 1, 1_000_000) ?? null;
  const concurrency = whole("concurrency", values.concurrency, 1, 10) ?? 2;
  const timeout = whole("timeout", values.timeout, 10, 1800) ?? 120;

  // A claude that no longer documents --tools would run with tools on.
  if (!(await claudeSupportsToolsFlag())) {
    console.error(
      "The installed claude does not list the --tools flag, which turns every tool off. Refusing to run.",
    );
    return 1;
  }

  let stopping = false;
  const stop = () => {
    if (!stopping) console.error("\nStopping after the products in flight...");
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const summary = await runFill({
    shopDomain: shop,
    types,
    limit,
    concurrency,
    ...(values.model ? { model: values.model } : {}),
    timeoutMs: timeout * 1000,
    log: (line) => console.log(line),
    shouldStop: () => stopping,
  });
  console.log(
    [
      `Asked ${summary.asked}: ${summary.suggested} with suggestions (${summary.values} values),`,
      `${summary.nothing} with nothing found, ${summary.failed} failed.`,
      `Passed over: ${summary.noType} without a product type, ${summary.nothingToFill} with nothing to fill.`,
      summary.pauses > 0
        ? `Waited for the pool ${summary.pauses} time(s).`
        : "",
      "Review the suggestions under Products > AI review.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return summary.failed > 0 ? 3 : 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
