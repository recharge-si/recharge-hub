import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  filterArg,
  flattenGroups,
  fromAtoms,
  hasFilter,
  insertField,
  makeTextAtom,
  nameFor,
  normaliseAtoms,
  pickerGroups,
  pickerQueryAt,
  removeAtom,
  settingsFromTemplate,
  toAtoms,
  withFilter,
  withOptional,
  withSeparators,
  type Atom,
  type FieldAtom,
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
 */

/** What a chip carries so the DOM can be read back without trusting anything. */
const SRC = "data-src";
const INDEX = "data-index";

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

/** The row the DOM currently holds, defensively — the browser adds nodes. */
function readAtoms(host: HTMLElement): Atom[] {
  const atoms: Atom[] = [];

  for (const child of Array.from(host.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      atoms.push(makeTextAtom((child as Text).data));
      continue;
    }
    if (isChip(child)) {
      const [atom] = toAtoms(child.getAttribute(SRC) ?? "");
      if (atom) atoms.push(atom);
      continue;
    }
    // A <br>, or a wrapper a browser inserted on paste. Keep its words.
    const text = child.textContent ?? "";
    if (text !== "") atoms.push(makeTextAtom(text));
  }

  return normaliseAtoms(atoms);
}

/** Which atom the caret is in, and how far into it. */
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

