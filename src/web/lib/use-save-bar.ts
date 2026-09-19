import { useEffect, useRef } from "react";

/**
 * Drives the contextual save bar from the page's own idea of dirty
 * (docs/BUILD_SPEC.md §2.6).
 *
 * `data-save-bar` listens for change events on a form's fields, and every
 * value on these screens lives in state React writes into web components —
 * which fires nothing a listener can hear. The bar simply never appears. So
 * the page compares its state to what the loader returned and shows or hides
 * the bar itself, the way the payment types page does. Leaving the page with
 * the bar still up would leave it up over the next one, so it is hidden on
 * unmount as well.
 */
export function useSaveBar(id: string, dirty: boolean): void {
  useEffect(() => {
    if (typeof shopify === "undefined") return;
    if (dirty) void shopify.saveBar.show(id);
    else void shopify.saveBar.hide(id);
  }, [id, dirty]);

  useEffect(
    () => () => {
      if (typeof shopify !== "undefined") void shopify.saveBar.hide(id);
    },
    [id],
  );
}

/**
 * Resets local state to what the loader returned, but only when the stored
 * values actually changed.
 *
 * The loader returns a fresh object every time it runs, and it runs after
 * every save, attempted or not. Keyed on identity that would throw away the
 * merchant's edits each time; keyed on the serialised value it only does so
 * when the database really moved.
 */
export function useResetWhenSaved(savedKey: string, reset: () => void): void {
  const applied = useRef(savedKey);
  useEffect(() => {
    if (applied.current === savedKey) return;
    applied.current = savedKey;
    reset();
  }, [savedKey, reset]);
}
