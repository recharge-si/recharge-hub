import type { CampaignStatus } from "~/domain/sales/types";

/**
 * The lifecycle actions in the page header, for the status the campaign is
 * in (docs/sale-campaigns.md § Campaign state machine).
 *
 * Rendered into `s-page`'s action slots, which is why this is a fragment of
 * slotted buttons rather than a card: the header is Polaris's, and the one
 * primary button in it is the way forward from here — activate, schedule,
 * resume, or end. A draft that has been given a start date and saved is
 * offered Schedule first, because that is what the date was for; Activate
 * now stays a click away.
 */
export interface CampaignHeaderActionsProps {
  status: CampaignStatus;
  busy: boolean;
  /** The form has unsaved changes; activation uses what is saved. */
  dirty: boolean;
  /** The saved preview shows something to change. */
  canActivate: boolean;
  /** A saved draft with a start date, ready to be scheduled. */
  scheduleReady: boolean;
  failed: number;
  /** The campaign holds no price and can be deleted outright. */
  deletable: boolean;
  variantsHref: string;
  confirmModalId: string;
  helpModalId: string;
  /**
   * The dialogs the hard-to-undo actions open instead of running outright:
   * ending, pausing, cancelling and deleting all go through one. The page
   * renders the dialogs; the buttons here only open them.
   */
  confirmIds: { end: string; pause: string; cancel: string; delete: string };
  onIntent: (intent: string) => void;
}

export function CampaignHeaderActions({
  status,
  busy,
  dirty,
  canActivate,
  scheduleReady,
  failed,
  deletable,
  variantsHref,
  confirmModalId,
  helpModalId,
  confirmIds,
  onIntent,
}: CampaignHeaderActionsProps) {
  const off = busy ? { disabled: true } : {};
  const activateOff = busy || dirty || !canActivate ? { disabled: true } : {};
  const activateLabel =
    status === "paused"
      ? "Resume"
      : status === "scheduled" || scheduleReady
        ? "Activate now"
        : "Activate campaign";

  return (
    <>
      {status === "draft" && scheduleReady ? (
        <s-button
          slot="primary-action"
          variant="primary"
          type="button"
          onClick={() => onIntent("schedule")}
          {...off}
        >
          Schedule campaign
        </s-button>
      ) : null}
      {(status === "draft" && !scheduleReady) ||
      status === "scheduled" ||
      status === "paused" ? (
        <s-button
          slot="primary-action"
          variant="primary"
          command="--show"
          commandFor={confirmModalId}
          {...activateOff}
        >
          {activateLabel}
        </s-button>
      ) : null}
      {status === "active" ? (
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          command="--show"
          commandFor={confirmIds.end}
          {...off}
        >
          End now
        </s-button>
      ) : null}

      {status === "draft" && scheduleReady ? (
        <s-button
          slot="secondary-actions"
          command="--show"
          commandFor={confirmModalId}
          {...activateOff}
        >
          Activate now
        </s-button>
      ) : null}
      {status === "scheduled" ? (
        <s-button
          slot="secondary-actions"
          type="button"
          onClick={() => onIntent("unschedule")}
          {...off}
        >
          Back to draft
        </s-button>
      ) : null}
      {status === "active" ? (
        <s-button
          slot="secondary-actions"
          command="--show"
          commandFor={confirmIds.pause}
          {...off}
        >
          Pause
        </s-button>
      ) : null}
      {status === "paused" ? (
        <s-button
          slot="secondary-actions"
          command="--show"
          commandFor={confirmIds.end}
          {...off}
        >
          End
        </s-button>
      ) : null}
      {failed > 0 ? (
        <s-button
          slot="secondary-actions"
          type="button"
          onClick={() => onIntent("retry")}
          {...off}
        >
          {`Retry ${failed} failed`}
        </s-button>
      ) : null}
      {status === "draft" || status === "scheduled" || status === "paused" ? (
        <s-button
          slot="secondary-actions"
          tone="critical"
          command="--show"
          commandFor={
            status === "draft" && deletable
              ? confirmIds.delete
              : confirmIds.cancel
          }
          {...off}
        >
          {status === "draft" ? "Delete" : "Cancel campaign"}
        </s-button>
      ) : null}
      {/* A finished campaign with every price back is history nobody needs on the list. */}
      {(status === "completed" || status === "cancelled") && deletable ? (
        <s-button
          slot="secondary-actions"
          tone="critical"
          command="--show"
          commandFor={confirmIds.delete}
          {...off}
        >
          Delete
        </s-button>
      ) : null}
      <s-button slot="secondary-actions" href={variantsHref}>
        Variants
      </s-button>
      <s-button
        slot="secondary-actions"
        icon="question-circle"
        command="--show"
        commandFor={helpModalId}
      >
        Help
      </s-button>
    </>
  );
}
