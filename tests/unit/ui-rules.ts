import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Shared scanner for tests/unit/ui-rules.test.ts: reads the merchant UI's
 * source and reports a rule violation as `file:line`, so the next one names
 * itself (tasks/prd-03-ui-coherence.md § 8).
 */
const ROOT = join(__dirname, "..", "..");
export const WEB = join(ROOT, "src", "web");

export interface Line {
  file: string; // repo-relative, forward slashes
  line: number; // 1-based
  text: string; // the source line, trimmed
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
}

/** Every source line under src/web outside comments. */
export function webLines(): Line[] {
  const files: string[] = [];
  walk(WEB, files);
  const lines: Line[] = [];
  for (const full of files.sort()) {
    const file = relative(ROOT, full).split("\\").join("/");
    let inBlock = false;
    readFileSync(full, "utf8")
      .split("\n")
      .forEach((raw, index) => {
        let text = raw.trim();
        if (inBlock) {
          const end = text.indexOf("*/");
          if (end === -1) return;
          inBlock = false;
          text = text.slice(end + 2).trim();
        }
        // Whole-line comments and the tail of a line comment.
        if (text.startsWith("//") || text.startsWith("*")) return;
        while (text.includes("/*")) {
          const start = text.indexOf("/*");
          const end = text.indexOf("*/", start + 2);
          if (end === -1) {
            inBlock = true;
            text = text.slice(0, start).trim();
            break;
          }
          text = (text.slice(0, start) + " " + text.slice(end + 2)).trim();
        }
        if (text === "") return;
        lines.push({ file, line: index + 1, text });
      });
  }
  return lines;
}

export interface Allowed {
  file: string;
  /** A fragment of the offending line; the entry stops matching if it is fixed. */
  includes: string;
  reason: string;
}

/**
 * Splits hits into the ones an allowlist entry excuses and the rest, and
 * lists the entries that excuse nothing (so a fixed violation must leave the
 * list).
 */
export function judge(
  hits: Line[],
  allow: readonly Allowed[],
): { violations: string[]; stale: string[] } {
  const used = new Set<Allowed>();
  const violations: string[] = [];
  for (const hit of hits) {
    const entries = allow.filter(
      (a) => a.file === hit.file && hit.text.includes(a.includes),
    );
    for (const entry of entries) used.add(entry);
    if (entries.length === 0)
      violations.push(`${hit.file}:${hit.line}  ${hit.text.slice(0, 140)}`);
  }
  const stale = allow
    .filter((a) => !used.has(a))
    .map((a) => `${a.file}  "${a.includes}"  (${a.reason})`);
  return { violations, stale };
}
