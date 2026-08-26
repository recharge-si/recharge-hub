import { boundary } from "@shopify/shopify-app-react-router/server";
import { useState } from "react";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  NotPermittedError,
  getCredential,
  getCredentialSummary,
  markVerified,
  requireCredential,
  saveCredential,
} from "~/adapters/db/repositories/metakocka-credential.server";
import {
  getFallbackPaymentType,
  listCachedPaymentTypes,
  listPaymentTypeMaps,
  replaceCachedPaymentTypes,
  replacePaymentTypeMaps,
  saveFallbackPaymentType,
} from "~/adapters/db/repositories/payment-type-map.server";
import {
  listProfitCenters,
  saveProfitCenter,
} from "~/adapters/db/repositories/profit-center.server";
import { getReadiness } from "~/adapters/db/repositories/readiness.server";
import {
  getSalesOrderSettings,
  saveSalesOrderSettings,
} from "~/adapters/db/repositories/sales-order-setting.server";
import {
  getSetupState,
  markSetupComplete,
  saveSetupStep,
} from "~/adapters/db/repositories/shop.server";
import {
  getSupplyDefaults,
  saveSupplyDefaults,
} from "~/adapters/db/repositories/supply-setting.server";
import {
  listCachedWarehouses,
  listSupplySources,
  replaceCachedWarehouses,
} from "~/adapters/db/repositories/supply-source.server";
import { MetakockaClient } from "~/adapters/metakocka/client";
import {
  MetakockaError,
  describeForMerchant,
} from "~/adapters/metakocka/errors";
import { discoverPaymentTypes } from "~/adapters/metakocka/payment-types";
import { validateProfitCenter } from "~/adapters/metakocka/profit-centers";
import { listWarehouses } from "~/adapters/metakocka/warehouses";
import { enqueueThrottled } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { listLocations } from "~/adapters/shopify/locations";
import { listPaymentGateways } from "~/adapters/shopify/payment-gateways";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { suggestPaymentMapping } from "~/domain/payments/gateway-match";
import {
  DEFAULT_CUSTOMER_ORDER_TEMPLATE,
  ORDER_REFERENCE_PLACEHOLDERS,
  orderReferenceFor,
  unknownPlaceholders,
} from "~/domain/orders/reference";
import {
  describeDirection,
  type ReadinessComponent,
  type StockDirectionValue,
} from "~/domain/readiness";
import { Dropdown, type DropdownOption } from "~/web/components/dropdown";
import { ReadinessList } from "~/web/components/readiness-list";
import { INHERIT, toDirection } from "~/web/lib/locations";
import { saveLocationMapping } from "~/web/lib/locations.server";
import { gatewayLabel } from "~/web/lib/payment-gateways";
import {
  isOwnershipKnown,
  principalFromSession,
} from "~/web/lib/principal.server";

/**
 * Guided setup (the product UX brief, section 3).
 *
 * Five steps, and the last one is the only thing that starts anything. Getting
 * as far as saving MetaKocka credentials used to be enough to make the app
 * start filing sales orders, which meant a merchant halfway through choosing
 * their warehouses already had documents in their ERP filed against the answers
 * they had not given yet. `shop.setup_completed_at` is now the boundary, and
 * both MetaKocka writers read it.
 *
 * Progress is persisted twice over, and the two are different things:
 *
 *  - **The configuration** goes into the tables that already own it —
 *    `metakocka_credential`, `supply_setting`, `supply_source`,
 *    `payment_type_map`, `sales_order_setting`. There is no wizard-shaped copy
 *    of any setting, so finishing setup writes nothing that was not already
 *    saved and leaving halfway loses nothing.
 *  - **The place in the flow** goes into `shop.setup_step`, which decides
 *    nothing at all. Closing the tab and coming back reopens the step the
 *    merchant left, and that is its entire job.
 *
 * Nothing here awaits MetaKocka on a render (docs/BUILD_SPEC.md section 2.5).
 * The two calls it makes — verifying the credentials, checking a profit
 * centre — are actions a merchant took by pressing a button.
 */

const STEPS = ["welcome", "connect", "stock", "orders", "review"] as const;
type Step = (typeof STEPS)[number];

const STEP_TITLE: Record<Step, string> = {
  welcome: "Welcome",
  connect: "Connect MetaKocka",
  stock: "Warehouses and stock",
  orders: "Orders and payments",
  review: "Review",
};

function toStep(raw: string | null): Step {
  return (STEPS as readonly string[]).includes(raw ?? "")
    ? (raw as Step)
    : "welcome";
}

function previousStep(step: Step): Step {
  const index = STEPS.indexOf(step);
  return STEPS[Math.max(0, index - 1)] ?? "welcome";
}

/** Long enough that reloading the page a few times sends one job, not five. */
const REFRESH_THROTTLE_SECONDS = 5 * 60;

