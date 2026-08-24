import { prisma } from "~/adapters/db/client.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { getQueueClient } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";

/**
 * Liveness and readiness for the container orchestrator and for Caddy.
 *
 * It checks the two dependencies the web process cannot serve without: Postgres
 * and the job queue. It deliberately does not touch MetaKocka -- an ERP outage
 * must not take this container out of rotation, and CLAUDE.md section 2.5 forbids
 * any request path that waits on MetaKocka.
 */
type CheckResult = "ok" | "failed";

async function checkDatabase(): Promise<CheckResult> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return "ok";
  } catch (error) {
    getLogger().error({ err: error }, "Health check: database unreachable");
    return "failed";
  }
}

async function checkQueue(): Promise<CheckResult> {
  try {
    const boss = await getQueueClient();
    const queue = await boss.getQueue(QUEUES.appUninstalled);
    return queue ? "ok" : "failed";
  } catch (error) {
    getLogger().error({ err: error }, "Health check: queue unreachable");
    return "failed";
  }
}

export const loader = async () => {
  const [database, queue] = await Promise.all([checkDatabase(), checkQueue()]);
  const healthy = database === "ok" && queue === "ok";

  // No version, no hostname, no configuration: this endpoint is unauthenticated.
  return Response.json(
    { status: healthy ? "ok" : "degraded", database, queue },
    {
      status: healthy ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
};
