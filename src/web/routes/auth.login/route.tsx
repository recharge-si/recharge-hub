import { useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { login } from "~/adapters/shopify/shopify.server";
import { loginErrorMessage } from "./error.server";

/**
 * The only document this app renders outside the Shopify admin. It asks for a
 * shop domain and nothing else: no account creation, no password, no external
 * sign-up wall (CLAUDE.md section 2.2).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  return { errors: loginErrorMessage(await login(request)) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  return { errors: loginErrorMessage(await login(request)) };
};

export default function Login() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [shop, setShop] = useState("");
  const { errors } = actionData ?? loaderData;

  return (
    <s-page heading="Recharge Hub">
      <s-section heading="Log in">
        <Form method="post">
          <s-stack direction="block" gap="base">
            <s-text-field
              name="shop"
              label="Shop domain"
              details="For example: my-store.myshopify.com"
              value={shop}
              onChange={(event) => setShop(event.currentTarget.value)}
              autocomplete="on"
              error={errors.shop}
            />
            <s-button type="submit">Log in</s-button>
          </s-stack>
        </Form>
      </s-section>
    </s-page>
  );
}
