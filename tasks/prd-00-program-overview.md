# Program overview: Recharge Hub, its APIs, metafields, and the AI rig builder

Status: draft for Grega. Written 2026-10-28 against `main` @ 28b0d09. Nothing here is implemented.

Four PRDs, in dependency order:

| # | PRD | One line |
|---|---|---|
| 1 | `prd-01-api-contracts.md` | Make the three API boundaries provably agree, and run the first live pass (T-27). |
| 2 | `prd-02-metafields-go-live.md` | Turn the product-setup plan into real Shopify metafield definitions and filled values; run bulk filling through claude-pool. |
| 3 | `prd-03-ui-coherence.md` | One name, one navigation, one process header, one polling hook, one rule for colour. |
| 4 | `prd-04-ai-rig-builder.md` | Buyers describe themselves on recharge.si and get a compatible, in-stock rig they can add to the cart in one click. |

Prototype for PRD 4 (local file, no artifact): `tasks/prototypes/rig-builder.html`.

## What I verified before writing (evidence, not recall)

- `npm ci`, `npm run typecheck`, `npm run lint`, `npx vitest run` on `main`: typecheck and lint clean; **1359 passed, 94 skipped, 0 failed** (116 files passed, 22 skipped). The skipped files are the DB-backed ones that need PostgreSQL.
- Not run: `npm run test:e2e`, `npm run build`, the portal's `npm test`, the integration API's `npm run check:schema`. Those repos have no `node_modules` on this machine. PRD 1 makes running them step one.
- `docs/attributes.md` and `docs/project-status.md` T-25 state that **no metafield definition is created in Shopify**. The plan is the deliverable; values are written untyped when no definition exists. The nav item named "Metafields" therefore manages a plan, not metafields.
- The theme (`rechargesi`) reads no `recharge.*` metafield at all. It reads `reviews.*` and `custom.stock_by_location`.
- The catalogue snapshot (`catalog_variant`) stores the variant **title** only, no `selectedOptions`, no stock, no description.
- `shopify.app.toml` has no `[app_proxy]`. No route uses `authenticate.public`. The Docker image has no `claude` CLI or Python, so `claude-pool` is not available inside the worker container.
- Contract audit (static read): Sources API endpoints, statuses and enums line up between hub and portal; the vendored feed schema is byte-identical. Four real risks found (PRD 1).

## The dependency map

```
 partner feeds -> integration API --(Own Source feed, own-source.v1.json)--> portal API --(Sources API /api/v1)--> recharge-hub
                                                                           |                                        |
                                                                           +-- Shopify push (portal's own install) --+-- Shopify (hub's install: metafields, menu, translations)
                                                                                                                    |
                                                                          recharge.si theme  <--(App Proxy, new)----+
```

The rig builder sits at the far end. It is only as good as the data behind it: product type, compatibility attributes, variant sizes, stock. Those come from feeds (PRD 1), are named and typed by the plan and written by metafields (PRD 2), and are shown to the merchant by the hub UI (PRD 3). That is why the order matters.

## Recommended order, and what can run in parallel

1. **PRD 1 first, small.** Run the offline suites in the other two repos, fix the four risks, do the live T-27 pass. Without a live pass nothing downstream is trustworthy.
2. **PRD 2 and PRD 3 in parallel** (different files; PRD 3 touches routes and components, PRD 2 touches `adapters/shopify`, `domain/attributes`, jobs). PRD 3's rename of "Metafields" to "Product setup" must land before PRD 2 adds screens, so the new screens use the final name.
3. **PRD 4 after PRD 2's definitions exist** on the store and at least one product family (sails, masts, boards) is filled. The pure engine and the page can be built earlier against fixtures.

One branch name per feature across repos (`recharge-<slug>`), contract-first merge order, per `~/recharge-si/CLAUDE.md`.

## Decisions I made so you do not have to answer before I can write (all reversible; listed again under each PRD's Open Questions)

| Decision | Default taken | Why | Change it if |
|---|---|---|---|
| What "rig" means | A complete windsurf kit: board, sail, mast, boom, base/extension, fin, plus optional harness and accessories. Wing/foil is a later discipline in the same engine. | The store's lead collection is windsurf and the starter schema is sails and boards. | You want wing or foil first. |
| Claude through claude-pool for the public rig builder | **Yes (Grega, 2026-10-28):** it is how the team runs claude-pool. AI stays off the critical path: the pure engine returns the rig first; the model only reads free text and writes reasons; exhaustion (exit 75), timeout or a busy pool give plain mode. Needs `claude`, Python and the pool dir in the hub image (PRD 4 US-412). | A pool or terms problem shows up. |
| Where the rig-builder backend lives | recharge-hub, behind a Shopify App Proxy. | It already has the catalogue snapshot, the attribute plan, the job queue, Sentry and the AI usage ledger. | You prefer a separate service. |
| AI role in the rig builder | AI reads the buyer's text into a structured profile and writes the explanations. **Pure code** chooses and verifies compatible products. | Compatibility is safety-relevant and must be testable. A model that can pick SKUs can invent them. | Never. |
| Prototype format | Local HTML file, three variants. | You asked for no artifacts. This replaces the skill's Design-artifact step. | |
| Prototype variant | **C, Live rig** (decided). A and B removed. | |
| Rules table sign-off | Manual by Recharge staff (decided). | |
| App Proxy | Grega enables it and does any manual app setup (decided). | |

## Deviations from the writing-prds skill (and why)

- The skill is written for Laravel projects (`php artisan test`, `<InputError>`, `organization_id`). This repo is TypeScript, React Router, Prisma, Vitest and Playwright, and its `AGENTS.md` wins. Layer tags are therefore `[unit]` (Vitest, pure domain), `[adapter]` (Vitest with recorded fixtures, no network), `[db]` (real PostgreSQL, `tests/db/`), `[e2e]` (Playwright, `npm run test:e2e`), `[browser]` (dev-browser against a running page). Tenant scoping is `shop_id`.
- The skill's Design-artifact step is replaced by a local HTML prototype, at your request.
- The skill's `specs/features/` file is not created: this repo has no `specs/` tree. `AGENTS.md` makes `docs/*.md` the home for current behaviour, so each PRD lists which `docs/` file it updates at implementation time.
- The skill asks clarifying questions first. You said you would not be around, so I took defaults and listed them above instead of blocking.

## Standing validation for every PRD

```
npm run typecheck && npm run lint && npx vitest run && npm run build
npm run test:e2e        # when a page, action, job or Shopify call changes
npx prisma validate     # when schema.prisma changes
```
Never call live MetaKocka. Tests stay offline with recorded fixtures.
