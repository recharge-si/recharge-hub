# Fulfilment orchestrator

Fulfilment orchestrator is an embedded public Shopify app that connects a
merchant's Shopify store to MetaKocka ERP. It allocates order lines across own
and partner supply sources, creates the corresponding MetaKocka sales orders,
and synchronizes inventory according to per-location ownership rules.

The app is production-oriented but not feature-complete. Core order, catalogue,
inventory, payment, reconciliation, dashboard, and exception flows exist; see
[project status](docs/project-status.md) for known gaps and decisions still
required.

## Stack

- Node.js 22 and strict TypeScript
- React Router 7 with Shopify App Bridge and Polaris web components
- PostgreSQL 16, Prisma, and pg-boss
- Vitest with recorded Shopify and MetaKocka fixtures
- Docker Compose with Caddy for production ingress

## Quick start

Requirements: Node.js 22.12 or newer, Docker, a Shopify Partner account, and a
development store.

```bash
npm install
cp .env.example .env
docker compose up -d postgres
npm run setup
npm run config:link
npm run env -- pull
npm run dev
```

Generate a unique `ENCRYPTION_KEY` before starting the app:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

On PowerShell, use `Copy-Item .env.example .env` instead of `cp`.

`npm run dev` starts the web server and worker together. Detailed setup,
Shopify CLI caveats, environment variables, database workflows, and production
commands are in [development](docs/development.md).

## Validate

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Tests and development must never call a live MetaKocka company. Use recorded
fixtures and the verification record instead.

## Repository map

```text
src/domain/       Pure deterministic business rules
src/adapters/     Shopify, MetaKocka, database, queue, crypto, observability
src/jobs/         pg-boss handlers, schedules, and worker entry point
src/web/          React Router routes and Shopify embedded UI
prisma/           Current schema and additive migration history
tests/            Unit/integration tests and recorded fixtures
docs/             Current product, architecture, integration, and dev knowledge
ops/              Production ingress configuration
```

Start with [architecture](docs/architecture.md) to find implementation entry
points. The product and architecture target remains
[the build specification](docs/BUILD_SPEC.md).

## Documentation

- [Architecture](docs/architecture.md) — current components, boundaries, flows,
  data groups, and where new code belongs
- [Development](docs/development.md) — setup, commands, environment, migrations,
  testing, and deployment
- [Integrations](docs/integrations.md) — Shopify and MetaKocka responsibilities
  and code entry points
- [Project status](docs/project-status.md) — implemented scope, limitations,
  open decisions, and technical debt
- [MetaKocka verification](docs/metakocka-verification.md) — observed API
  behavior from the designated test company
- [UI conventions](docs/ui-conventions.md) — merchant-facing terminology and
  interaction rules
- [Agent instructions](AGENTS.md) — shared operating rules for Claude, Codex,
  and other coding agents
