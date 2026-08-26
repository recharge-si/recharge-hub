/**
 * Type declarations for the App Bridge custom elements this app uses.
 *
 * `@shopify/polaris-types` covers the Polaris `s-*` components, but `s-app-nav`
 * comes from App Bridge and is not declared by @shopify/polaris-types 1.0.7 or
 * @shopify/app-bridge-types 0.7.2. The official Shopify template uses the
 * element in JSX without declaring it, which is why its own `typecheck` script
 * cannot see it either.
 *
 * This is a missing declaration, not an invented component: `s-app-nav` is what
 * the Built for Shopify requirements and CLAUDE.md section 2.6 both name.
 * Delete this file once Shopify ships the types.
 */
import type { DetailedHTMLProps, HTMLAttributes } from "react";

type AppBridgeElement = DetailedHTMLProps<
  HTMLAttributes<HTMLElement>,
  HTMLElement
>;

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "s-app-nav": AppBridgeElement;
    }
  }
}

export {};
