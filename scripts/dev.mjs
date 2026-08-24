/**
 * Runs the web server and the job worker together.
 *
 * They are two processes by design (CLAUDE.md §4), but in development they have
 * to be running at the same time or nothing works: every sync button queues a
 * job, and with no worker the jobs simply pile up in Postgres looking like the
 * button is broken.
 *
 * No dependency for this on purpose. `concurrently` would be a production
 * dependency in the Docker image, which runs the two processes as separate
 * containers and does not need it.
 */
import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";

const processes = [
  { name: "web", command: "react-router", args: ["dev"] },
  { name: "worker", command: "tsx", args: ["watch", "src/jobs/worker.ts"] },
];

const children = [];
let shuttingDown = false;

function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }

  // Give them a moment to exit cleanly, then stop caring.
  setTimeout(() => process.exit(code), 2000).unref();
  console.log(`\n[dev] stopping: ${reason}`);
}

for (const { name, command, args } of processes) {
  const child = spawn(command, args, {
    stdio: "inherit",
    // npm puts the local .bin on PATH, and Windows needs the shell to resolve
    // the .cmd shims that sit there.
    shell: isWindows,
    env: process.env,
  });

  child.on("error", (error) => {
    console.error(`[dev] ${name} failed to start:`, error.message);
    shutdown(`${name} failed to start`, 1);
  });

  child.on("exit", (code) => {
    // One dying without the other leaves a half-running app that behaves in
    // confusing ways, so both go down together.
    if (!shuttingDown) shutdown(`${name} exited with code ${code}`, code ?? 0);
  });

  children.push(child);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(signal));
}
