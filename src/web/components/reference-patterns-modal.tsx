import { useRef } from "react";

import {
  ORDER_REFERENCE_PATTERNS,
  orderReferenceFor,
  type OrderReferenceContext,
} from "~/domain/orders/reference";

/**
 * Ready-made order references, each rendered against one of the merchant's own
 * orders.
 *
 * The sibling of the product name patterns, and the same shape: rows rather
 * than filled boxes, because they are a list to pick from; a tick on the one in
 * use, the way `dropdown.tsx` marks a chosen option; and no invented example
 * anywhere — a shop with no orders yet reads the labels alone
 * (docs/ui-conventions.md).
 *
 * Shared by the settings page and guided setup, so the same four references are
 * offered in the same order wherever the pattern is edited.
 */
export interface ReferencePatternsModalProps {
  id: string;
  /** The pattern as the form currently holds it; "" means the default. */
  current: string;
  /** The default, so the row producing it can be ticked while the form is empty. */
  defaultPattern: string;
  /** One of the merchant's own orders, or null when there are none. */
  sample: OrderReferenceContext | null;
  onChoose: (pattern: string) => void;
}

export function ReferencePatternsModal({
  id,
  current,
  defaultPattern,
  sample,
  onChoose,
}: ReferencePatternsModalProps) {
  /** Overlay methods land on the element only once the browser upgrades it. */
  const overlay = useRef<{ hideOverlay?: () => void } | null>(null);

  return (
    <s-modal
      id={id}
      heading="Ready references"
      ref={(element) => {
        overlay.current = (element as { hideOverlay?: () => void }) ?? null;
      }}
    >
      <s-stack direction="block" gap="none">
        {ORDER_REFERENCE_PATTERNS.map((option, index) => {
          const inUse =
            option.pattern === current ||
            (option.pattern === defaultPattern && current.trim() === "");
          const produced = sample
            ? orderReferenceFor(option.pattern, sample).reference
            : null;

          return (
            <s-stack key={option.id} direction="block" gap="none">
              {index === 0 ? null : <s-divider />}
              <s-clickable
                inlineSize="100%"
                borderRadius="base"
                paddingInline="small-200"
                paddingBlock="small-300"
                accessibilityLabel={
                  produced
                    ? `${option.label}. Would produce ${produced}.`
                    : option.label
                }
                onClick={() => {
                  onChoose(option.pattern);
                  overlay.current?.hideOverlay?.();
                }}
              >
                <s-grid
                  gridTemplateColumns="1fr auto"
                  gap="small-200"
                  alignItems="center"
                >
                  <s-stack direction="block" gap="small-500">
                    <s-text type="strong">{option.label}</s-text>
                    {produced ? (
                      <s-text color="subdued">{produced}</s-text>
                    ) : null}
                  </s-stack>
                  {inUse ? <s-icon type="check" /> : <s-box inlineSize="20px" />}
                </s-grid>
              </s-clickable>
            </s-stack>
          );
        })}
      </s-stack>
      {/*
       * `type="button"` because guided setup renders this inside a real
       * `<Form>`: a button with no type in a form is a submit button, and
       * closing a modal is not submitting a setup step.
       */}
      <s-button
        type="button"
        slot="primary-action"
        variant="primary"
        command="--hide"
        commandFor={id}
      >
        Close
      </s-button>
    </s-modal>
  );
}
