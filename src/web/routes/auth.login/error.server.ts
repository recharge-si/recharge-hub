import {
  LoginErrorType,
  type LoginError,
} from "@shopify/shopify-app-react-router/server";

/**
 * CLAUDE.md section 2.8: error text says what is wrong and how to fix it.
 */
export function loginErrorMessage(loginErrors: LoginError): { shop?: string } {
  if (loginErrors?.shop === LoginErrorType.MissingShop) {
    return {
      shop: "Enter your shop domain, for example my-store.myshopify.com.",
    };
  }

  if (loginErrors?.shop === LoginErrorType.InvalidShop) {
    return {
      shop: "That shop domain is not valid. It should look like my-store.myshopify.com.",
    };
  }

  return {};
}
