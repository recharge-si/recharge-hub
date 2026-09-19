import type { ReactNode } from "react";

/**
 * A yes-or-no before something that is hard to take back.
 *
 * The trigger stays with the caller as an ordinary button carrying
 * `command="--show"` and `commandFor={id}`; this is only the dialog it opens.
 * The primary button both hides the dialog and runs the action, so a double
 * click cannot run it twice and a cancelled dialog runs nothing.
 */
export function ConfirmModal({
  id,
  heading,
  confirmLabel,
  onConfirm,
  tone = "critical",
  children,
}: {
  id: string;
  heading: string;
  confirmLabel: string;
  onConfirm: () => void;
  tone?: "critical" | "neutral";
  children: ReactNode;
}) {
  return (
    <s-modal id={id} heading={heading}>
      <s-stack direction="block" gap="base">
        {children}
      </s-stack>
      <s-button
        slot="primary-action"
        variant="primary"
        {...(tone === "critical" ? { tone: "critical" as const } : {})}
        command="--hide"
        commandFor={id}
        onClick={onConfirm}
      >
        {confirmLabel}
      </s-button>
      <s-button slot="secondary-actions" command="--hide" commandFor={id}>
        Keep it
      </s-button>
    </s-modal>
  );
}
