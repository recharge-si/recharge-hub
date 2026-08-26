import type { Config } from "@react-router/dev/config";

export default {
  // The layout in docs/BUILD_SPEC.md section 5 puts the web tier under src/web
  // rather than the template's top-level app/ directory.
  appDirectory: "src/web",
  ssr: true,
} satisfies Config;
