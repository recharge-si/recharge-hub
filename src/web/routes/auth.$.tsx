import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";

import { authenticate } from "~/adapters/shopify/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
