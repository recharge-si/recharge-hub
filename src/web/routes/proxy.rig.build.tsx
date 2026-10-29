import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { rigApi } from "~/adapters/rig/runtime.server";

/**
 * POST /apps/rig/build on the storefront, which Shopify's App Proxy forwards
 * here as /proxy/rig/build (docs/rig-builder.md § Contract). A resource
 * route: no page, no session, no CORS; the proxy signature is checked inside
 * the handler before anything else runs. `build` never calls a model.
 */
export const action = ({ request }: ActionFunctionArgs) =>
  rigApi().build(request);

/** A GET reaches the same handler, which refuses it with 405. */
export const loader = ({ request }: LoaderFunctionArgs) =>
  rigApi().build(request);
