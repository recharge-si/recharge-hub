import { redirect, type LoaderFunctionArgs } from "react-router";

/**
 * Payment types moved under Orders -> Settings, beside the order behaviour they
 * belong to (the product UX brief, section 13). Redirected rather than removed:
 * this page is linked from exception guidance a merchant may have open.
 */
export const loader = ({ request }: LoaderFunctionArgs) => {
  const search = new URL(request.url).search;
  throw redirect(`/app/orders/settings/payments${search}`);
};
