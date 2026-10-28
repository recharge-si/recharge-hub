import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { rigApi } from "~/adapters/rig/runtime.server";

/**
 * POST /apps/rig/verify on the storefront (docs/rig-builder.md § Contract):
 * the engine's own checks for a set of variant ids, so the page can swap a
 * part and learn at once whether the rig still fits. Same check function as
 * `build`; no model.
 */
export const action = ({ request }: ActionFunctionArgs) =>
  rigApi().verify(request);

/** A GET reaches the same handler, which refuses it with 405. */
export const loader = ({ request }: LoaderFunctionArgs) =>
  rigApi().verify(request);
