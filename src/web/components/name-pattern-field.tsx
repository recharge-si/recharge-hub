import { useMemo, useState } from "react";

import {
  applyPick,
  canAddField,
  flattenGroups,
  parseTemplate,
  pickerGroups,
  pickerQueryAt,
  type FieldDef,
  type PickerRow,
  type VariantFacts,
} from "~/domain/products/template";

/**
 * The name-pattern field, with a list of fields that opens when the merchant
 * types `{`.
 *
 * **Why this is not a plain primitive, and how little it adds.** The field is
 * `s-text-field` with nothing restyled; what is added is a list that appears
 * when the text says it should. Every row is an `s-clickable`, so it is in the
 * tab order and activates on Enter or Space with no key handling of our own.
 * That is the whole reason it is built this way: Polaris's typed surface has no
 * combobox and no `keydown`, and a control assembled from focusable primitives
 * has keyboard parity by construction rather than by us reimplementing it.
 *
 * What it does not do, deliberately: no arrow-key navigation of the list and no
 * inline pills. Those need a control that owns its own caret, undo stack and
 * paste handling, which is a decision to take with this in front of us rather
 * than ahead of it.
 *
 * Insertion is announced, because the caret lands after a token the merchant
 * cannot see the shape of.
 *
 * **One known limitation, deliberately not worked around.** The caret comes
 * from `selectionStart` when the component exposes it, and falls back to the
 * end of the value when it does not. Reaching into the component's shadow root
 * to find the real input would work today and break on a Polaris release. With
 * the fallback the list still opens, filters and inserts; it inserts at the end
 * rather than at the caret, which is exactly what this field did before.
 */

export interface NamePatternFieldProps {
  name: string;
  label: string;
  details?: string;
  value: string;
  onChange: (value: string) => void;
  /** Fields this shop can use, metafield definitions included. */
  registry: FieldDef[];
  /**
   * The product the list resolves values against — one of the merchant's own.
   * Null when the catalogue is empty, and then rows show no value rather than
   * an invented one.
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
  /**
   * The brace position the merchant closed the list on. Dismissing is per
   * brace, not forever: typing a new `{` somewhere else opens a new list, and
   * carrying on typing into the dismissed one does not reopen it.
   */
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const query = pickerQueryAt(value, caret);
  const open = query !== null && query.start !== dismissed;

  const groups = useMemo(
    () => (open && query ? pickerGroups(registry, query.query, sample) : []),
    [open, query, registry, sample],
  );
  const rows = useMemo(() => flattenGroups(groups), [groups]);
  const full = !canAddField(parseTemplate(value).nodes);

  const insert = (row: PickerRow) => {
    const next = applyPick(value, caret, row.field.id);
    onChange(next.source);
    setCaret(next.caret);
    setDismissed(null);
    setAnnouncement(
      `${row.field.label} added to the name. The name is now ${next.source}.`,
    );
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
          setDismissed(null);
          onChange(next);
        }}
        {...(error ? { error } : {})}
      />

      {/*
       * A plain span, because `aria-live` is not part of the Polaris element's
       * typed surface and inventing a prop is worse than using the platform.
       * The text inside is hidden visually by Polaris rather than by CSS of
       * ours, which is the rule the rest of this app follows.
       */}
      <span aria-live="polite">
        <s-text accessibilityVisibility="exclusive">{announcement}</s-text>
      </span>

      {open && query ? (
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
              <s-text color="subdued">
                No field matches what you typed. Keep typing to use the brace as
                ordinary text.
              </s-text>
            ) : (
              groups.map((group) => (
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
                        {/*
                         * The value this field has for one of the merchant's
                         * own products. Never a stand-in: an empty field says
                         * it is empty, which is the thing worth knowing.
                         */}
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
              ))
            )}

            <s-button
              type="button"
              variant="secondary"
              onClick={() => setDismissed(query.start)}
            >
              Close the field list
            </s-button>
          </s-stack>
        </s-box>
      ) : null}
    </s-stack>
  );
}
