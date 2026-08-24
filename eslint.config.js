import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";

export default tseslint.config(
  {
    ignores: [
      "build/**",
      "node_modules/**",
      ".react-router/**",
      "public/**",
      "extensions/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.ts"],
    plugins: { import: importPlugin },
    settings: {
      "import/resolver": {
        typescript: { project: "./tsconfig.json" },
      },
    },
    rules: {
      // CLAUDE.md section 15: no `any`, no `as` across a boundary.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // CLAUDE.md section 5: enforced import direction.
      // domain/ imports nothing from the other tiers.
      // adapters/ may import domain/.
      // jobs/ may import domain/ and adapters/.
      // web/ may import domain/ and adapters/, never jobs/.
      "import/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "./src/domain",
              from: "./src/adapters",
              message:
                "domain/ is pure logic. It must not import from adapters/.",
            },
            {
              target: "./src/domain",
              from: "./src/jobs",
              message: "domain/ is pure logic. It must not import from jobs/.",
            },
            {
              target: "./src/domain",
              from: "./src/web",
              message: "domain/ is pure logic. It must not import from web/.",
            },
            {
              target: "./src/adapters",
              from: "./src/jobs",
              message: "adapters/ must not import from jobs/.",
            },
            {
              target: "./src/adapters",
              from: "./src/web",
              message: "adapters/ must not import from web/.",
            },
            {
              target: "./src/web",
              from: "./src/jobs",
              message:
                "web/ must not import from jobs/. Enqueue through adapters/db instead.",
            },
            {
              target: "./src/jobs",
              from: "./src/web",
              message: "jobs/ must not import from web/.",
            },
          ],
        },
      ],
    },
  },
  {
    // CLAUDE.md section 15: no Date.now() in domain code; inject the clock.
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "Date",
          message:
            "domain/ must not read the clock. Take `now: Date` as an argument.",
        },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "Date",
          property: "now",
          message:
            "domain/ must not read the clock. Take `now: Date` as an argument.",
        },
        {
          object: "Math",
          property: "random",
          message: "domain/ must be deterministic.",
        },
      ],
    },
  },
  {
    files: ["src/web/**/*.tsx"],
    rules: {
      // Polaris and App Bridge web components are not known to TypeScript's JSX
      // intrinsics beyond @shopify/polaris-types; unknown props are expected.
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
);