function writeAtoms(
  host: HTMLElement,
  atoms: Atom[],
  registry: FieldDef[],
): void {
  const label = new Map(registry.map((field) => [field.id, field.label]));
  host.replaceChildren();

  atoms.forEach((atom, index) => {
    if (atom.kind === "text") {
      host.append(document.createTextNode(atom.text));
      return;
    }

    const holder = document.createElement("span");
    holder.contentEditable = "false";
    holder.setAttribute(SRC, atom.src);
    holder.setAttribute(INDEX, String(index));
    holder.setAttribute("role", "button");
    holder.setAttribute("tabindex", "-1");
    holder.setAttribute(
      "aria-label",
      `${label.get(atom.field) ?? atom.field}. Press to change or remove.`,
    );

    const chip = document.createElement("s-chip");
    chip.textContent = label.get(atom.field) ?? atom.field;
    holder.append(chip);
    host.append(holder);
  });

  // A row ending in a chip has nowhere to put the caret after it.
  if (atoms[atoms.length - 1]?.kind === "field") {
    host.append(document.createTextNode(""));
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
  /** Where to put the caret after the next rewrite, in atom terms. */
  const pending = useRef<{ atom: number; offset: number } | null>(null);

  const [asText, setAsText] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const atoms = useMemo(() => toAtoms(value), [value]);

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

    writeAtoms(element, toAtoms(value), registry);
    written.current = value;

    const target = pending.current;
    pending.current = null;
    if (target && document.activeElement === element) {
      placeCaret(element, target.atom, target.offset);
    }
  }, [value, registry, asText]);

  /** Store what the DOM now says, without touching the DOM. */
  const commit = (next: Atom[]): string => {
    const source = fromAtoms(normaliseAtoms(next));
    written.current = source;
    onChange(source);
    return source;
  };

  /** Store and rewrite, for a change the browser did not make itself. */
  const apply = (next: Atom[], caret: number, said: string): void => {
    const rowsOut = normaliseAtoms(next);
    pending.current = { atom: caret + 1, offset: 0 };
    written.current = null;
    onChange(fromAtoms(rowsOut));
    setAnnouncement(said);
  };

  const handleInput = (): void => {
    const element = host.current;
    if (!element) return;

    const current = readAtoms(element);
    commit(current);

    // A `{` immediately before the caret opens the list, and carrying on
    // typing filters it. Read from the text node itself, so the offsets are
    // the browser's own rather than something reconstructed.
    const at = caretIn(element);
    const node = at === null ? null : element.childNodes[at.atom];
    if (node?.nodeType === Node.TEXT_NODE && at) {
      const found = pickerQueryAt((node as Text).data, at.offset);
      if (found) {
        setOpen(true);
        setQuery(found.query);
        setActive(0);
        return;
      }
    }
    setOpen(false);
  };

  const insert = (row: PickerRow): void => {
    const element = host.current;
    if (!element) return;

    const current = readAtoms(element);
    const at = caretIn(element);
    const node = at === null ? null : element.childNodes[at.atom];

    let from = at?.offset ?? 0;
    if (node?.nodeType === Node.TEXT_NODE && at) {
      from = pickerQueryAt((node as Text).data, at.offset)?.start ?? at.offset;
    }

    const result = insertField(
      current,
      at?.atom ?? current.length,
      from,
      at?.offset ?? from,
      row.field.id,
    );

    apply(result.atoms, result.caret, `${row.field.label} added.`);
    setOpen(false);
    setQuery("");
    element.focus();
  };

  const removeAt = (index: number, name: string): void => {
    const element = host.current;
    const current = element ? readAtoms(element) : atoms;
    const result = removeAtom(current, index);

    apply(result.atoms, result.caret - 1, `${name} removed.`);
    setEditing(null);
    element?.focus();
  };

  const replaceAt = (index: number, atom: FieldAtom): void => {
    const element = host.current;
    const current = element ? readAtoms(element) : atoms;
    const next = [...current];
    next[index] = atom;

    pending.current = null;
    written.current = null;
    onChange(fromAtoms(normaliseAtoms(next)));
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
      // The brace stays: it may be a brace the merchant meant to type.
      event.preventDefault();
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

    // Browsers disagree about whether the first Backspace beside a
    // contenteditable=false node selects it or removes it. Decide here.
    if (event.key === "Backspace" && at.offset === 0) {
      const previous = element.childNodes[at.atom - 1];
      if (previous && isChip(previous)) {
        event.preventDefault();
        const current = readAtoms(element);
        const index = Number(previous.getAttribute(INDEX));
        const target = current[index];
        removeAt(index, target?.kind === "field" ? target.field : "The field");
      }
      return;
    }

    if (event.key === "Delete") {
      const node = element.childNodes[at.atom];
      const atEnd =
        node?.nodeType === Node.TEXT_NODE &&
        at.offset === (node as Text).data.length;
      const next = element.childNodes[at.atom + 1];
      if (atEnd && next && isChip(next)) {
        event.preventDefault();
        const current = readAtoms(element);
        const index = Number(next.getAttribute(INDEX));
        const target = current[index];
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

    const current = readAtoms(element);
    const at = caretIn(element);
    const index = at?.atom ?? current.length;
    const target = current[index];

    if (target?.kind === "text" && at) {
      const before = target.text.slice(0, at.offset);
      const after = target.text.slice(at.offset);
      const next = [...current];
      next[index] = makeTextAtom(before + text + after);
      apply(next, index - 1, "Pasted.");
      return;
    }

    apply(
      [
        ...current.slice(0, index + 1),
        makeTextAtom(text),
        ...current.slice(index + 1),
      ],
      index,
      "Pasted.",
    );
  };

  const handleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const chip = (event.target as HTMLElement | null)?.closest(`[${SRC}]`);
    if (!chip) return;
    event.preventDefault();
    setEditing(Number(chip.getAttribute(INDEX)));
  };

  const openList = (): void => {
    setOpen(true);
    setQuery("");
    setActive(0);
    host.current?.focus();
  };

  const chosen = editing === null ? null : atoms[editing];
  const chosenField = chosen?.kind === "field" ? chosen : null;
  let rowIndex = -1;

  return (
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
        <s-box
          border="base"
          borderRadius="base"
          background="base"
          paddingInline="small-200"
          paddingBlock="small-300"
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
            {...(open && rows[active]
              ? { "aria-activedescendant": `${listId}-${active}` }
              : {})}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onClick={handleClick}
          />
        </s-box>
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

      {open ? (
        <s-scroll-box
          id={listId}
          background="subdued"
          borderRadius="base"
          padding="small-200"
          maxBlockSize="240px"
          accessibilityLabel="Fields you can add"
        >
          <s-stack direction="block" gap="small-400">
            {rows.length === 0 ? (
              <s-text color="subdued">No field matches what you typed.</s-text>
            ) : (
              groups.map((group) => (
                <s-stack key={group.id} direction="block" gap="none">
                  <s-box paddingInline="small-200" paddingBlock="small-400">
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
                        background={isActive ? "subdued" : "transparent"}
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
                          <s-text type={isActive ? "strong" : undefined}>
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
      ) : null}

      {/* One field's options, opened by pressing its chip. */}
      {chosenField && editing !== null ? (
        <s-box
          background="subdued"
          borderRadius="base"
          padding="base"
          accessibilityLabel={`Options for ${chosenField.field}`}
        >
          <s-stack direction="block" gap="base">
            <s-checkbox
              label="Hide it, and the text beside it, when the product has no value"
              checked={chosenField.optional}
              onChange={(e) =>
                replaceAt(
                  editing,
                  withOptional(chosenField, e.currentTarget.checked),
                )
              }
            />
            <s-text-field
              label="Text before it"
              details="Goes only when there is a value to put it against."
              value={chosenField.before}
              onInput={(e) =>
                replaceAt(
                  editing,
                  withSeparators(
                    chosenField,
                    e.currentTarget.value,
                    chosenField.after,
                  ),
                )
              }
            />
            <s-text-field
              label="Text after it"
              value={chosenField.after}
              onInput={(e) =>
                replaceAt(
                  editing,
                  withSeparators(
                    chosenField,
                    chosenField.before,
                    e.currentTarget.value,
                  ),
                )
              }
            />
            <s-choice-list
              label="Change the letters"
              values={
                hasFilter(chosenField, "upper")
                  ? ["upper"]
                  : hasFilter(chosenField, "lower")
                    ? ["lower"]
                    : ["none"]
              }
              onChange={(e) => {
                const picked = e.currentTarget.values[0] ?? "none";
                const cleared = withFilter(
                  withFilter(chosenField, "upper", null),
                  "lower",
                  null,
                );
                replaceAt(
                  editing,
                  picked === "none" ? cleared : withFilter(cleared, picked, []),
                );
              }}
            >
              <s-choice value="none">Leave them</s-choice>
              <s-choice value="upper">UPPER CASE</s-choice>
              <s-choice value="lower">lower case</s-choice>
            </s-choice-list>
            <s-text-field
              label="Use this when the product has no value"
              value={filterArg(chosenField, "default")}
              onInput={(e) =>
                replaceAt(
                  editing,
                  withFilter(chosenField, "default", [e.currentTarget.value]),
                )
              }
            />

            <s-stack direction="inline" gap="base" alignItems="center">
              <s-button
                type="button"
                variant="secondary"
                onClick={() => setEditing(null)}
              >
                Done
              </s-button>
              <s-button
                type="button"
                variant="secondary"
                tone="critical"
                onClick={() => removeAt(editing, chosenField.field)}
              >
                Remove this field
              </s-button>
            </s-stack>
          </s-stack>
        </s-box>
      ) : null}

      <s-stack direction="inline" gap="small-300" alignItems="center">
        {asText ? null : (
          <s-button
            type="button"
            variant="secondary"
            icon={open ? "chevron-up" : "chevron-down"}
            onClick={() => (open ? setOpen(false) : openList())}
          >
            Add a field
          </s-button>
        )}
        <s-button
          type="button"
          variant="secondary"
          onClick={() => {
            written.current = null;
            setOpen(false);
            setEditing(null);
            setAsText((now) => !now);
          }}
        >
          {asText ? "Back to chips" : "Edit as text"}
        </s-button>
      </s-stack>
    </s-stack>
  );
}
