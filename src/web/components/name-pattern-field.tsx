import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  applyPick,
  canAddField,
  flattenGroups,
  parseTemplate,
  patternParts,
  pickerGroups,
  pickerQueryAt,
  removeFieldAt,
  type FieldDef,
  type PickerRow,
  type VariantFacts,
} from "~/domain/products/template";

/**
 * The name-pattern field: what is typed, what it is made of, and what can be
 * added to it.
 *
 * Three parts, in that order.
 *
 *  - The field itself is `s-text-field`, unstyled. It holds the pattern, which
 *    is the stored value, and anything typable stays typable.
 *  - Under it, the pattern read back as chips: "Product title", "All option
 *    values", each showing what it comes to for one of the merchant's own
 *    products. `{title}[ {options}]` tells nobody anything; this does. A chip
 *    can be pressed to take that field out, and the punctuation left holding
 *    nothing goes with it.
 *  - A list of fields in a floating popover, opened by typing `{` or by
 *    pressing Add a field, filtered as they type. It floats rather than
 *    sitting in the flow, so opening it does not push the rest of the card
 *    down, and it is capped and scrolls — the same shape as the admin's own
 *    filter combobox, and the same construction `dropdown.tsx` uses.
 *
 * **Why the chips are under the field and not inside it.** Chips inline with
 * typed text needs `contenteditable`: Polaris's typed surface has no combobox,
 * no `keydown` on a text field and no listbox role, so the input itself would
 * have to be ours. That control owns its caret, undo stack, paste handling and
 * IME composition, and gets them wrong differently on iOS. Both halves of what
 * chips are for — seeing the structure, and seeing what each piece comes to —
 * are available without it, so they are available now.
 *
 * Every control here is a Polaris primitive and is in the tab order, so
 * keyboard operation is theirs rather than something reimplemented.
 *
 * **One known limitation, deliberately not worked around.** The caret comes
 * from `selectionStart` when the component exposes it, and falls back to the
 * end of the value when it does not. Reaching into the component's shadow root
 * would work today and break on a Polaris release.
 */

/** The popover anchors to whatever declared `commandFor` and shows on demand. */
type Overlay = { showOverlay: () => void; hideOverlay: () => void };

export interface NamePatternFieldProps {
  name: string;
  label: string;
  details?: string;
  value: string;
  onChange: (value: string) => void;
  /** Fields this shop can use, metafield definitions included. */
  registry: FieldDef[];
  /**
   * The product the chips and the list resolve against — one of the merchant's
   * own. Null when the catalogue is empty, and then nothing shows a value
   * rather than showing an invented one.
   */
  sample: VariantFacts | null;
  /** Persistent, actionable, rendered against the field (CLAUDE.md 2.8). */
  error?: string;
}

function caretIn(target: unknown, value: string): number {
  const candidate = target as { selectionStart?: number | null } | null;
  const at = candidate?.selectionStart;
  return typeof at === "number" ? at : value.length;
}

