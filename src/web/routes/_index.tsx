import { redirect, type LoaderFunctionArgs } from "react-router";

import { appEntryFor } from "~/web/lib/app-entry";

/**
 * The app has one entry point per context: the embedded admin for merchants who
 * have installed it, and the login form for everyone else. Nothing renders here.
 *
 * Which context a request is in is decided by `appEntryFor`, not by the `shop`
 * parameter alone — the admin's own navigation reaches this route without one.
 */
export const loader = ({ request }: LoaderFunctionArgs) => {
  throw redirect(appEntryFor(request).to);
};