/* -------------------------------------------------------------------------- */
/* Loader                                                                     */
/* -------------------------------------------------------------------------- */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const url = new URL(request.url);
  const saved = await getSetupState(principal);
  const step = toStep(url.searchParams.get("step") ?? saved.step);

  const common = {
    step,
    /*
     * A message from the step just completed. Untrusted only in the sense that
     * it comes back through the URL; it is rendered as text, and a merchant who
     * edits it is talking to themselves.
     */
    note: url.searchParams.get("note"),
    stepIndex: STEPS.indexOf(step),
    stepCount: STEPS.length,
    stepTitle: STEP_TITLE[step],
    alreadyCompleted: saved.completedAt !== null,
    isShopOwner: principal.isShopOwner,
    ownershipKnown: isOwnershipKnown(session),
  };

  if (step === "connect") {
    return {
      ...common,
      connect: await getCredentialSummary(principal),
      stock: null,
      orders: null,
      review: null,
    };
  }

  if (step === "stock") {
    const [defaults, warehouses, sources, locations] = await Promise.all([
      getSupplyDefaults(principal),
      listCachedWarehouses(principal),
      listSupplySources(principal),
      listLocations(admin),
    ]);

    const markByLocation = new Map(
      sources
        .filter(
          (source) =>
            source.shopifyLocationId !== null &&
            source.metakockaWarehouse !== null,
        )
        .map((source) => [
          source.shopifyLocationId!,
          source.metakockaWarehouse!,
        ]),
    );

    /*
     * A warehouse whose name matches the location's is offered as the answer.
     *
     * Only an exact, case-insensitive match. A near match is how a merchant
     * ends up publishing one warehouse's stock into another location's shelf,
     * and the mapping is short enough to choose by hand.
     */
    const byName = new Map(
      warehouses.map((warehouse) => [
        warehouse.name.trim().toLowerCase(),
        warehouse.mark,
      ]),
    );

    return {
      ...common,
      connect: null,
      stock: {
        direction: String(defaults.defaultStockDirection),
        warehouses: warehouses.map((warehouse) => ({
          mark: warehouse.mark,
          name: warehouse.name,
        })),
        locations: locations.map((location) => ({
          id: location.id,
          name: location.name,
          where: location.where,
          isActive: location.isActive,
          fulfillmentServiceName: location.fulfillmentServiceName,
          mark:
            markByLocation.get(location.id) ??
            byName.get(location.name.trim().toLowerCase()) ??
            "",
        })),
      },
      orders: null,
      review: null,
    };
  }

  if (step === "orders") {
    const [
      settings,
      defaults,
      register,
      types,
      maps,
      fallback,
      gateways,
      recent,
    ] = await Promise.all([
      getSalesOrderSettings(principal),
      getSupplyDefaults(principal),
      listProfitCenters(principal),
      listCachedPaymentTypes(principal),
      listPaymentTypeMaps(principal),
      getFallbackPaymentType(principal),
      listPaymentGateways(admin),
      prisma.order.findFirst({
        where: { shop: { domain: session.shop }, shopifyDeletedAt: null },
        orderBy: { receivedAt: "desc" },
        select: { shopifyOrderId: true, shopifyOrderNumber: true },
      }),
    ]);

    const known = [
      ...new Set([...gateways, ...maps.map((row) => row.shopifyGateway)]),
    ].sort((a, b) => gatewayLabel(a).localeCompare(gatewayLabel(b)));

    const mapping = Object.fromEntries(
      maps.map((row) => [row.shopifyGateway, row.metakockaPaymentType]),
    );
    const typeValues = types.map((type) => type.value);

    return {
      ...common,
      connect: null,
      stock: null,
      orders: {
        template: settings.customerOrderTemplate ?? "",
        defaultTemplate: DEFAULT_CUSTOMER_ORDER_TEMPLATE,
        fields: ORDER_REFERENCE_PLACEHOLDERS.map(
          (placeholder) => `{{${placeholder.token}}}`,
        ),
        sample: recent
          ? {
              name: `#${recent.shopifyOrderNumber}`,
              number: recent.shopifyOrderNumber,
              id: recent.shopifyOrderId,
            }
          : null,
        profitCenter: defaults.defaultProfitCenter ?? "",
        register: register.map((entry) => entry.value),
        gateways: known,
        paymentTypes: typeValues.sort((a, b) => a.localeCompare(b)),
        mapping: {
          ...mapping,
          // Proposed, never applied: these arrive as the form's initial value,
          // and only saving the step writes them.
          ...suggestPaymentMapping(known, typeValues, mapping),
        },
        fallback: fallback ?? "",
      },
      review: null,
    };
  }

  if (step === "review") {
    const readiness = await getReadiness(principal);
    return {
      ...common,
      connect: null,
      stock: null,
      orders: null,
      review: {
        components: readiness.components,
        blocking: readiness.blocking,
      },
    };
  }

  return { ...common, connect: null, stock: null, orders: null, review: null };
};

/* -------------------------------------------------------------------------- */
/* Action                                                                     */
/* -------------------------------------------------------------------------- */

interface StepResult {
  ok: boolean;
  message: string;
  /** Rendered against the field it concerns (section 2.8). */
  field?: string;
}