export function NamePatternField({
  name,
  label,
  details,
  value,
  onChange,
  registry,
  sample,
  error,
}: NamePatternFieldProps) {
  // An id attribute cannot hold the colons React puts in a generated id.
  const listId = `fields-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const list = useRef<Overlay | null>(null);

  const [caret, setCaret] = useState(value.length);
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const query = pickerQueryAt(value, caret);

  /*
   * A new `{` opens the list; carrying on typing inside the same one only
   * filters it. Keyed on where the brace is, so closing the list and typing
   * on does not fight the merchant by reopening it.
   */
  const brace = query?.start ?? null;
  useEffect(() => {
    if (brace !== null) list.current?.showOverlay();
  }, [brace]);

  const groups = useMemo(
    () => pickerGroups(registry, query?.query ?? "", sample),
    [query, registry, sample],
  );
  const rows = useMemo(() => flattenGroups(groups), [groups]);
  const full = !canAddField(parseTemplate(value).nodes);

  const parts = useMemo(
    () => patternParts(value, registry, sample),
    [value, registry, sample],
  );

  const insert = (row: PickerRow) => {
    const next = applyPick(value, caret, row.field.id);
    onChange(next.source);
    setCaret(next.caret);
    setAnnouncement(
      `${row.field.label} added. The name is now ${next.source}.`,
    );
  };

  const remove = (start: number, partLabel: string) => {
    const next = removeFieldAt(value, start);
    onChange(next);
    setCaret(next.length);
    setAnnouncement(`${partLabel} removed. The name is now ${next}.`);
  };

  return (
    <s-stack direction="block" gap="small-300">
      <s-text-field
        name={name}
        label={label}
        {...(details ? { details } : {})}
        value={value}
        autocomplete="off"
        onInput={(event) => {
          const next = event.currentTarget.value;
          setCaret(caretIn(event.currentTarget, next));
          onChange(next);
        }}
        {...(error ? { error } : {})}
      />

      {/*
       * A plain span, because `aria-live` is not part of the Polaris element's
       * typed surface and inventing a prop is worse than using the platform.
       */}
      <span aria-live="polite">
        <s-text accessibilityVisibility="exclusive">{announcement}</s-text>
      </span>

      {/* The pattern, read back, with each piece removable. */}
      {parts.length > 0 ? (
        <s-stack direction="inline" gap="small-400" alignItems="center">
          {parts.map((part) =>
            part.kind === "text" ? (
              <s-text key={part.start} color="subdued">
                {part.label}
              </s-text>
            ) : (
              <s-clickable-chip
                key={part.start}
                accessibilityLabel={
                  part.known
                    ? `Remove ${part.label}${part.value ? `, which is ${part.value} for this product` : ""}`
                    : `Remove ${part.label}, which is not a field`
                }
                onClick={() => remove(part.start, part.label)}
              >
                {part.known
                  ? part.value
                    ? `${part.label}: ${part.value}`
                    : part.label
                  : `${part.label} — no such field`}
              </s-clickable-chip>
            ),
          )}
        </s-stack>
      ) : null}

      {/*
       * Capped and scrolling, so a shop with many metafields gets a list it
       * can move through rather than one running off the bottom of the page.
       */}
      <s-popover
        id={listId}
        maxBlockSize="320px"
        ref={(element) => {
          list.current = (element as Overlay | null) ?? null;
        }}
        onShow={() => setOpen(true)}
        onAfterHide={() => setOpen(false)}
      >
        <s-stack direction="block" gap="small-400">
          {full ? (
            <s-text color="subdued">
              This name already uses as many fields as a pattern can hold.
              Remove one before adding another.
            </s-text>
          ) : rows.length === 0 ? (
            <s-text color="subdued">No field matches what you typed.</s-text>
          ) : (
            groups.map((group) => (
              <s-stack key={group.id} direction="block" gap="none">
                <s-box paddingInline="small-200" paddingBlock="small-400">
                  <s-text color="subdued" type="strong">
                    {group.label}
                  </s-text>
                </s-box>
                {group.rows.map((row) => (
                  <s-clickable
                    key={row.field.id}
                    command="--hide"
                    commandFor={listId}
                    borderRadius="base"
                    paddingInline="small-200"
                    paddingBlock="small-300"
                    inlineSize="100%"
                    accessibilityLabel={
                      row.value
                        ? `Add ${row.field.label}, which is ${row.value} for this product`
                        : `Add ${row.field.label}`
                    }
                    onClick={() => insert(row)}
                  >
                    <s-grid
                      gridTemplateColumns="1fr auto"
                      gap="small-200"
                      alignItems="center"
                    >
                      <s-text>{row.field.label}</s-text>
                      <s-text color="subdued">
                        {row.value === null
                          ? ""
                          : row.value === ""
                            ? "empty for this product"
                            : row.value}
                      </s-text>
                    </s-grid>
                  </s-clickable>
                ))}
              </s-stack>
            ))
          )}
        </s-stack>
      </s-popover>

      <s-stack direction="inline">
        <s-button
          type="button"
          variant="secondary"
          commandFor={listId}
          icon={open ? "chevron-up" : "chevron-down"}
        >
          Add a field
        </s-button>
      </s-stack>
    </s-stack>
  );
}
