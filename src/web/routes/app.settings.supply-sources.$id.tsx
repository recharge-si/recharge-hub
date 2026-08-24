import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useRef, useState } from "react";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";
import { z } from "zod";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  codeIsTaken,
  findSupplySource,
  listCachedWarehouses,
  upsertSupplySource,
} from "~/adapters/db/repositories/supply-source.server";
import { listLocations } from "~/adapters/shopify/locations";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { principalFromSession } from "~/web/lib/principal.server";

const NEW = "new";

const inputSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, "Enter a short code, for example OWN or PARTNER1.")
    .max(32, "Use 32 characters or fewer.")
    .regex(
      /^[A-Za-z0-9_-]+$/,
      "Use letters, numbers, hyphens and underscores only. The code becomes part of the MetaKocka document reference.",
    ),
  name: z.string().trim().min(1, "Enter a name the team will recognise."),
  kind: z.enum(["own", "partner"]),
  shopifyLocationId: z.string().trim(),
  inventoryWriter: z.enum(["metakocka", "external", "manual"]),
  metakockaWarehouse: z.string().trim(),
  metakockaProfitCenter: z.string().trim(),
  priority: z.coerce
    .number()
    .int("Use a whole number.")
    .min(0, "Use zero or more."),
  leadTimeDays: z.coerce
    .number()
    .int("Use a whole number.")
    .min(0, "Use zero or more."),
  defaultDeliveryType: z.string().trim(),
  canSplit: z.coerce.boolean(),
  enabled: z.coerce.boolean(),
});

type FieldErrors = Partial<Record<keyof z.infer<typeof inputSchema>, string>>;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const id = params.id ?? NEW;

  const [warehouses, locations] = await Promise.all([
    listCachedWarehouses(principal),
    listLocations(admin),
  ]);

  const source = id === NEW ? null : await findSupplySource(principal, id);
  if (id !== NEW && !source) throw new Response("Not found", { status: 404 });

  return {
    id,
    isNew: id === NEW,
    source: source
      ? {
          code: source.code,
          name: source.name,
          kind: source.kind,
          shopifyLocationId: source.shopifyLocationId ?? "",
          inventoryWriter: source.inventoryWriter,
          metakockaWarehouse: source.metakockaWarehouse ?? "",
          metakockaProfitCenter: source.metakockaProfitCenter ?? "",
          priority: source.priority,
          leadTimeDays: source.leadTimeDays,
          defaultDeliveryType: source.defaultDeliveryType ?? "",
          canSplit: source.canSplit,
          enabled: source.enabled,
        }
      : null,
    warehouses: warehouses.map((w) => ({
      mark: w.mark,
      name: w.name,
      isActive: w.isActive,
    })),
    locations: locations.map((l) => ({
      id: l.id,
      name: l.name,
      isActive: l.isActive,
      fulfillmentServiceName: l.fulfillmentServiceName,
    })),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const id = params.id ?? NEW;

  const formData = await request.formData();
  const parsed = inputSchema.safeParse({
    code: formData.get("code") ?? "",
    name: formData.get("name") ?? "",
    kind: formData.get("kind") ?? "own",
    shopifyLocationId: formData.get("shopifyLocationId") ?? "",
    inventoryWriter: formData.get("inventoryWriter") ?? "external",
    metakockaWarehouse: formData.get("metakockaWarehouse") ?? "",
    metakockaProfitCenter: formData.get("metakockaProfitCenter") ?? "",
    priority: formData.get("priority") ?? "100",
    leadTimeDays: formData.get("leadTimeDays") ?? "0",
    defaultDeliveryType: formData.get("defaultDeliveryType") ?? "",
    canSplit: formData.get("canSplit") === "on",
    enabled: formData.get("enabled") === "on",
  });

  const fieldErrors: FieldErrors = {};

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as keyof FieldErrors | undefined;
      if (field) fieldErrors[field] ??= issue.message;
    }
    return { ok: false, fieldErrors };
  }

  const data = parsed.data;

  if (await codeIsTaken(principal, data.code, id === NEW ? null : id)) {
    fieldErrors.code = `A supply source with the code "${data.code}" already exists. Codes must be unique because they identify the MetaKocka document.`;
  }

  // CLAUDE.md §3, verified: MetaKocka accepts an unknown warehouse silently and
  // files the document against the company default. The value is therefore
  // checked against the cached list here, not left to MetaKocka.
  const warehouses = await listCachedWarehouses(principal);
  if (
    data.metakockaWarehouse &&
    !warehouses.some((w) => w.mark === data.metakockaWarehouse)
  ) {
    fieldErrors.metakockaWarehouse = `"${data.metakockaWarehouse}" is not in the warehouse list read from MetaKocka. Refresh the list on the supply sources page, or pick a warehouse that exists.`;
  }

  // CLAUDE.md §7: only this app's own warehouses may have their inventory
  // written by this app. A partner location belongs to whoever else writes it.
  if (data.inventoryWriter === "metakocka" && data.kind !== "own") {
    fieldErrors.inventoryWriter =
      "Only an own warehouse can have its stock written by this app. A partner location is written by another app or by hand.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  const saved = await upsertSupplySource(principal, id === NEW ? null : id, {
    code: data.code,
    name: data.name,
    kind: data.kind,
    shopifyLocationId: data.shopifyLocationId || null,
    inventoryWriter: data.inventoryWriter,
    metakockaWarehouse: data.metakockaWarehouse || null,
    metakockaProfitCenter: data.metakockaProfitCenter || null,
    priority: data.priority,
    leadTimeDays: data.leadTimeDays,
    defaultDeliveryType: data.defaultDeliveryType || null,
    canSplit: data.canSplit,
    enabled: data.enabled,
  });

  await appendEvent(principal, {
    entityType: "supply_source",
    entityId: saved.id,
    event: id === NEW ? "supply_source.created" : "supply_source.updated",
    detail: { code: saved.code, warehouse: saved.metakockaWarehouse },
  });

  return redirect("/app/settings/supply-sources");
};

