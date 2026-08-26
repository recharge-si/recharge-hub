# Shared agent operating manual

This repository is the shared memory between every coding agent that works on
it. Claude Code and OpenAI Codex do not share conversation history, so project
knowledge, progress, and decisions must never exist only in a chat.

These rules apply to every task and every meaningful development step unless
the user explicitly overrides them.

## Sources of truth

- `AGENTS.md` contains durable, project-wide instructions for all agents.
- `docs/BUILD_SPEC.md` contains the current product and architecture
  specification. Read the relevant sections before changing code; read it fully
  before broad architectural work.
- `docs/` contains current integration, UI, architecture, and development
  knowledge.
- Code and tests define implemented behavior.
- Git commits record history and logical checkpoints.
- `docs/agent/HANDOFF.md`, when present, is the concise active handoff for
  unfinished work. Update it as the state changes and delete it when the task is
  complete.
- `docs/agent/NOT_DONE.md` and `docs/agent/TODO-HUMAN.md` are the outstanding
  backlog and human-decision queue. `docs/agent/DRIFT.md` records known
  specification drift. `docs/agent/REPORT.md` and `NIGHT_RUN.md` are historical
  reports, not active handoffs.

Agent-specific files may point to these shared sources, but must not be the only
place that important project knowledge is recorded.

## Takeover checklist for every task

Before modifying the repository:

1. Read this file.
2. Run `git status` and understand every uncommitted change. Do not assume it is
   yours.
3. Read `docs/agent/HANDOFF.md` if it exists, then relevant current docs,
   outstanding work, and known drift.
4. Inspect recent commits when they may affect the task.
5. Inspect the actual implementation and tests in scope. Repository state is
   authoritative; conversation memory may be stale.

Do not ask the user to restate work that can be reconstructed from the
repository.

## Working-tree safety

Uncommitted changes may belong to the user, another agent, or another tool.
Never silently discard, reset, overwrite, revert, clean, or fold them into an
unrelated commit. Understand overlapping changes and preserve them; if safe
separation is impossible, stop and explain the conflict.

Stage explicit files rather than using a broad add when unrelated changes are
present. Never introduce secrets or commit local environment files.

## Continuous synchronization while working

At every meaningful checkpoint, ask whether another competent agent could take
over immediately. If not, make the repository understandable before moving on.

- Put behavior in code and expected behavior in tests.
- Update current documentation when implementation changes architecture,
  schema/data models, APIs, integrations, sync or webhook behavior, business
  rules, auth, retries, idempotency, configuration, environment variables,
  deployment, development commands, testing procedures, or important
  dependencies.
- Record durable project-wide constraints in this file. Do not use it as a
  session log.
- Keep documentation about current behavior accurate; Git history holds the
  old behavior.
- Do not create documentation noise for line-level implementation details.
- When substantial work is unfinished, create or update
  `docs/agent/HANDOFF.md` with the task, completed work, remaining work,
  important decisions, relevant files, and last validation. Keep it concise and
  remove it on completion.

## Logical commits

Commit coherent, tested units as synchronization checkpoints. Use conventional
commit messages. Before each commit, inspect the diff, run proportionate
validation, update affected docs, and stage only the intended files. Do not
create meaningless tiny commits or leave a large collection of unrelated work
uncommitted.

Do not amend, rewrite, or discard another person's commits unless the user
explicitly asks.

## Project safety and validation

- Never call a live MetaKocka company during development or tests. Use recorded
  fixtures and `docs/metakocka-verification.md`; live probes require an explicit
  human decision and the designated test company.
- Do not invent MetaKocka or Shopify fields. Validate external boundaries and
  follow `docs/BUILD_SPEC.md`.
- Keep migrations additive; never edit an applied migration.
- Preserve the repository's type-safety and architectural boundary rules: no
  `any`, no unchecked assertions across an external boundary, and no forbidden
  imports.
- The standard code-change validation is `npm run typecheck`, `npm run lint`,
  and `npx vitest run`. Run narrower checks during development when useful, but
  run the full relevant set before a final code commit unless an explicit
  blocker is documented.

## Completion checklist

Before calling a feature complete:

1. Inspect `git status` and the complete relevant diff.
2. Run relevant tests plus typecheck, lint, and build/schema checks when
   applicable.
3. Update current documentation and remove or update stale handoff information.
4. Verify temporary debugging code and secrets were not introduced.
5. Create the final logical commit so the repository is safe for immediate
   takeover.

If work remains or validation could not run, say so in both the active handoff
and the user-facing report.
