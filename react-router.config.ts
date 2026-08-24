import type { Config } from "@react-router/dev/config";

export default {
  // The repository layout in CLAUDE.md section 5 puts the web tier under src/web
  // rather than the template's top-level app/ directory.
  appDirectory: "src/web",
  ssr: true,
} satisfies Config;
