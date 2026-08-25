import { useMemo, useState } from "react";

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
 *  - A list of fields, opened by typing `{` or by pressing Add a field,
 *    filtered as they type and never more than a handful at a time.
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

/** Enough to choose from without becoming a wall. Typing narrows it. */
const VISIBLE_ROWS = 6;

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
  const [caret, setCaret] = useState(value.length);
  /** Dismissing is per brace: a new `{` elsewhere opens a new list. */
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [forced, setForced] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const query = pickerQueryAt(value, caret);
  const open = forced || (query !== null && query.start !== dismissed);

  const groups = useMemo(
    () => (open ? pickerGroups(registry, query?.query ?? "", sample) : []),
    [open, query, registry, sample],
  );
  const rows = useMemo(() => flattenGroups(groups), [groups]);
  const full = !canAddField(parseTemplate(value).nodes);

  const parts = useMemo(
    () => patternParts(value, registry, sample),
    [value, registry, sample],
  );

  const close = () => {
    setForced(false);
    if (query) setDismissed(query.start);
  };

  const insert = (row: PickerRow) => {
    const next = applyPick(value, caret, row.field.id);
    onChange(next.source);
    setCaret(next.caret);
    setDismissed(null);
    setForced(false);
    setAnnouncement(`${row.field.label} added. The name is now ${next.source}.`);
  };

  const remove = (start: number, partLabel: string) => {
    const next = removeFieldAt(value, start);
    onChange(next);
    setCaret(next.length);
    setAnnouncement(`${partLabel} removed. The name is now ${next}.`);
  };

  /*
   * Grouped, but never more than a screenful. An unfiltered list of every
   * field a shop has was taller than the card holding it, which teaches a
   * merchant to scroll past it rather than read it.
   */
  let shown = 0;
  const visible = groups
    .map((group) => {
      const take = group.rows.slice(0, Math.max(0, VISIBLE_ROWS - shown));
      shown += take.length;
      return { ...group, rows: take };
    })
    .filter((group) => group.rows.length > 0);
  const hidden = rows.length - shown;

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
          setDismissed(null);
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

      {open ? (
        <s-box
          background="subdued"
          borderRadius="base"
          padding="small-200"
          accessibilityLabel="Fields you can add to the name"
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
              <>
                {visible.map((group) => (
                  <s-stack key={group.id} direction="block" gap="small-500">
                    <s-text color="subdued" type="strong">
                      {group.label}
                    </s-text>
                    {group.rows.map((row) => (
                      <s-clickable
                        key={row.field.id}
                        accessibilityLabel={
                          row.value
                            ? `Add ${row.field.label}, which is ${row.value} for this product`
                            : `Add ${row.field.label}`
                        }
                        onClick={() => insert(row)}
                      >
                        <s-stack
                          direction="inline"
                          gap="small-300"
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
                        </s-stack>
                      </s-clickable>
                    ))}
                  </s-stack>
                ))}
                {hidden > 0 ? (
                  <s-text color="subdued">
                    {`${hidden} more. Keep typing to narrow the list.`}
                  </s-text>
                ) : null}
              </>
            )}
          </s-stack>
        </s-box>
      ) : null}

      <s-button
        type="button"
        variant="tertiary"
        icon={open ? "chevron-up" : "chevron-down"}
        onClick={() => (open ? close() : setForced(true))}
      >
        {open ? "Close field list" : "Add a field"}
      </s-button>
    </s-stack>
  );
}
