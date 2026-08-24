import { useEffect } from "react";
import { useNavigate } from "react-router";

/**
 * App Bridge turns clicks on `s-link` into a `shopify:navigate` event rather than
 * a document load. Without this listener every in-app link would full-page reload.
 *
 * The library ships this inside its own `AppProvider`, which also injects the App
 * Bridge script into the route body. CLAUDE.md section 2.2 requires that script in
 * `<head>` of every document, so the script lives in root.tsx and this component
 * carries the only other thing AppProvider did.
 */
export function AppBridgeNavigation() {
  const navigate = useNavigate();

  useEffect(() => {
    const handleNavigate = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const href = target.getAttribute("href");
      if (href) navigate(href);
    };

    document.addEventListener("shopify:navigate", handleNavigate);
    return () => document.removeEventListener("shopify:navigate", handleNavigate);
  }, [navigate]);

  return null;
}
