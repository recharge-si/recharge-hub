import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  CARET_HOLDER,
  flattenGroups,
  fieldOrdinal,
  fromAtoms,
  indexOfField,
  insertField,
  makeTextAtom,
  nameFor,
  pickerGroups,
  removeAtom,
  settingsFromTemplate,
  stripHolders,
  triggerAt,
  toAtoms,
  toDisplay,
  type Atom,
  type FieldDef,
  type PickerRow,
  type VariantFacts,
} from "~/domain/products/template";

/**
 * The name pattern, edited in place: typed words and fields as chips, in one
 * line, in reading order.
 *
 * ## Why this is a custom control
 *
 * Polaris has no combobox, and `s-text-field` exposes no `keydown` and no
 * listbox role on its typed surface, so a field that opens a list on a
 * character and inserts on Enter cannot be assembled from it. The editable
 * surface here is a plain `contenteditable` div inside an `s-box` frame — the
 * same frame `dropdown.tsx` builds its field from — which is what makes the
 * keyboard behaviour ours to get right rather than ours to work around.
 *
 * ## What keeps it honest
 *
 * The stored value is a plain string and nothing else. The DOM is written from
 * `toAtoms(value)` and read back with `fromAtoms`, and
 * `tests/unit/template-editor.test.ts` holds those two to each other over a
 * generated corpus — so anything typed in the plain-text view survives a trip
 * through the chips, and anything built with chips is something the parser
 * reads the same way.
 *
 * ## The one thing that makes contenteditable workable
 *
 * The DOM is rewritten only when the value changes for a reason other than
 * typing. Ordinary keystrokes are read out of the DOM and stored; the DOM is
 * left exactly as the browser made it, so the caret, undo stack and IME
 * composition are never touched. `written` is what that comparison is against.
 *
 * Every chip is `contenteditable="false"`, so the browser treats it as one
 * character: arrows step over it and a selection cannot land inside it.
 * Backspace and Delete beside a chip are handled explicitly, because browsers
 * disagree about whether the first press selects it or removes it.
 *
 * A field's own options — a fallback value, upper case, a different separator
 * — are not here. They were, as a panel that opened when a chip was pressed,
 * and it filled the card while stealing the click that should have been
 * placing the caret. The syntax for all of it is in "Edit as text", and the
 * separator a field needs is worked out when it is inserted.
 */

/** What a chip carries so the DOM can be read back without trusting anything. */
const SRC = "data-src";

export interface PatternEditorProps {
  label: string;
  details?: string;
  value: string;
  onChange: (value: string) => void;
  registry: FieldDef[];
  /** One of the merchant's own products, or null when there are none. */
  sample: VariantFacts | null;
  error?: string;
}

function isChip(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && node.hasAttribute(SRC);
}

/**
 * The row the DOM holds, one atom per child node.
 *
 * One per node, deliberately, and nothing merged or dropped: the caret is read
 * as an index into `host.childNodes`, so any list that does not line up with
 * them means edits land on the wrong atom at the wrong offset. That is not a
 * theory — it is why choosing a field left the half-typed `{ven` sitting on
 * screen beside the chip it should have become. Merging and stripping happen
 * on the way out, in `stripHolders`, once indices no longer matter.
 */
function readDisplay(host: HTMLElement): Atom[] {
  return Array.from(host.childNodes).map((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      return makeTextAtom((child as Text).data);
    }
    if (isChip(child)) {
      const [atom] = toAtoms(child.getAttribute(SRC) ?? "");
      if (atom) return atom;
    }
    // A <br>, or a wrapper a browser inserted on paste. Keep its words.
    return makeTextAtom(child.textContent ?? "");
  });
}

/** Which child node the caret is in, and how far into it. */
function caretIn(host: HTMLElement): { atom: number; offset: number } | null {
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  if (!selection || !node || !host.contains(node)) return null;

  if (node === host) return { atom: selection.anchorOffset, offset: 0 };

  const index = Array.from(host.childNodes).indexOf(node as ChildNode);
  if (index === -1) return null;
  return { atom: index, offset: selection.anchorOffset };
}

