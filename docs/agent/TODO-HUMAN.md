# Needs a human

Ordered by risk. Each entry has the exact next action.

## T-01 — Install coverage tooling
`npm i -D @vitest/coverage-v8`, then `npx vitest run --coverage` and check
`src/domain/` is near-exhaustive. Blocked in this run by the no-new-dependencies
rule.
