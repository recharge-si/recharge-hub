import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import {
  getTypeMenu,
  startTypeMenu,
  updateTypeMenu,
} from "~/adapters/db/repositories/type-menu.server";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES, typeMenuKey } from "~/adapters/queue/queues";
import { authenticate } from "~/adapters/shopify/shopify.server";
import {
  MENU_DEPTH,
  MENU_TYPE_FIELD,
  TYPE_MENU_HANDLE,
  TYPE_MENU_TITLE,
  menuTree,
  menuTypeIds,
  type MenuNode,
} from "~/domain/attributes/menu";
import { ProductSetupNav } from "~/web/components/product-setup-nav";
import { LearnMore } from "~/web/components/learn-more";
import { PRODUCT_SETUP_ROUTES, countOf } from "~/web/lib/attributes";
import { formatDateTime } from "~/web/lib/datetime";
import { useLiveRevalidation } from "~/web/lib/live";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";

/**
 * The store menu (docs/attributes.md § Store menu): the product type tree
 * as a Shopify navigation menu, each entry an automated collection of the
 * products of that type and the types beneath it. One button makes it, or
 * brings it up to date; the work happens in a job and this page follows it.
 */

const PHASE_LABEL: Record<string, string> = {
  products: "Writing each product's type",
  collections: "Making a collection per type",
  menu: "Making the menu",
};

const numericId = (gid: string) => gid.split("/").pop() ?? "";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const { schema } = await getAttributeSchema(principal);
  const state = await getTypeMenu(principal);
  const tree = menuTree(schema);
  const collectionOf = (typeId: string) =>
    state?.collections[typeId]?.collectionId ?? null;

  type PreviewNode = {
    typeId: string;
    title: string;
    collectionId: string | null;
    children: PreviewNode[];
  };
  const preview = (nodes: readonly MenuNode[]): PreviewNode[] =>
    nodes.map((node) => ({
      typeId: node.typeId,
      title: node.title,
      collectionId: collectionOf(node.typeId),
      children: preview(node.children),
    }));

  return {
    types: schema.types.length,
    inMenu: menuTypeIds(tree).length,
    tree: preview(tree),
    state: state
      ? {
          status: state.status,
          phase: state.phase,
          total: state.total,
          done: state.done,
          lastError: state.lastError,
          finishedAt: state.finishedAt?.toISOString() ?? null,
          menuId: state.menuId,
          collections: Object.keys(state.collections).length,
        }
      : null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const actor = actorFromSession(session);
  const { schema } = await getAttributeSchema(principal);
  if (schema.types.length === 0)
    return {
      ok: false as const,
      message: "There are no product types yet. Add some, then make the menu.",
    };
  const { started } = await startTypeMenu(principal, actor);
  if (!started)
    return {
      ok: false as const,
      message: "The menu is being made already. This page shows how far it is.",
    };
  try {
    await enqueue(
      QUEUES.typeMenuSync,
      { shopDomain: session.shop, requestedBy: actor },
      { singletonKey: typeMenuKey(session.shop) },
    );
  } catch (error) {
    // Marked running a moment ago: without the job it would stay so.
    await updateTypeMenu(principal, {
      status: "failed",
      lastError: "The menu could not be started. Try again in a moment.",
      finishedAt: new Date(),
    });
    throw error;
  }
  return { ok: true as const, message: "Making the menu" };
};

type Tree = ReturnType<typeof useLoaderData<typeof loader>>["tree"];

type TreeNode = Tree[number];

const INDENT_PX = 28;

/** How many entries sit beneath a node, at every level. */
const entriesBelow = (node: TreeNode): number =>
  node.children.reduce((sum, child) => sum + 1 + entriesBelow(child), 0);

const withChildren = (nodes: Tree): string[] =>
  nodes.flatMap((node) =>
    node.children.length > 0
      ? [node.typeId, ...withChildren(node.children)]
      : [],
  );

/**
 * The menu as it will read, folded to its top level so a large tree stays
 * one screen; a chevron opens a branch, as on the product type tree.
 */
