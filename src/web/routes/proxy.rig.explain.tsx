import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { rigApi } from "~/adapters/rig/runtime.server";

/**
 * POST /apps/rig/explain on the storefront (docs/rig-builder.md § Contract).
 * The only route that waits on a model: it reads free text into a profile and
 * writes the reason for each part, and falls back to template sentences when
 * the pool is exhausted, slow, busy or over its daily budget.
 */
export const action = ({ request }: ActionFunctionArgs) =>
  rigApi().explain(request);

/** A GET reaches the same handler, which refuses it with 405. */
export const loader = ({ request }: LoaderFunctionArgs) =>
  rigApi().explain(request);
