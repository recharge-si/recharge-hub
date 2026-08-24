import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// The Shopify CLI passes HOST; Vite treats that variable as its own. Move it aside
// before Vite reads it. Carried over from the official template.
if (
  process.env.HOST &&
  (!process.env.SHOPIFY_APP_URL ||
    process.env.SHOPIFY_APP_URL === process.env.HOST)
) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
  delete process.env.HOST;
}

const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost").hostname;

const hmrConfig =
  host === "localhost"
    ? { protocol: "ws", host: "localhost", port: 64999, clientPort: 64999 }
    : {
        protocol: "wss",
        host,
        port: parseInt(process.env.FRONTEND_PORT ?? "", 10) || 8002,
        clientPort: 443,
      };

export default defineConfig({
  server: {
    allowedHosts: [host],
    cors: { preflightContinue: true },
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: { allow: ["src", "node_modules"] },
  },
  plugins: [reactRouter(), tsconfigPaths()],
  build: { assetsInlineLimit: 0 },
  optimizeDeps: { include: ["@shopify/app-bridge-react"] },
}) satisfies UserConfig;
