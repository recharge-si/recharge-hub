import { useId, useState, type ReactNode } from "react";

/**
 * A single-choice picker whose open list floats above the page, drawn by
 * Polaris.
 *
 * `s-select` is the obvious component and the wrong one here: it is a native
 * `<select>`, so its open list belongs to the operating system, and a white
 * listbox with a system-blue highlight lands on top of the admin looking like
 * nothing else on the page. Polaris has no combobox, so the control is
 * assembled from the pieces Polaris does give us — `s-clickable` for the field
 * and the rows, `s-popover` for the floating list — with no styling of our own,
 * which keeps it inside CLAUDE.md section 2.6.
 *
 * The field is a grid rather than a button so its label sits hard against the
 * leading edge with the chevron at the trailing edge, the way every other field
 * in a Polaris form reads. A button would centre the label.
 *
 * `commandFor` is what opens the list, and it is not optional: it is also what
 * the popover anchors itself to. Driving the element directly instead leaves it
 * with nothing to position against and nothing appears.
 *
 * Note for whoever hosts this next to a dialog: the popover's overlay events
 * bubble. A dialog that listens for `afterhide` will hear this list closing and
 * read it as itself closing, so hosts must either not listen or check the event
 * target.
 *
 * `s-clickable` is not form-associated, so the value travels in a hidden input
 * and submits exactly as a select would.
 *
 * A host that shows a contextual save bar cannot rely on `data-save-bar` to
 * notice this field: that watches for change events, and a value React writes
 * onto a DOM property fires none. Compare state to what was loaded and drive
 * the bar with `shopify.saveBar` instead, the way the payment types page does.
 */
export interface DropdownOption {
  value: string;
  label: string;
  /** Drawn before the label, in the field and in the list: a flag, an icon. */
  icon?: ReactNode;
}

export function Dropdown({
  name,
  label,
  details,
  error,
  hideLabel,
  placeholder = "Choose",
  value,
  options,
  onChange,
  disabled,
}: {
  name: string;
  label: string;
  details?: string;
  /**
   * Persistent, actionable, and rendered against the field it concerns
   * (CLAUDE.md section 2.8). Never a toast, and never shown before the merchant
   * has had a chance to answer.
   */
  error?: string;
  /**
   * Drops the visible label while keeping it for screen readers. For a table
   * where the column heading already names every field in the column and a
   * label on each row would repeat it once per row.
   */
  hideLabel?: boolean;
  placeholder?: string;
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  // An id attribute cannot hold the colons React puts in a generated id.
  const listId = `dropdown-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);

  return (
    <s-stack direction="block" gap="small-400">
      {hideLabel ? null : <s-text type="strong">{label}</s-text>}

      <input type="hidden" name={name} value={value} />

      <s-clickable
        commandFor={listId}
        border="base"
        borderRadius="base"
        background="base"
        paddingInline="small-200"
        paddingBlock="small-300"
        inlineSize="100%"
        accessibilityLabel={`${label}: ${selected?.label ?? placeholder}`}
        {...(disabled ? { disabled: true } : {})}
      >
        <s-grid
          gridTemplateColumns="1fr auto"
          gap="small-200"
          alignItems="center"
        >
          <s-stack direction="inline" gap="small-200" alignItems="center">
            {selected?.icon}
            <s-text color={selected ? "base" : "subdued"}>
              {selected?.label ?? placeholder}
            </s-text>
          </s-stack>
          <s-icon type={open ? "chevron-up" : "chevron-down"} />
        </s-grid>
      </s-clickable>

      {/*
       * Capped so a long register — MetaKocka ships about eighty units — scrolls
       * inside the list instead of running off the bottom of the screen.
       */}
      <s-popover
        id={listId}
        maxBlockSize="320px"
        onShow={() => setOpen(true)}
        onAfterHide={() => setOpen(false)}
      >
        <s-stack direction="block" gap="none">
          {options.map((option) => (
            <s-clickable
              key={option.value || "none"}
              command="--hide"
              commandFor={listId}
              borderRadius="base"
              paddingInline="small-200"
              paddingBlock="small-300"
              inlineSize="100%"
              onClick={() => onChange(option.value)}
            >
              {/*
               * The tick trails the label rather than leading it, so every
               * option starts on the same left edge as the value in the field
               * above. A leading tick column indents the labels past it.
               */}
              <s-grid
                gridTemplateColumns="1fr auto"
                gap="small-200"
                alignItems="center"
              >
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  {option.icon}
                  <s-text>{option.label}</s-text>
                </s-stack>
                {option.value === value ? (
                  <s-icon type="check" />
                ) : (
                  <s-box inlineSize="20px" />
                )}
              </s-grid>
            </s-clickable>
          ))}
        </s-stack>
      </s-popover>

      {details ? <s-text color="subdued">{details}</s-text> : null}
      {error ? <s-text tone="critical">{error}</s-text> : null}
    </s-stack>
  );
}
