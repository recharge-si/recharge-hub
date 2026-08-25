# Decisions made without asking

## D-01 — Snapshot the developer's uncommitted work as the first commit
The working tree carried ~9,000 lines of uncommitted products-phase-3 work
(order state sync, self-healing, document drift polling, sales-order settings).
Options: (a) stash it, (b) branch and leave it uncommitted, (c) commit it as-is
as a clearly labelled snapshot. Chose (c): a stash risks loss and the code does
not build without these files; leaving it uncommitted would mix it into every
agent commit. Reversal: `git reset --soft 00fa983` restores the pre-run state
with the work back in the tree.

## D-02 — Coverage not measured
`@vitest/coverage-v8` is absent and rule 7 forbids new dependencies. Decided to
report test-file distribution instead of installing it. Reversal: `npm i -D
@vitest/coverage-v8` and re-run.
