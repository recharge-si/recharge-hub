/**
 * Runs the web server and the job worker together.
 *
 * They are two processes by design (CLAUDE.md §4), but in development both have
 * to be up or nothing works: every sync button queues a job, and with no worker
 * the jobs pile up in Postgres looking like a broken button.
 *
 * Both are launched through `npm exec`, which is how the Shopify template ran
 * the web server before this script existed and is the only invocation proven
 * to work under the CLI. Two other approaches were tried and failed:
 *
 *   - spawning `react-router` by name: the CLI runs this file with
 *     `node scripts/dev.mjs` rather than through npm, so node_modules/.bin is
 *     not on PATH and the spawn fails with ENOENT.
 *   - spawning the package's JS entry point with the current Node binary: works
 *     when run by hand, but under the CLI the dev server started silently and
 *     never bound its port, so the proxy reported ECONNREFUSED.
 *
 * If the web server ever goes quiet again, the startup lines below say exactly
 * what was launched, and a child that dies is reported rather than swallowed.
 *
 * No dependency for this on purpose: the Docker image runs the two processes as
 * separate containers and has no use for a process runner.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const targets = [
  {
    name: "web",
    args: ["exec", "--", "react-router", "dev"],
    // The CLI proxies to this one. Without it there is no app at all.
    required: true,
  },
  {
    name: "worker",
    args: ["exec", "--", "tsx", "watch", "src/jobs/worker.ts"],
    required: false,
  },
];

const children = [];
let shuttingDown = false;

function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[dev] stopping: ${reason}`);

  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }

  setTimeout(() => process.exit(code), 2000).unref();
}

for (const target of targets) {
  console.log(`[dev] starting ${target.name}: npm ${target.args.join(" ")}`);

  const child = spawn("npm", target.args, {
    stdio: "inherit",
    cwd: projectRoot,
    env: process.env,
    // npm is a .cmd shim on Windows, which cannot be spawned without a shell.
    shell: process.platform === "win32",
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

  children.push(child);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(signal));
}
