# Overnight hardening run — report

Branch: `agent/overnight-hardening`. Base: `3ae84d7` (snapshot of the developer's
in-progress products-phase-3 work, committed as-is so agent changes are separable).
Run date: 2026-08-25/26. Written as the run progresses; sections may be appended
out of order.

## 0. Baseline (ground truth, measured)

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` (react-router typegen && tsc --noEmit) | 0 errors |
| Lint | `npm run lint` (eslint .) | 0 errors |
| Tests | `npx vitest run` | 29 files, 424 tests, 424 passed, 1.6 s |
| Prisma schema | `npx prisma validate` | valid |
| Compose | `docker compose config` | valid (docker server 28.3.3 present) |
| Import-direction rule | temporary `domain -> adapters` import | eslint fails with `import/no-restricted-paths` — rule works |
| Clock rule | temporary `Date.now()` in `src/domain/types.ts` | eslint fails with `no-restricted-globals` + `no-restricted-properties` — rule works |

- Coverage: **not measurable** — `@vitest/coverage-v8` is not installed and rule 7
  (no new dependencies) forbids adding it. Recorded in TODO-HUMAN.md. Per-directory
  test-file counts are used instead.
- Source size: ~25,500 lines across `src/`.
- Test distribution: all 29 test files are `tests/unit/`; fixtures exist for
  `metakocka/warehouse_list` and the three Shopify compliance payloads only.

## Findings

(appended as passes complete)
