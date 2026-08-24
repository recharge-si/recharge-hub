/**
 * Runs the web server and the job worker together.
 *
 * They are two processes by design (CLAUDE.md §4), but in development both have
 * to be up or nothing works: every sync button queues a job, and with no worker
 * the jobs pile up in Postgres looking like a broken button.
 *
 * Two things this has to get right, both learned the hard way:
 *
 *  1. The Shopify CLI runs this with `node scripts/dev.mjs`, not through npm, so
 *     `node_modules/.bin` is **not** on PATH. Spawning `react-router` by name
 *     fails with ENOENT, the script tears everything down, and the CLI proxy
 *     reports ECONNREFUSED against a server that never started. Each tool is
 *     therefore launched by its JS entry point with the current Node binary,
 *     which also sidesteps Windows `.cmd` shims.
 *
 *  2. A dead worker must not take the web server with it. Losing background
 *     jobs is a degraded app; losing the server is an app the merchant cannot
 *     open at all.
 *
 * No dependency for this on purpose: the Docker image runs the two processes as
 * separate containers and has no use for a process runner.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Resolves a package's bin script to an absolute path we can run with node. */
function resolveBin(packageName, binName) {
  const manifestPath = require.resolve(`${packageName}/package.json`, {
    paths: [projectRoot],
  });
  const manifest = require(manifestPath);
  const bin =
    typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binName];

  if (!bin) {
    throw new Error(`${packageName} does not declare a "${binName}" bin`);
  }

  const resolved = path.resolve(path.dirname(manifestPath), bin);
  if (!existsSync(resolved)) {
    throw new Error(`${packageName} bin not found at ${resolved}`);
  }
  return resolved;
}

let targets;
try {
  targets = [
    {
      name: "web",
      script: resolveBin("@react-router/dev", "react-router"),
      args: ["dev"],
      required: true,
    },
    {
      name: "worker",
      script: resolveBin("tsx", "tsx"),
      args: ["watch", "src/jobs/worker.ts"],
      required: false,
    },
  ];
} catch (error) {
  console.error(`[dev] ${error.message}`);
  console.error("[dev] run `npm install` and try again");
  process.exit(1);
}

const children = new Map();
let shuttingDown = false;

function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[dev] stopping: ${reason}`);

  for (const child of children.values()) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }

  setTimeout(() => process.exit(code), 2000).unref();
}

for (const target of targets) {
  const child = spawn(process.execPath, [target.script, ...target.args], {
    stdio: "inherit",
    cwd: projectRoot,
    env: process.env,
  });

  child.on("error", (error) => {
    console.error(`[dev] ${target.name} failed to start: ${error.message}`);
    if (target.required) shutdown(`${target.name} failed to start`, 1);
  });

  child.on("exit", (code) => {
    if (shuttingDown) return;

    if (target.required) {
      shutdown(`${target.name} exited with code ${code}`, code ?? 0);
      return;
    }

    // The worker is gone but the admin still loads. Say so loudly rather than
    // letting sync buttons queue work that nothing will ever pick up.
    console.error(
      `\n[dev] the ${target.name} exited with code ${code}. The app still ` +
        `runs, but background jobs will not. Restart dev to bring it back.\n`,
    );
  });

  children.set(target.name, child);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(signal));
}