function MenuPreview({
  nodes,
  open,
  toggle,
}: {
  nodes: Tree;
  open: ReadonlySet<string>;
  toggle: (typeId: string) => void;
}) {
  const rows: Array<{ node: TreeNode; depth: number }> = [];
  const walk = (list: Tree, depth: number) => {
    for (const node of list) {
      rows.push({ node, depth });
      if (open.has(node.typeId)) walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);

  return (
    <s-stack direction="block" gap="none">
      <style>{`
        .sm-row { display: flex; align-items: center; min-height: 32px; }
        .sm-guide { flex: 0 0 ${INDENT_PX - 12}px; align-self: stretch; margin-left: 12px; border-left: 1px solid #e3e3e3; }
        .sm-twisty { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 28px; margin-inline-end: 4px; padding: 0; border: 0; background: transparent; border-radius: 6px; cursor: pointer; }
        button.sm-twisty:hover { background: #ebebeb; }
        .sm-leaf { display: inline-block; width: 26px; }
        .sm-body { flex: 1; min-width: 0; }
      `}</style>
      {rows.map(({ node, depth }) => {
        const parent = node.children.length > 0;
        const isOpen = open.has(node.typeId);
        return (
          <div key={node.typeId} className="sm-row">
            {Array.from({ length: depth }, (_, i) => (
              <span key={i} className="sm-guide" aria-hidden="true" />
            ))}
            {parent ? (
              <button
                type="button"
                className="sm-twisty"
                aria-label={`${isOpen ? "Collapse" : "Expand"} ${node.title}`}
                aria-expanded={isOpen}
                onClick={() => toggle(node.typeId)}
              >
                <s-icon
                  type={isOpen ? "chevron-down" : "chevron-right"}
                  color="subdued"
                />
              </button>
            ) : (
              <span className="sm-leaf" aria-hidden="true" />
            )}
            <div className="sm-body">
              <s-grid
                gridTemplateColumns="1fr auto"
                gap="small-300"
                alignItems="center"
              >
                <s-text {...(parent ? { type: "strong" as const } : {})}>
                  {node.title}
                </s-text>
                <s-stack direction="inline" gap="small-300" alignItems="center">
                  {parent ? (
                    <s-text color="subdued">
                      {countOf(entriesBelow(node), "entry", "entries")}
                    </s-text>
                  ) : null}
                  {node.collectionId ? (
                    <s-link
                      href={`shopify://admin/collections/${numericId(node.collectionId)}`}
                      accessibilityLabel={`Open the ${node.title} collection in Shopify`}
                    >
                      Collection
                    </s-link>
                  ) : null}
                </s-stack>
              </s-grid>
            </div>
          </div>
        );
      })}
    </s-stack>
  );
}

export default function StoreMenu() {
  const { types, inMenu, tree, state } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const running = state?.status === "running";
  const busy = fetcher.state !== "idle" || running;
  const result = fetcher.data;
  const made = Boolean(state?.menuId);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (typeId: string) =>
    setOpen((now) => {
      const next = new Set(now);
      if (next.has(typeId)) next.delete(typeId);
      else next.add(typeId);
      return next;
    });
  const expandable = withChildren(tree);

  useLiveRevalidation({ active: running, idleEveryMs: null });

  useEffect(() => {
    if (result?.ok && typeof shopify !== "undefined")
      shopify.toast.show(result.message);
  }, [result]);

  const folded = types - inMenu;

  return (
    <s-page heading="Product setup" inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => fetcher.submit({}, { method: "post" })}
        {...(busy || types === 0 ? { disabled: true } : {})}
        {...(running ? { loading: true } : {})}
      >
        {made ? "Update menu" : "Make menu"}
      </s-button>

      <s-stack direction="block" gap="base">
        <ProductSetupNav current="menu" />

        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        {state?.status === "running" ? (
          <s-banner tone="info" heading="Making the menu">
            <s-paragraph>
              {`${PHASE_LABEL[state.phase ?? ""] ?? "Working"}${
                state.total > 0
                  ? ` · ${state.done.toLocaleString("en")} of ${state.total.toLocaleString("en")}`
                  : ""
              }. You can leave this page; it carries on.`}
            </s-paragraph>
          </s-banner>
        ) : state?.status === "failed" ? (
          <s-banner tone="critical" heading="The menu was not finished">
            <s-paragraph>
              {state.lastError ?? "Something went wrong."}
            </s-paragraph>
          </s-banner>
        ) : state?.status === "done" ? (
          <s-banner
            tone={state.lastError ? "warning" : "success"}
            heading={`Menu ready${state.finishedAt ? ` · ${formatDateTime(state.finishedAt)}` : ""}`}
          >
            <s-paragraph>
              {state.lastError ??
                `“${TYPE_MENU_TITLE}” links ${countOf(state.collections, "collection")}. Add it to your theme's header in Online Store › Themes › Customize.`}
            </s-paragraph>
            {state.menuId ? (
              <s-link
                slot="secondary-actions"
                href={`shopify://admin/menus/${numericId(state.menuId)}`}
              >
                Open the menu in Shopify
              </s-link>
            ) : null}
          </s-banner>
        ) : null}

        <s-section heading="Store menu from product types">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              {`One press turns the product type tree into a menu called “${TYPE_MENU_TITLE}” for your store's header. Each entry opens a collection of the products of that type and every type beneath it; the collections fill themselves as products change type. Once made, the menu keeps itself current: a minute after the tree or a product's type changes, it updates on its own.`}
            </s-text>
            {types === 0 ? (
              <s-text color="subdued">
                There are no product types yet.{" "}
                <s-link href={PRODUCT_SETUP_ROUTES.types}>Add some</s-link>{" "}
                first.
              </s-text>
            ) : (
              <s-stack direction="block" gap="small-300">
                <s-grid
                  gridTemplateColumns="1fr auto"
                  gap="small-300"
                  alignItems="center"
                >
                  <s-heading>
                    {`The menu · ${countOf(inMenu, "entry", "entries")}`}
                  </s-heading>
                  {expandable.length > 0 ? (
                    <s-stack direction="inline" gap="small-300">
                      <s-button
                        onClick={() => setOpen(new Set(expandable))}
                        {...(open.size === expandable.length
                          ? { disabled: true }
                          : {})}
                      >
                        Expand all
                      </s-button>
                      <s-button
                        onClick={() => setOpen(new Set())}
                        {...(open.size === 0 ? { disabled: true } : {})}
                      >
                        Collapse all
                      </s-button>
                    </s-stack>
                  ) : null}
                </s-grid>
                <MenuPreview nodes={tree} open={open} toggle={toggle} />
                {folded > 0 ? (
                  <s-text color="subdued">
                    {`Menus go ${MENU_DEPTH} levels deep, so ${countOf(folded, "deeper type")} ${folded === 1 ? "is" : "are"} not entries of their own; their products are in the collection of the level above, and each still gets a collection.`}
                  </s-text>
                ) : null}
              </s-stack>
            )}
            <LearnMore label="What making the menu changes in Shopify">
              <s-paragraph>
                {`Each product gets its type and every type above it in the hidden field ${MENU_TYPE_FIELD.namespace}.${MENU_TYPE_FIELD.key}, like tags a shopper never sees; a collection takes every product whose field names its type, so a parent's collection holds its whole branch. The type is the one chosen on the product's Attributes tab, or the one matched by its category or Shopify product type. A product two types claim keeps what it had.`}
              </s-paragraph>
              <s-paragraph>
                Each product type gets an automated collection, published to the
                online store. Its name follows the type; its description, image
                and address are yours to change.
              </s-paragraph>
              <s-paragraph>
                {`The menu (handle “${TYPE_MENU_HANDLE}”) is replaced as a whole each time, so edit the tree here rather than the menu in Shopify. Collections of types you delete stay in Shopify until you remove them.`}
              </s-paragraph>
              <s-paragraph>
                The first time, Shopify asks you to approve managing menus and
                publishing collections. After that the menu updates itself when
                the tree or a product&apos;s type changes; the button is there to
                update it now.
              </s-paragraph>
            </LearnMore>
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
