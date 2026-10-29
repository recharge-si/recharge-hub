import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A fake `claude-pool` (and `claude`) executable for tests, so nothing
 * here ever reaches the real pool or Anthropic. It is a shell script:
 *
 * Configured through `set()` (files beside the executable, because the runner
 * scrubs the environment): `status` is printed for `--pool-status`; `args` and
 * `env` name files that receive its arguments and a leak report; `sleep`
 * delays; `script` names a file of `exit:base64-stdout` lines (see
 * `scripted`), one per call. `--help` prints a text with `--tools`.
 */
export function installFakeClaude(): {
  dir: string;
  pathWith(): string;
  /** Sets (or with null clears) one config file the script reads. */
  set(
    name: "status" | "script" | "sleep" | "args" | "env",
    value: string | null,
  ): void;
  reset(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const script = `#!/bin/sh
d=$(dirname "$0")
case "$1" in
  --pool-status) cat "$d/cfg_status" 2>/dev/null; exit 0;;
  --help) printf '  --tools <tools...>  Specify the list of available tools\\n'; exit 0;;
esac
if [ -f "$d/cfg_args" ]; then for a in "$@"; do printf '%s\\n' "$a" >> "$(cat "$d/cfg_args")"; done; fi
if [ -f "$d/cfg_env" ]; then printf 'key=%s db=%s pool=%s\\n' "$ANTHROPIC_API_KEY" "$HUB_DATABASE_URL" "$CLAUDE_POOL_ACCOUNT" > "$(cat "$d/cfg_env")"; fi
if [ -f "$d/cfg_sleep" ]; then sleep "$(cat "$d/cfg_sleep")"; fi
if [ -f "$d/cfg_script" ]; then
  f=$(cat "$d/cfg_script")
  n=$(cat "$f.n" 2>/dev/null || echo 0)
  n=$((n+1)); echo $n > "$f.n"
  line=$(sed -n "\${n}p" "$f")
  [ -z "$line" ] && line=$(tail -n 1 "$f")
  code=\${line%%:*}; body=\${line#*:}
  [ -n "$body" ] && printf '%s' "$body" | base64 -d
  exit "$code"
fi
exit 0
`;
  for (const name of ["claude-pool", "claude"]) {
    const file = join(dir, name);
    writeFileSync(file, script);
    chmodSync(file, 0o755);
  }
  const names = ["status", "script", "sleep", "args", "env"] as const;
  return {
    dir,
    pathWith: () => `${dir}:${process.env["PATH"] ?? ""}`,
    set(name, value) {
      const file = join(dir, `cfg_${name}`);
      if (value === null) rmSync(file, { force: true });
      else writeFileSync(file, value);
    },
    reset() {
      for (const name of names)
        rmSync(join(dir, `cfg_${name}`), { force: true });
    },
  };
}

/** A `--output-format json` envelope carrying `text`, as one scripted line. */
export function envelope(text: string, model = "claude-sonnet-fake"): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    modelUsage: { [model]: { inputTokens: 1, outputTokens: 1 } },
  });
}

/** One line of a `FAKE_SCRIPT` file. */
export function scripted(code: number, stdout = ""): string {
  return `${code}:${Buffer.from(stdout).toString("base64")}`;
}
