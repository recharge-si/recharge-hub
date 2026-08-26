# Shared agent operating manual

This repository is shared memory for humans, Claude Code, OpenAI Codex, and
other coding agents. Important project state must live in code, tests, current
documentation, or Git—not only in a conversation.

## Sources of truth

- `docs/BUILD_SPEC.md` defines product requirements and the architecture target.
  Read relevant sections before changing code; read it fully before broad
  architectural work.
- `docs/architecture.md` maps the current implementation and where code belongs.
- `docs/integrations.md` owns current integration responsibilities and entry
  points. `docs/metakocka-verification.md` owns observed MetaKocka behavior.
- `docs/development.md` owns setup, environment, database, validation, and
  deployment instructions.
- `docs/project-status.md` owns known gaps, open decisions, and technical debt.
- `docs/ui-conventions.md` owns merchant-facing UI and terminology conventions.
- Code and tests define implemented behavior. Git records historical behavior.
- `docs/agent/HANDOFF.md`, when present, is the concise state of substantial
  unfinished work. It is not a permanent backlog.

Agent-specific files may point here but must not duplicate shared project
knowledge.

## Takeover checklist

Before modifying the repository:

1. Read this file.
2. Run `git status` and understand every uncommitted change. Never assume it is
   yours.
3. Read `docs/agent/HANDOFF.md` if it exists, then the relevant current docs and
   `docs/project-status.md`.
4. Inspect recent commits when they may affect the task.
5. Inspect the implementation and tests in scope. Repository state outranks
   conversation memory.

Reconstruct discoverable context instead of asking the user to restate it.

## Working-tree and Git safety

- Preserve unrelated or unexplained changes. Never silently reset, revert,
  overwrite, clean, or fold them into another task.
- If overlapping work cannot be separated safely, stop and explain the conflict.
- Stage explicit files; do not use broad staging when unrelated changes exist.
- Never commit secrets or local environment files.
- Use conventional commits as coherent, tested synchronization checkpoints.
  Do not amend or rewrite another person's commits without explicit permission.

## Project constraints

- Never call a live MetaKocka company during development or tests. Use recorded
  fixtures and `docs/metakocka-verification.md`. A live probe requires explicit
  human approval and the designated test company.
- Do not invent MetaKocka or Shopify fields. Validate every external boundary
  and follow `docs/BUILD_SPEC.md`.
- Keep migrations additive. Never edit or delete an applied migration.
- Preserve strict type and architecture rules: no `any`, no unchecked assertion
  across an external boundary, and no forbidden imports.
- `domain/` stays pure and deterministic. Long-running work stays in jobs; no
  page load may await MetaKocka.
- Preserve tenant scoping, idempotency, inventory ownership, PII retention, and
  secret redaction. These are safety boundaries, not style preferences.

## Keep the repository synchronized

- Put behavior in code and expected behavior in tests.
- Update the owning current document when changing architecture, schemas, APIs,
  integrations, synchronization, webhooks, business rules, auth, retries,
  idempotency, configuration, environment, deployment, commands, testing, or an
  important dependency.
- Record durable operating rules here; do not turn this file into a session log.
- Current docs describe current reality. Use Git for completed plans and old
  reports.
- For substantial unfinished work, create or update
  `docs/agent/HANDOFF.md` with the task, completed and remaining work, decisions,
  relevant files, and last validation. Remove it when the task is complete.

## Validation and completion

The standard code-change validation is:

```bash
npm run typecheck
npm run lint
npx vitest run
npm run build
```

Also run `npx prisma validate`, migration/schema checks, or Compose/Docker checks
when those areas change. Before calling work complete:

1. Inspect `git status` and the complete relevant diff.
2. Run proportionate validation and report any blocker honestly.
3. Update current docs and remove stale handoff information.
4. Check that temporary debug code, generated clutter, and secrets were not
   introduced.
5. Create the final logical commit so another agent can take over immediately.