type LoadedSource = ReturnType<typeof useLoaderData<typeof loader>>["source"];

/** The stored values, which are also what Discard restores. */
function toFormValues(source: LoadedSource) {
  return {
    code: source?.code ?? "",
    name: source?.name ?? "",
    kind: source?.kind ?? "own",
    shopifyLocationId: source?.shopifyLocationId ?? "",
    inventoryWriter: source?.inventoryWriter ?? "external",
    metakockaWarehouse: source?.metakockaWarehouse ?? "",
    metakockaProfitCenter: source?.metakockaProfitCenter ?? "",
    priority: String(source?.priority ?? 100),
    leadTimeDays: String(source?.leadTimeDays ?? 0),
    defaultDeliveryType: source?.defaultDeliveryType ?? "",
    canSplit: source?.canSplit ?? true,
    enabled: source?.enabled ?? true,
  };
}

type FormValues = ReturnType<typeof toFormValues>;

export default function EditSupplySource() {
  const { isNew, source, warehouses, locations } =
    useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const errors = result?.fieldErrors;
  const formRef = useRef<HTMLFormElement>(null);

  const initial = toFormValues(source);
  const [values, setValues] = useState<FormValues>(initial);
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;

    // Derived from `source` inside the handler, so the listener can never
    // restore values captured from an earlier render.
    const handleReset = () => setValues(toFormValues(source));

    form.addEventListener("reset", handleReset);
    return () => form.removeEventListener("reset", handleReset);
  }, [source]);

  return (
    <s-page heading={isNew ? "Add supply source" : `Edit ${initial.code}`}>
      <s-link slot="breadcrumb-actions" href="/app/settings/supply-sources">
        Supply sources
      </s-link>

      <s-stack direction="block" gap="large">
        <Form method="post" data-save-bar ref={formRef}>
          <s-stack direction="block" gap="large">
            <s-section heading="Identity">
              <s-box maxInlineSize="520px">
                <s-stack direction="block" gap="base">
                  <s-text-field
                    name="code"
                    label="Code"
                    details="Used in the MetaKocka document reference, for example SH-1001-OWN."
                    value={values.code}
                    onChange={(e) => set("code", e.currentTarget.value)}
                    error={errors?.code}
                  />
                  <s-text-field
                    name="name"
                    label="Name"
                    value={values.name}
                    onChange={(e) => set("name", e.currentTarget.value)}
                    error={errors?.name}
                  />
                  <s-select
                    name="kind"
                    label="Kind"
                    value={values.kind}
                    onChange={(e) =>
                      set("kind", e.currentTarget.value as "own" | "partner")
                    }
                  >
                    <s-option value="own">Own warehouse</s-option>
                    <s-option value="partner">Partner</s-option>
                  </s-select>
                </s-stack>
              </s-box>
            </s-section>

            <s-section heading="MetaKocka">
              <s-box maxInlineSize="520px">
                <s-stack direction="block" gap="base">
                  <s-select
                    name="metakockaWarehouse"
                    label="Warehouse"
                    details="Read from MetaKocka. Refresh the list on the supply sources page if one is missing."
                    value={values.metakockaWarehouse}
                    onChange={(e) =>
                      set("metakockaWarehouse", e.currentTarget.value)
                    }
                    error={errors?.metakockaWarehouse}
                  >
                    <s-option value="">Not set</s-option>
                    {warehouses.map((warehouse) => (
                      <s-option key={warehouse.mark} value={warehouse.mark}>
                        {warehouse.mark} — {warehouse.name}
                        {warehouse.isActive ? "" : " (inactive)"}
                      </s-option>
                    ))}
                  </s-select>
                  <s-text-field
                    name="metakockaProfitCenter"
                    label="Profit center"
                    details="Typed exactly as it appears in MetaKocka. There is no endpoint to list them, so MetaKocka rejects an unknown one when the first order is sent."
                    value={values.metakockaProfitCenter}
                    onChange={(e) =>
                      set("metakockaProfitCenter", e.currentTarget.value)
                    }
                    error={errors?.metakockaProfitCenter}
                  />
                  <s-text-field
                    name="defaultDeliveryType"
                    label="Default delivery type"
                    details="Optional. Applied to the whole document, not to individual lines."
                    value={values.defaultDeliveryType}
                    onChange={(e) =>
                      set("defaultDeliveryType", e.currentTarget.value)
                    }
                  />
                </s-stack>
              </s-box>
            </s-section>

            <s-section heading="Shopify location">
              <s-box maxInlineSize="520px">
                <s-stack direction="block" gap="base">
                  <s-select
                    name="shopifyLocationId"
                    label="Location"
                    value={values.shopifyLocationId}
                    onChange={(e) =>
                      set("shopifyLocationId", e.currentTarget.value)
                    }
                    error={errors?.shopifyLocationId}
                  >
                    <s-option value="">Not set</s-option>
                    {locations.map((location) => (
                      <s-option key={location.id} value={location.id}>
                        {location.name}
                        {location.isActive ? "" : " (inactive)"}
                        {location.fulfillmentServiceName
                          ? ` — ${location.fulfillmentServiceName}`
                          : ""}
                      </s-option>
                    ))}
                  </s-select>
                  <s-select
                    name="inventoryWriter"
                    label="Inventory written by"
                    details="One writer per location. Choose this app only for an own warehouse; a partner location is owned by whatever already writes it."
                    value={values.inventoryWriter}
                    onChange={(e) =>
                      set(
                        "inventoryWriter",
                        e.currentTarget.value as typeof values.inventoryWriter,
                      )
                    }
                    error={errors?.inventoryWriter}
                  >
                    <s-option value="metakocka">
                      This app, from MetaKocka stock
                    </s-option>
                    <s-option value="external">Another app</s-option>
                    <s-option value="manual">A person, by hand</s-option>
                  </s-select>
                </s-stack>
              </s-box>
            </s-section>

            <s-section heading="Allocation">
              <s-box maxInlineSize="520px">
                <s-stack direction="block" gap="base">
                  <s-number-field
                    name="priority"
                    label="Priority"
                    details="Lower runs first when deciding which source fulfils a line."
                    value={values.priority}
                    onChange={(e) => set("priority", e.currentTarget.value)}
                    error={errors?.priority}
                  />
                  <s-number-field
                    name="leadTimeDays"
                    label="Lead time (days)"
                    value={values.leadTimeDays}
                    onChange={(e) => set("leadTimeDays", e.currentTarget.value)}
                    error={errors?.leadTimeDays}
                  />
                  <s-checkbox
                    name="canSplit"
                    label="Allow a single line to be split with another source"
                    checked={values.canSplit}
                    onChange={(e) => set("canSplit", e.currentTarget.checked)}
                  />
                  <s-checkbox
                    name="enabled"
                    label="Enabled"
                    details="A disabled source is never chosen by allocation."
                    checked={values.enabled}
                    onChange={(e) => set("enabled", e.currentTarget.checked)}
                  />
                </s-stack>
              </s-box>
            </s-section>
          </s-stack>
        </Form>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