const connectSchema = z.object({
  companyId: z
    .string()
    .trim()
    .min(1, "Enter the company ID shown in MetaKocka under company settings."),
  secretKey: z.string().trim(),
  apiUserEmail: z
    .string()
    .trim()
    .min(1, "Enter the MetaKocka API user email.")
    .email("Enter a valid email address."),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const step = toStep(String(formData.get("step") ?? ""));

  /*
   * Moving on, optionally carrying something the merchant has to be told.
   *
   * A note travels in the URL rather than in the action's result because the
   * step it belongs to is the *next* one: the work succeeded, so keeping the
   * merchant on the step they just completed would be a red banner over a
   * saved form, and pressing Continue again would produce the same note for
   * ever.
   */
  const go = (to: Step, note?: string) =>
    redirect(
      note
        ? `/app/setup?step=${to}&note=${encodeURIComponent(note)}`
        : `/app/setup?step=${to}`,
    );

  if (intent === "back") {
    const to = previousStep(step);
    await saveSetupStep(principal, to);
    throw go(to);
  }

  if (intent === "start") {
    await saveSetupStep(principal, "connect");
    throw go("connect");
  }

  /* ---------------------------------------------------------------------- */
  /* Connect                                                                */
  /* ---------------------------------------------------------------------- */

  if (intent === "connect") {
    const parsed = connectSchema.safeParse({
      companyId: formData.get("companyId") ?? "",
      secretKey: formData.get("secretKey") ?? "",
      apiUserEmail: formData.get("apiUserEmail") ?? "",
    });

    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        message: issue?.message ?? "Check the fields above.",
        field: String(issue?.path[0] ?? ""),
      } satisfies StepResult;
    }

    const summary = await getCredentialSummary(principal);
    if (!summary.connected && parsed.data.secretKey === "") {
      return {
        ok: false,
        field: "secretKey",
        message:
          "Enter the secret key from MetaKocka. It is required to connect.",
      } satisfies StepResult;
    }

    try {
      await saveCredential(principal, {
        companyId: parsed.data.companyId,
        ...(parsed.data.secretKey ? { secretKey: parsed.data.secretKey } : {}),
        apiUserEmail: parsed.data.apiUserEmail,
      });

      const credential = await getCredential(principal);
      if (!credential) {
        return {
          ok: false,
          message: "The credentials could not be read back. Try again.",
        } satisfies StepResult;
      }

      /*
       * `warehouse_list` is the connection test (docs/BUILD_SPEC.md section 13,
       * M2). It authenticates, proves the company is reachable and returns the
       * warehouses the next step needs, all without creating anything — which
       * is why the connection is never tested by writing a document.
       */
      const client = new MetakockaClient(
        { companyId: credential.companyId, secretKey: credential.secretKey },
        { timeoutMs: 15_000 },
      );
      const warehouses = await listWarehouses(client);

      await replaceCachedWarehouses(
        principal,
        warehouses.map((warehouse) => ({
          mkId: warehouse.mkId,
          mark: warehouse.mark,
          name: warehouse.name,
          isMain: warehouse.isMain,
          isActive: warehouse.isActive,
          includeInStockInfo: warehouse.includeInStockInfo,
        })),
      );
      await markVerified(principal);
      await appendEvent(principal, {
        entityType: "metakocka_credential",
        event: "metakocka.connection_verified",
        detail: { warehouseCount: warehouses.length, via: "setup" },
      });

      /*
       * The payment register, read here so the Orders step has something to
       * offer. Best effort on purpose: MetaKocka has no endpoint that lists
       * payment types and this reads them out of a deliberate rejection
       * (`adapters/metakocka/payment-types`), so a shop whose company answers
       * differently gets an empty list and a Refresh button rather than a
       * failed connection.
       */
      try {
        const values = await discoverPaymentTypes(
          new MetakockaClient(
            {
              companyId: credential.companyId,
              secretKey: credential.secretKey,
            },
            { timeoutMs: 20_000 },
          ),
        );
        if (values) await replaceCachedPaymentTypes(principal, values);
      } catch {
        await enqueueThrottled(
          QUEUES.reloadPaymentTypes,
          { shopDomain: principal.shopDomain },
          `payment-types:${principal.shopDomain}`,
          REFRESH_THROTTLE_SECONDS,
        );
      }

      await saveSetupStep(principal, "stock");
      throw go("stock");
    } catch (error) {
      if (error instanceof Response) throw error;
      if (error instanceof NotPermittedError) {
        return { ok: false, message: error.message } satisfies StepResult;
      }
      if (error instanceof MetakockaError) {
        return {
          ok: false,
          message: `MetaKocka did not accept those credentials. ${describeForMerchant(error)}`,
        } satisfies StepResult;
      }
      /*
       * Every failure the client can produce is a `MetakockaError`, including a
       * timeout and a refused connection. Anything else is a bug in this app,
       * and swallowing it into "check your credentials" would send the merchant
       * looking for a problem they do not have.
       */
      throw error;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Warehouses and stock                                                   */
  /* ---------------------------------------------------------------------- */

  if (intent === "stock") {
    const direction = toDirection(String(formData.get("direction") ?? "none"));

    const pairs = formData
      .getAll("locationId")
      .map((value) => String(value))
      .map((locationId) => ({
        locationId,
        mark: String(formData.get(`warehouse:${locationId}`) ?? "").trim(),
        name: String(formData.get(`name:${locationId}`) ?? ""),
      }));

    /*
     * One warehouse cannot serve two locations here.
     *
     * `saveLocationMapping` would happily move it from the first to the second,
     * which is right when a merchant is deliberately editing one location and
     * wrong when they are filling in a list: they would leave setup with the
     * first location silently disconnected.
     */
    const chosen = pairs.map((pair) => pair.mark).filter(Boolean);
    const duplicate = chosen.find(
      (mark, index) => chosen.indexOf(mark) !== index,
    );
    if (duplicate) {
      return {
        ok: false,
        message: `Two locations are set to the same MetaKocka warehouse (${duplicate}). Each warehouse belongs to one location.`,
      } satisfies StepResult;
    }

    // The default first, so every mapping below inherits the answer just given.
    const { blocked } = await saveSupplyDefaults(principal, {
      defaultStockDirection: direction,
      defaultProfitCenter: (await getSupplyDefaults(principal))
        .defaultProfitCenter,
    });

    for (const pair of pairs) {
      const outcome = await saveLocationMapping(principal, {
        shopifyLocationId: pair.locationId,
        warehouseMark: pair.mark,
        locationName: pair.name,
        direction: INHERIT,
        profitCenter: INHERIT,
      });
      if (!outcome.ok) {
        return { ok: false, message: outcome.message } satisfies StepResult;
      }
    }

    await appendEvent(principal, {
      entityType: "supply_source",
      event: "supply_defaults.saved",
      detail: { direction, via: "setup", connected: chosen.length },
    });

    await saveSetupStep(principal, "orders");
    throw go(
      "orders",
      blocked.length > 0
        ? `${blocked.join(", ")} kept ${blocked.length === 1 ? "its" : "their"} own stock setting, because another warehouse already writes stock to that location. Section 7 allows one writer per location; check it on the Locations page after setup.`
        : undefined,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Orders and payments                                                    */
  /* ---------------------------------------------------------------------- */

  if (intent === "orders") {
    const template = String(formData.get("template") ?? "").trim();
    const unknown = unknownPlaceholders(template);
    if (unknown.length > 0) {
      return {
        ok: false,
        field: "template",
        message: `${unknown.map((field) => `{{${field}}}`).join(", ")} ${unknown.length === 1 ? "is not a field" : "are not fields"} this app can fill in.`,
      } satisfies StepResult;
    }

    const fallback = String(formData.get("fallback") ?? "").trim();
    if (fallback === "") {
      return {
        ok: false,
        field: "fallback",
        message:
          "Choose the payment type to use for any method with no mapping of its own. Nothing is guessed, so without it an order paid that way cannot be recorded.",
      } satisfies StepResult;
    }

    const gateways = formData.getAll("gateway").map((value) => String(value));
    const entries = gateways
      .map((gateway) => ({
        shopifyGateway: gateway.trim(),
        metakockaPaymentType: String(
          formData.get(`type:${gateway}`) ?? "",
        ).trim(),
      }))
      .filter(
        (row) => row.shopifyGateway !== "" && row.metakockaPaymentType !== "",
      );

    /*
     * A profit centre is checked before it is stored, because MetaKocka refuses
     * a whole document over one it does not recognise and offers no endpoint
     * that lists them (docs/BUILD_SPEC.md section 7). `unknown` is an answer,
     * not a failure: a value we could not check is stored and said so.
     */
    const profitCenter = String(formData.get("profitCenter") ?? "").trim();
    if (profitCenter) {
      const register = await listProfitCenters(principal);
      if (!register.some((entry) => entry.value === profitCenter)) {
        // `requireCredential` rather than `getCredential`, because the latter
        // throws for a staff account and an unhandled throw in an action is a
        // 500 where the honest answer is "the ERP key belongs to the store
        // owner" (docs/BUILD_SPEC.md section 9).
        const access = await requireCredential(principal);
        if (!access.ok) {
          return {
            ok: false,
            field: "profitCenter",
            message:
              access.reason === "not_permitted"
                ? access.message
                : "MetaKocka is not connected, so the profit centre could not be checked.",
          } satisfies StepResult;
        }
        const credential = access.credential;

        try {
          const verdict = await validateProfitCenter(
            new MetakockaClient(
              {
                companyId: credential.companyId,
                secretKey: credential.secretKey,
              },
              { timeoutMs: 30_000 },
            ),
            profitCenter,
          );
          if (verdict === "invalid") {
            return {
              ok: false,
              field: "profitCenter",
              message: `MetaKocka has no profit centre called "${profitCenter}". Add it in MetaKocka first, or leave this empty.`,
            } satisfies StepResult;
          }
          await saveProfitCenter(principal, profitCenter, verdict);
        } catch (error) {
          if (!(error instanceof MetakockaError)) throw error;
          await saveProfitCenter(principal, profitCenter, "unknown");
        }
      }
    }

    const defaults = await getSupplyDefaults(principal);
    await saveSupplyDefaults(principal, {
      defaultStockDirection: defaults.defaultStockDirection,
      defaultProfitCenter: profitCenter || null,
    });

    const settings = await getSalesOrderSettings(principal);
    await saveSalesOrderSettings(principal, {
      ...settings,
      customerOrderTemplate:
        template === "" || template === DEFAULT_CUSTOMER_ORDER_TEMPLATE
          ? null
          : template,
    });

    await replacePaymentTypeMaps(principal, entries);
    await saveFallbackPaymentType(principal, fallback);
    await appendEvent(principal, {
      entityType: "payment_type",
      event: "payment_types.saved",
      detail: { count: entries.length, fallback, via: "setup" },
    });

    await saveSetupStep(principal, "review");
    throw go("review");
  }

  /* ---------------------------------------------------------------------- */
  /* Finish                                                                 */
  /* ---------------------------------------------------------------------- */

  if (intent === "finish") {
    /*
     * Readiness is recomputed from what is stored, not from what the wizard
     * believes it saved. The two are the same thing right up until a merchant
     * changes something in another tab.
     */
    const readiness = await getReadiness(principal);
    if (readiness.blocking.length > 0) {
      return {
        ok: false,
        message: `${readiness.blocking.map((component) => component.title).join(", ")} ${readiness.blocking.length === 1 ? "still needs" : "still need"} attention. Nothing was started.`,
      } satisfies StepResult;
    }

    /*
     * Idempotent in both halves. `markSetupComplete` only matches a shop that
     * has not completed, and each enqueue below is throttled on a per-shop key,
     * so pressing Finish twice activates once and queues one of each job.
     */
    const activated = await markSetupComplete(principal, new Date());

    await enqueueThrottled(
      QUEUES.reconcileOrders,
      { shopDomain: principal.shopDomain },
      `orders:${principal.shopDomain}`,
      REFRESH_THROTTLE_SECONDS,
    );
    await enqueueThrottled(
      QUEUES.syncInventory,
      { shopDomain: principal.shopDomain },
      `inventory:${principal.shopDomain}`,
      REFRESH_THROTTLE_SECONDS,
    );
    await enqueueThrottled(
      QUEUES.syncCatalogue,
      { shopDomain: principal.shopDomain },
      `catalogue:${principal.shopDomain}`,
      REFRESH_THROTTLE_SECONDS,
    );

    if (activated) {
      await appendEvent(principal, {
        entityType: "shop",
        event: "setup.completed",
        detail: {
          stock: readiness.components.find((entry) => entry.key === "stock")
            ?.summary,
          payments: readiness.components.find(
            (entry) => entry.key === "payments",
          )?.summary,
        },
      });
    }

    throw redirect("/app");
  }

  return {
    ok: false,
    message: "That action is not available. Reload the page.",
  };
};

/* -------------------------------------------------------------------------- */
/* UI                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Where the merchant is, in words.
 *
 * Polaris ships no progress component, and a bar assembled out of boxes would
 * be a custom control with a made-up meaning (section 2.6). A sentence says the
 * same thing, reads the same to a screen reader, and cannot be a rejection
 * reason.
 */
function Progress({
  index,
  count,
  title,
}: {
  index: number;
  count: number;
  title: string;
}) {
  return (
    <s-text color="subdued">{`Step ${index + 1} of ${count} · ${title}`}</s-text>
  );
}

export default function Setup() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const { step, stepIndex, stepCount, stepTitle } = data;

  return (
    <s-page heading="Set up MetaKocka">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      <s-stack direction="block" gap="large">
        <Progress index={stepIndex} count={stepCount} title={stepTitle} />

        {/*
         * Errors are persistent and stated where they can be acted on
         * (section 2.8). A field-level failure renders against its field as
         * well; this is the one that has no field to sit against.
         */}
        {result && !result.ok && !result.field ? (
          <s-banner tone="critical" heading="That could not be saved">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        {data.note && !(result && !result.ok) ? (
          <s-banner tone="warning" heading="Saved, with one thing to check">
            <s-paragraph>{data.note}</s-paragraph>
          </s-banner>
        ) : null}

        {data.alreadyCompleted ? (
          <s-banner tone="info" heading="Setup is already finished">
            <s-paragraph>
              Synchronization is running. Going through these steps again
              changes the same settings the rest of the app uses; nothing is
              reset.
            </s-paragraph>
          </s-banner>
        ) : null}

        {step === "welcome" ? <WelcomeStep busy={busy} /> : null}
        {step === "connect" && data.connect ? (
          <ConnectStep
            summary={data.connect}
            allowed={data.isShopOwner}
            ownershipKnown={data.ownershipKnown}
            result={result}
            busy={busy}
          />
        ) : null}
        {step === "stock" && data.stock ? (
          <StockStep stock={data.stock} busy={busy} />
        ) : null}
        {step === "orders" && data.orders ? (
          <OrdersStep orders={data.orders} result={result} busy={busy} />
        ) : null}
        {step === "review" && data.review ? (
          <ReviewStep review={data.review} busy={busy} />
        ) : null}
      </s-stack>
    </s-page>
  );
}

/**
 * The bar of step actions every step ends with.
 *
 * One submit button and one hidden intent per form: `s-button` is a custom
 * element, and relying on a `name`/`value` pair on it to say which of two
 * buttons was pressed is relying on an implementation detail. Back writes
 * nothing, so it is a link and needs no form at all.
 */
function StepActions({
  step,
  intent,
  label,
  busy,
  disabled = false,
}: {
  step: Step;
  intent: string;
  label: string;
  busy: boolean;
  disabled?: boolean;
}) {
  const back = previousStep(step);

  return (
    <s-stack direction="inline" gap="base" alignItems="center">
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="step" value={step} />
      <s-button
        type="submit"
        variant="primary"
        {...(busy || disabled ? { disabled: true } : {})}
      >
        {label}
      </s-button>
      {step === "welcome" ? null : (
        <s-button variant="tertiary" href={`/app/setup?step=${back}`}>
          Back
        </s-button>
      )}
    </s-stack>
  );
}

function WelcomeStep({ busy }: { busy: boolean }) {
  return (
    <Form method="post">
      <s-section heading="What this app does">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            It keeps MetaKocka and this Shopify store describing the same
            business: orders become MetaKocka sales orders, payments are
            recorded against them, and stock stays in step between the two.
          </s-paragraph>
          <s-unordered-list>
            <s-list-item>
              Every Shopify order becomes a MetaKocka sales order. An order
              shipping from two warehouses becomes one sales order per
              warehouse, never a duplicate.
            </s-list-item>
            <s-list-item>
              Payments are recorded as they arrive, including an order paid in
              two parts.
            </s-list-item>
            <s-list-item>
              Stock is copied one way per warehouse, in whichever direction you
              count it.
            </s-list-item>
          </s-unordered-list>
          <s-paragraph>
            Setup takes four short steps. Nothing is sent to MetaKocka until you
            finish the last one.
          </s-paragraph>
          <StepActions
            step="welcome"
            intent="start"
            label="Get started"
            busy={busy}
          />
        </s-stack>
      </s-section>
    </Form>
  );
}

function ConnectStep({
  summary,
  allowed,
  ownershipKnown,
  result,
  busy,
}: {
  summary: {
    companyId: string | null;
    secretKeyMask: string | null;
    apiUserEmail: string | null;
  };
  allowed: boolean;
  ownershipKnown: boolean;
  result: StepResult | undefined;
  busy: boolean;
}) {
  if (!allowed) {
    return (
      <s-section heading="Store owner only">
        <s-banner tone="warning">
          <s-paragraph>
            {ownershipKnown
              ? "Only the store owner can connect MetaKocka, because the secret key gives full access to the ERP. Ask them to finish this step."
              : "Shopify did not confirm which user you are, so this step stays closed. Open the app again from the Shopify admin, and if this keeps happening, sign in as the store owner."}
          </s-paragraph>
        </s-banner>
      </s-section>
    );
  }

  const errorFor = (field: string) =>
    result && !result.ok && result.field === field ? result.message : undefined;

  return (
    <Form method="post">
      <s-section heading="Connect MetaKocka">
        <s-stack direction="block" gap="base">
          <s-box maxInlineSize="520px">
            <s-stack direction="block" gap="base">
              <s-text-field
                name="companyId"
                label="Company ID"
                defaultValue={summary.companyId ?? ""}
                details="Shown in MetaKocka under company settings."
                error={errorFor("companyId")}
              />
              <s-password-field
                name="secretKey"
                label="Secret key"
                details={
                  summary.secretKeyMask
                    ? `A key ending ${summary.secretKeyMask} is saved. Leave blank to keep it.`
                    : "Paste the key generated in MetaKocka."
                }
                error={errorFor("secretKey")}
              />
              <s-email-field
                name="apiUserEmail"
                label="API user email"
                defaultValue={summary.apiUserEmail ?? ""}
                details="The MetaKocka user stock updates are filed under. MetaKocka refuses a stock update without it, so it is not a contact address."
                error={errorFor("apiUserEmail")}
              />
            </s-stack>
          </s-box>

          <s-paragraph>
            The secret key grants full read and write access to this MetaKocka
            company. It is encrypted before it is stored and never shown again.
          </s-paragraph>

          <s-link
            href="https://metakocka.freshdesk.com/en/support/solutions/articles/3000106126-obtaining-api-key-and-company-id"
            target="_blank"
          >
            How to find your API key and company ID in MetaKocka
          </s-link>

          <s-text color="subdued">
            Connecting reads your warehouse list to check the credentials work.
            Nothing is created in MetaKocka.
          </s-text>

          <StepActions
            step="connect"
            intent="connect"
            label="Connect"
            busy={busy}
          />
        </s-stack>
      </s-section>
    </Form>
  );
}

interface StockData {
  direction: string;
  warehouses: { mark: string; name: string }[];
  locations: {
    id: string;
    name: string;
    where: string | null;
    isActive: boolean;
    fulfillmentServiceName: string | null;
    mark: string;
  }[];
}

function StockStep({ stock, busy }: { stock: StockData; busy: boolean }) {
  const [direction, setDirection] = useState(stock.direction);
  const [marks, setMarks] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      stock.locations.map((location) => [location.id, location.mark]),
    ),
  );

  const flow = describeDirection(direction as StockDirectionValue);

  const warehouseOptions: DropdownOption[] = [
    { value: "", label: "Not connected" },
    ...stock.warehouses.map((warehouse) => ({
      value: warehouse.mark,
      label: `${warehouse.name} (${warehouse.mark})`,
    })),
  ];

  const connected = Object.values(marks).filter(Boolean).length;

  return (
    <Form method="post">
      <s-stack direction="block" gap="large">
        <s-section heading="Stock">
          <s-stack direction="block" gap="base">
            {/*
             * The value travels in a hidden input rather than on the element.
             * Every other multi-field form in this app does the same, because
             * it is the version whose submitted value is not a question about
             * how a custom element participates in a form.
             */}
            <input type="hidden" name="direction" value={direction} />

            <s-choice-list
              label="Where do you normally count stock?"
              values={[direction]}
              onChange={(event) =>
                setDirection(event.currentTarget.values[0] ?? "none")
              }
            >
              <s-choice value="mk_to_shopify">
                MetaKocka
                <s-text slot="details">
                  MetaKocka holds the quantities and Shopify follows them.
                </s-text>
              </s-choice>
              <s-choice value="shopify_to_mk">
                Shopify
                <s-text slot="details">
                  Shopify holds the quantities and MetaKocka follows them. This
                  writes an inventory document in MetaKocka.
                </s-text>
              </s-choice>
              <s-choice value="none">
                Do not synchronize stock
                <s-text slot="details">
                  Orders and payments still work. Neither side&rsquo;s
                  quantities are changed by this app.
                </s-text>
              </s-choice>
            </s-choice-list>

            <s-text color="subdued">
              {flow.flow
                ? `Stock flows ${flow.flow}. Every location follows this unless you change it later.`
                : "No stock is copied in either direction."}
            </s-text>
          </s-stack>
        </s-section>

        <s-section heading="Locations">
          <s-stack direction="block" gap="base">
            {stock.locations.length === 0 ? (
              <s-paragraph>
                This store has no locations. Add one in Shopify settings, then
                come back.
              </s-paragraph>
            ) : (
              <>
                <s-paragraph>
                  Each Shopify location points at the MetaKocka warehouse that
                  holds the same shelf. A location with no warehouse takes no
                  orders and publishes no stock.
                </s-paragraph>

                <s-table variant="auto">
                  <s-table-header-row>
                    <s-table-header listSlot="primary">
                      Shopify location
                    </s-table-header>
                    <s-table-header listSlot="labeled">
                      MetaKocka warehouse
                    </s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {stock.locations.map((location) => (
                      <s-table-row key={location.id}>
                        <s-table-cell>
                          <s-stack direction="block" gap="small-500">
                            <s-text type="strong">{location.name}</s-text>
                            {location.where ? (
                              <s-text color="subdued">{location.where}</s-text>
                            ) : null}
                            {location.fulfillmentServiceName ? (
                              <s-text color="subdued">
                                {`Fulfilled by ${location.fulfillmentServiceName}`}
                              </s-text>
                            ) : null}
                            <input
                              type="hidden"
                              name="locationId"
                              value={location.id}
                            />
                            <input
                              type="hidden"
                              name={`name:${location.id}`}
                              value={location.name}
                            />
                          </s-stack>
                        </s-table-cell>
                        <s-table-cell>
                          <s-box maxInlineSize="280px">
                            <Dropdown
                              name={`warehouse:${location.id}`}
                              label={`MetaKocka warehouse for ${location.name}`}
                              hideLabel
                              placeholder="Not connected"
                              value={marks[location.id] ?? ""}
                              options={warehouseOptions}
                              onChange={(next) =>
                                setMarks((current) => ({
                                  ...current,
                                  [location.id]: next,
                                }))
                              }
                            />
                          </s-box>
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>

                <s-text color="subdued">
                  {connected === 0
                    ? "Connect at least one location so orders have a warehouse to be filed against."
                    : `${connected} of ${stock.locations.length} ${stock.locations.length === 1 ? "location" : "locations"} connected.`}
                </s-text>
              </>
            )}

            <StepActions
              step="stock"
              intent="stock"
              label="Continue"
              busy={busy}
            />
          </s-stack>
        </s-section>
      </s-stack>
    </Form>
  );
}

interface OrdersData {
  template: string;
  defaultTemplate: string;
  fields: string[];
  sample: { name: string; number: string; id: string } | null;
  profitCenter: string;
  register: string[];
  gateways: string[];
  paymentTypes: string[];
  mapping: Record<string, string>;
  fallback: string;
}

function OrdersStep({
  orders,
  result,
  busy,
}: {
  orders: OrdersData;
  result: StepResult | undefined;
  busy: boolean;
}) {
  const [template, setTemplate] = useState(orders.template);
  const [customising, setCustomising] = useState(orders.template !== "");
  const [mapping, setMapping] = useState(orders.mapping);
  const [fallback, setFallback] = useState(orders.fallback);
  const [profitCenter, setProfitCenter] = useState(orders.profitCenter);

  const errorFor = (field: string) =>
    result && !result.ok && result.field === field ? result.message : undefined;

  const badFields = unknownPlaceholders(template);
  const preview = orders.sample
    ? orderReferenceFor(template.trim() || orders.defaultTemplate, {
        name: orders.sample.name,
        number: orders.sample.number,
        id: orders.sample.id,
        customerEmail: null,
      })
    : null;

  const typeOptions: DropdownOption[] = [
    { value: "", label: "Not mapped" },
    ...orders.paymentTypes.map((type) => ({ value: type, label: type })),
  ];
  const fallbackOptions: DropdownOption[] = orders.paymentTypes.map((type) => ({
    value: type,
    label: type,
  }));

  const suggested = orders.gateways.filter(
    (gateway) => (orders.mapping[gateway] ?? "") !== "",
  ).length;

  return (
    <Form method="post">
      <s-stack direction="block" gap="large">
        <s-section heading="Orders">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Shopify orders are created as MetaKocka sales orders
              automatically. An order fulfilled from more than one warehouse
              gets one sales order per warehouse, and the quantities always add
              up to what the customer bought.
            </s-paragraph>

            <s-stack direction="block" gap="small-400">
              <s-text type="strong">Order reference</s-text>
              <s-text>
                {preview
                  ? `Shopify order number. ${orders.sample?.name} would be filed as ${preview.reference}.`
                  : "Shopify order number."}
              </s-text>
              <s-text color="subdued">
                This is what MetaKocka shows as Customer&rsquo;s order, and what
                links the sales orders of one Shopify order to each other.
              </s-text>
            </s-stack>

            {customising ? (
              <s-box maxInlineSize="520px">
                <s-stack direction="block" gap="small-400">
                  <s-text-field
                    name="template"
                    label="Reference pattern"
                    value={template}
                    placeholder={orders.defaultTemplate}
                    onChange={(event) => setTemplate(event.currentTarget.value)}
                    error={
                      errorFor("template") ??
                      (badFields.length > 0
                        ? `${badFields.map((field) => `{{${field}}}`).join(", ")} ${badFields.length === 1 ? "is not a field" : "are not fields"} this app can fill in.`
                        : undefined)
                    }
                  />
                  <s-text color="subdued">
                    {`Fields you can use: ${orders.fields.join(", ")}. Leave empty for the default.`}
                  </s-text>
                </s-stack>
              </s-box>
            ) : (
              <>
                <input type="hidden" name="template" value={template} />
                <s-stack direction="inline">
                  <s-button
                    type="button"
                    variant="tertiary"
                    onClick={() => setCustomising(true)}
                  >
                    Customize
                  </s-button>
                </s-stack>
              </>
            )}

            <s-box maxInlineSize="520px">
              <s-text-field
                name="profitCenter"
                label="Default profit centre (optional)"
                value={profitCenter}
                onChange={(event) => setProfitCenter(event.currentTarget.value)}
                details={
                  orders.register.length > 0
                    ? `Already known: ${orders.register.join(", ")}. Leave empty to let MetaKocka use the company setting.`
                    : "Sent on every sales order. Leave empty to let MetaKocka use the company setting. It is checked against MetaKocka when you continue."
                }
                error={errorFor("profitCenter")}
              />
            </s-box>
          </s-stack>
        </s-section>

        <s-section heading="Payments">
          <s-stack direction="block" gap="base">
            {orders.paymentTypes.length === 0 ? (
              <s-banner tone="warning" heading="No payment types read yet">
                <s-paragraph>
                  MetaKocka has not returned a readable list of payment types.
                  They live in MetaKocka under Settings, Registers. You can
                  finish setup once one is chosen below; the list is re-read
                  overnight and whenever the payments page finds it out of date.
                </s-paragraph>
              </s-banner>
            ) : (
              <s-paragraph>
                {suggested > 0
                  ? "Each Shopify payment method settles into one MetaKocka payment type. Obvious matches are filled in for you — check them before continuing."
                  : "Each Shopify payment method settles into one MetaKocka payment type."}
              </s-paragraph>
            )}

            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">
                  Shopify payment method
                </s-table-header>
                <s-table-header listSlot="labeled">
                  MetaKocka payment type
                </s-table-header>
              </s-table-header-row>
              <s-table-body>
                {orders.gateways.map((gateway) => (
                  <s-table-row key={gateway}>
                    <s-table-cell>
                      <s-stack direction="block" gap="small-500">
                        <s-text type="strong">{gatewayLabel(gateway)}</s-text>
                        <input type="hidden" name="gateway" value={gateway} />
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-box maxInlineSize="260px">
                        <Dropdown
                          name={`type:${gateway}`}
                          label={`MetaKocka payment type for ${gatewayLabel(gateway)}`}
                          hideLabel
                          placeholder="Not mapped"
                          value={mapping[gateway] ?? ""}
                          options={typeOptions}
                          onChange={(next) =>
                            setMapping((current) => ({
                              ...current,
                              [gateway]: next,
                            }))
                          }
                        />
                      </s-box>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>

            <s-box maxInlineSize="360px">
              <Dropdown
                name="fallback"
                label="Type for anything not mapped"
                placeholder="Choose a type"
                value={fallback}
                options={fallbackOptions}
                details="Used for any payment method above with no type of its own. A payment type is never guessed, so this cannot be empty."
                onChange={setFallback}
                {...(errorFor("fallback")
                  ? { error: errorFor("fallback") }
                  : {})}
              />
            </s-box>

            <StepActions
              step="orders"
              intent="orders"
              label="Continue"
              busy={busy}
            />
          </s-stack>
        </s-section>
      </s-stack>
    </Form>
  );
}

function ReviewStep({
  review,
  busy,
}: {
  review: { components: ReadinessComponent[]; blocking: ReadinessComponent[] };
  busy: boolean;
}) {
  return (
    <Form method="post">
      <s-stack direction="block" gap="large">
        <s-section heading="Ready to synchronize">
          <s-stack direction="block" gap="base">
            <ReadinessList components={review.components} />
          </s-stack>
        </s-section>

        <s-section heading="What happens next">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Finishing setup starts automatic synchronization. Orders placed
              while you were setting up are picked up on the first pass, stock
              is read for every connected location, and the two catalogues are
              matched by SKU.
            </s-paragraph>
            <s-text color="subdued">
              Pressing this twice does not create anything twice.
            </s-text>
            <StepActions
              step="review"
              intent="finish"
              label="Finish setup"
              busy={busy}
              disabled={review.blocking.length > 0}
            />
          </s-stack>
        </s-section>
      </s-stack>
    </Form>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
