import { useState } from "react";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { login } from "~/adapters/shopify/shopify.server";
import { isEmbeddedRequest } from "~/web/lib/app-entry";
import { loginErrorMessage } from "./error.server";

/**
 * The only document this app renders outside the Shopify admin. It asks for a
 * shop domain and nothing else: no account creation, no password, no external
 * sign-up wall (CLAUDE.md section 2.2).
 *
 * A merchant who is already inside the admin never belongs here. A request
 * that carries the admin's own markers — App Bridge's session token header,
 * or `host`, `embedded` or `id_token` in the query — is an installed app being
 * opened, and it goes to `/app` where the embedded session is restored. The
 * form is only for a person arriving from outside the admin with nothing to
 * say who they are. `shop` alone is not such a marker: it is what this form
 * collects, and `login()` reads it from the query as well as from the body.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (isEmbeddedRequest(request)) {
    const { search } = new URL(request.url);
    throw redirect(search ? `/app${search}` : "/app");
  }

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