function placeCaret(host: HTMLElement, atom: number, offset: number): void {
  const child = host.childNodes[atom];
  const range = document.createRange();

  if (!child) {
    range.selectNodeContents(host);
    range.collapse(false);
  } else if (child.nodeType === Node.TEXT_NODE) {
    const text = child as Text;
    range.setStart(text, Math.min(Math.max(offset, 0), text.data.length));
    range.collapse(true);
  } else {
    range.setStartAfter(child);
    range.collapse(true);
  }

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Writes the display row, one node per atom, in order. */
function writeDisplay(
  host: HTMLElement,
  display: Atom[],
  registry: FieldDef[],
): void {
  const label = new Map(registry.map((field) => [field.id, field.label]));
  host.replaceChildren();

  for (const atom of display) {
    if (atom.kind === "text") {
      host.append(document.createTextNode(atom.text));
      continue;
    }

    const holder = document.createElement("span");
    holder.contentEditable = "false";
    holder.setAttribute(SRC, atom.src);
    holder.setAttribute("aria-label", label.get(atom.field) ?? atom.field);
    // The only styling here, and it is spacing rather than appearance: two
    // chips with a single space between them read as one word.
    holder.style.marginInline = "1px";

    const chip = document.createElement("s-chip");
    chip.textContent = label.get(atom.field) ?? atom.field;
    holder.append(chip);
    host.append(holder);
  }
}

export function PatternEditor({
  label,
  details,
  value,
  onChange,
  registry,
  sample,
  error,
}: PatternEditorProps) {
  const labelId = `pattern-label-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const listId = `pattern-list-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const host = useRef<HTMLDivElement>(null);

  /** The value the DOM was last written from. See the note at the top. */
  const written = useRef<string | null>(null);

  const [asText, setAsText] = useState(false);
  const [open, setOpen] = useState(false);
  /**
   * The suggestion the merchant closed, so it stays closed while they carry on
   * typing the same word. Keyed by where it started, so a different word — or
   * the same one somewhere else — offers itself again.
   */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [announcement, setAnnouncement] = useState("");

  const groups = useMemo(
    () => (open ? pickerGroups(registry, query, sample) : []),
    [open, query, registry, sample],
  );
  const rows = useMemo(() => flattenGroups(groups), [groups]);

  const resolved = useMemo(
    () => (sample ? nameFor(settingsFromTemplate(value), sample).name : null),
    [value, sample],
  );

  /* Rewrite only when the value changed for a reason other than typing. */
  useEffect(() => {
    const element = host.current;
    if (!element || asText) return;
    if (written.current === value) return;

    writeDisplay(element, toDisplay(toAtoms(value)).display, registry);
    written.current = value;
  }, [value, registry, asText]);

  /** Store what the DOM now says, leaving the DOM exactly as it is. */
  const commit = (display: Atom[]): void => {
    const source = fromAtoms(stripHolders(display));
    written.current = source;
    onChange(source);
  };

  /**
   * Apply an edit the browser did not make, and put the caret back.
   *
   * The row is rebuilt three times between here and the screen — stripped of
   * its holders, turned into a pattern, padded again — and its indices mean
   * something different each time. So the caret is tracked as "after the nth
   * field", which none of those steps can move.
   */
  const apply = (edited: Atom[], fieldAt: number, said: string): void => {
    const element = host.current;
    if (!element) return;

    const ordinal = fieldOrdinal(edited, fieldAt);
    const cleaned = stripHolders(edited);
    const source = fromAtoms(cleaned);
    const { display, map } = toDisplay(cleaned);

    writeDisplay(element, display, registry);
    written.current = source;
    onChange(source);

    const landed = map[indexOfField(cleaned, ordinal)];
    const after = landed === undefined ? display.length : landed + 1;
    const node = element.childNodes[after];
    placeCaret(
      element,
      after,
      node?.nodeType === Node.TEXT_NODE ? (node as Text).data.length : 0,
    );
    setAnnouncement(said);
  };

  const handleInput = (): void => {
    const element = host.current;
    if (!element) return;

    commit(readDisplay(element));

    /*
     * Fields are suggested for whatever is being typed, not only after a `{`.
     * Read from the text node itself, so the offsets are the browser's own
     * rather than something reconstructed.
     *
     * A word only opens the list when something actually matches it. Otherwise
     * every word in a product name would drop a "nothing matches" panel over
     * the page. A `{` is different: it was typed to ask, so it gets an answer
     * either way.
     */
    const at = caretIn(element);
    const node = at === null ? null : element.childNodes[at.atom];
    if (node?.nodeType === Node.TEXT_NODE && at) {
      const trigger = triggerAt((node as Text).data, at.offset);
      const key = trigger ? `${at.atom}:${trigger.start}` : null;

      if (trigger && key !== dismissed) {
        const matches = flattenGroups(
          pickerGroups(registry, trigger.query, sample),
        );
        if (trigger.explicit || matches.length > 0) {
          setOpen(true);
          setQuery(trigger.query);
          setActive(0);
          return;
        }
      }
      if (!trigger) setDismissed(null);
    }
    setOpen(false);
  };

  const insert = (row: PickerRow): void => {
    const element = host.current;
    if (!element) return;

    const display = readDisplay(element);
    const at = caretIn(element);
    const node = at === null ? null : element.childNodes[at.atom];

    // Where what they were typing starts, so the field replaces it rather
    // than landing next to it — the word as much as the `{ven`.
    let from = at?.offset ?? 0;
    if (node?.nodeType === Node.TEXT_NODE && at) {
      from = triggerAt((node as Text).data, at.offset)?.start ?? at.offset;
    }

    const result = insertField(
      display,
      at?.atom ?? display.length,
      from,
      at?.offset ?? from,
      row.field.id,
    );

    setOpen(false);
    setQuery("");
    setDismissed(null);
    element.focus();
    apply(result.atoms, result.caret, `${row.field.label} added.`);
  };

  const removeAt = (index: number, name: string): void => {
    const element = host.current;
    if (!element) return;

    const display = readDisplay(element);
    const result = removeAtom(display, index);

    // Removing a field is not a reason to offer a list of them. Chrome fires
    // an input event of its own on the way through here, and it was leaving
    // the whole field list open over the page afterwards.
    setOpen(false);
    element.focus();
    // The caret goes where the field was, which is the field before it.
    apply(result.atoms, Math.max(0, index - 1), `${name} removed.`);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const element = host.current;
    if (!element) return;

    if (open && rows.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((now) => (now + 1) % rows.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((now) => (now - 1 + rows.length) % rows.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const row = rows[active];
        if (row) insert(row);
        return;
      }
    }

    if (event.key === "Escape" && open) {
      // Whatever was typed stays; only the suggestion goes, and it stays gone
      // while they keep typing the same word.
      event.preventDefault();
      const at = caretIn(element);
      const node = at === null ? null : element.childNodes[at.atom];
      const trigger =
        node?.nodeType === Node.TEXT_NODE && at
          ? triggerAt((node as Text).data, at.offset)
          : null;
      if (at && trigger) setDismissed(`${at.atom}:${trigger.start}`);
      setOpen(false);
      return;
    }

    // One line. Enter has no meaning in a product name.
    if (event.key === "Enter") {
      event.preventDefault();
      return;
    }

    const at = caretIn(element);
    if (!at) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;

    /*
     * Browsers disagree about whether the first Backspace beside a
     * contenteditable=false node selects it or removes it, so it is decided
     * here — and "beside" has to ignore the caret holders. Without that, the
     * first press quietly ate an invisible character and the chip only went
     * on the second, which reads as the key not working.
     */
    const node = element.childNodes[at.atom];
    const text = node?.nodeType === Node.TEXT_NODE ? (node as Text).data : null;
    const bare = (part: string) => part.split(CARET_HOLDER).join("") === "";

    if (
      event.key === "Backspace" &&
      (text === null || bare(text.slice(0, at.offset)))
    ) {
      const previous = element.childNodes[at.atom - 1];
      if (previous && isChip(previous)) {
        event.preventDefault();
        const index = at.atom - 1;
        const target = readDisplay(element)[index];
        removeAt(index, target?.kind === "field" ? target.field : "The field");
      }
      return;
    }

    if (
      event.key === "Delete" &&
      (text === null || bare(text.slice(at.offset)))
    ) {
      const next = element.childNodes[at.atom + 1];
      if (next && isChip(next)) {
        event.preventDefault();
        const index = at.atom + 1;
        const target = readDisplay(element)[index];
        removeAt(index, target?.kind === "field" ? target.field : "The field");
      }
    }
  };

  /** Paste arrives as plain text or not at all: a name has no formatting. */
  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain").replace(/\s+/g, " ");
    if (text === "") return;

    const element = host.current;
    if (!element) return;

    const display = readDisplay(element);
    const at = caretIn(element);
    const index = at?.atom ?? display.length;
    const target = display[index];

    if (target?.kind === "text" && at) {
      const next = [...display];
      next[index] = makeTextAtom(
        target.text.slice(0, at.offset) + text + target.text.slice(at.offset),
      );
      apply(next, index, "Pasted.");
      return;
    }

    apply(
      [
        ...display.slice(0, index + 1),
        makeTextAtom(text),
        ...display.slice(index + 1),
      ],
      index,
      "Pasted.",
    );
  };

  let rowIndex = -1;

  return (
    // The list hangs off this, so it has to be the thing it is measured from.
    <s-stack direction="block" gap="small-300">
      <s-text id={labelId} type="strong">
        {label}
      </s-text>

      {asText ? (
        <s-text-field
          label={label}
          labelAccessibilityVisibility="exclusive"
          value={value}
          autocomplete="off"
          onInput={(event) => {
            written.current = null;
            onChange(event.currentTarget.value);
          }}
          {...(error ? { error } : {})}
        />
      ) : (
        // The list hangs off the field, so the field is what it measures
        // itself against. Anchored to the whole control it came out below
        // the buttons, a long way from what it was suggesting for.
        <div style={{ position: "relative" }}>
          <s-box
            border="base"
            borderRadius="base"
            background="base"
            paddingInline="small-200"
            paddingBlock="small-300"
          >
            {/*
             * The frame is bigger than the words in it, and a click landing on
             * the padding beside them did nothing at all — the control looked
             * dead until you happened to hit a character. Anywhere inside the
             * frame now puts the caret at the end, which is what a text field
             * does.
             */}
            <div
              onMouseDown={(event) => {
                const element = host.current;
                if (!element || event.target === element) return;
                if (element.contains(event.target as Node)) return;
                event.preventDefault();
                element.focus();
                placeCaret(
                  element,
                  element.childNodes.length - 1,
                  Number.MAX_SAFE_INTEGER,
                );
              }}
            >
              <div
                ref={host}
                contentEditable
                suppressContentEditableWarning
                role="combobox"
                aria-labelledby={labelId}
                aria-multiline="false"
                aria-expanded={open && rows.length > 0}
                aria-controls={listId}
                aria-autocomplete="list"
                style={{ outline: "none", minHeight: "1.25rem" }}
                {...(open && rows[active]
                  ? { "aria-activedescendant": `${listId}-${active}` }
                  : {})}
                onInput={handleInput}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
              />
            </div>
          </s-box>
          {/*
           * Hanging under the field rather than sitting in the flow, the way the
           * admin's own filters do it. As a block in the flow it shoved the
           * preview, the lint and the save controls down the page every time a
           * word matched something.
           *
           * Polaris has no popover that can anchor to a contenteditable — its
           * overlays anchor to whatever declared `commandFor`, and that has to be
           * a Polaris control. So the placement is ours and the appearance is
           * still theirs: `s-box` paints it, and the only styling here is where
           * it sits.
           */}
          {open ? (
            <div
              style={{
                position: "absolute",
                insetInlineStart: 0,
                insetInlineEnd: 0,
                top: "100%",
                zIndex: 30,
              }}
            >
              <s-box
                id={listId}
                background="base"
                border="base"
                borderRadius="base"
                padding="small-200"
              >
                <s-scroll-box
                  maxBlockSize="260px"
                  accessibilityLabel="Fields you can add"
                >
                  <s-stack direction="block" gap="small-400">
                    {rows.length === 0 ? (
                      <s-text color="subdued">
                        No field matches what you typed.
                      </s-text>
                    ) : (
                      groups.map((group) => (
                        <s-stack key={group.id} direction="block" gap="none">
                          <s-box
                            paddingInline="small-200"
                            paddingBlock="small-400"
                          >
                            <s-text color="subdued" type="strong">
                              {group.label}
                            </s-text>
                          </s-box>
                          {group.rows.map((row) => {
                            rowIndex += 1;
                            const isActive = rowIndex === active;
                            return (
                              <s-clickable
                                key={row.field.id}
                                id={`${listId}-${rowIndex}`}
                                background={
                                  isActive ? "subdued" : "transparent"
                                }
                                borderRadius="base"
                                paddingInline="small-200"
                                paddingBlock="small-300"
                                inlineSize="100%"
                                accessibilityLabel={
                                  row.value
                                    ? `${row.field.label}, ${row.value} for this product`
                                    : row.field.label
                                }
                                onClick={() => insert(row)}
                              >
                                <s-grid
                                  gridTemplateColumns="1fr auto"
                                  gap="small-200"
                                  alignItems="center"
                                >
                                  <s-text
                                    type={isActive ? "strong" : undefined}
                                  >
                                    {row.field.label}
                                  </s-text>
                                  <s-text color="subdued">
                                    {row.value === null
                                      ? ""
                                      : row.value === ""
                                        ? "empty here"
                                        : row.value}
                                  </s-text>
                                </s-grid>
                              </s-clickable>
                            );
                          })}
                        </s-stack>
                      ))
                    )}
                  </s-stack>
                </s-scroll-box>
              </s-box>
            </div>
          ) : null}
        </div>
      )}

      <span aria-live="polite">
        <s-text accessibilityVisibility="exclusive">{announcement}</s-text>
      </span>

      {error ? <s-text tone="critical">{error}</s-text> : null}
      {details ? <s-text color="subdued">{details}</s-text> : null}

      {/* What the pattern comes to for one of their own products. */}
      {resolved ? (
        <s-text color="subdued">{`${sample?.sku}: ${resolved}`}</s-text>
      ) : null}

      {/*
       * No "Add a field" button. Fields suggest themselves as the merchant
       * types, which is the same bargain the admin's own filters make: you
       * write what you mean and it offers what it has. A button asking you to
       * stop and go shopping for a field is a worse version of that.
       */}
      <s-stack direction="inline" gap="small-300" alignItems="center">
        <s-button
          type="button"
          variant="secondary"
          onClick={() => {
            written.current = null;
            setOpen(false);
            setAsText((now) => !now);
          }}
        >
          {asText ? "Back to chips" : "Edit as text"}
        </s-button>
      </s-stack>
    </s-stack>
  );
}
