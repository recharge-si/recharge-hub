import { describe, expect, it } from "vitest";

import {
  CARET_HOLDER,
  fieldOrdinal,
  filterArg,
  fromAtoms,
  indexOfField,
  stripHolders,
  toDisplay,
  hasFilter,
  insertField,
  makeTextAtom,
  normaliseAtoms,
  removeAtom,
  parseTemplate,
  serializeTemplate,
  toAtoms,
  withFilter,
  withOptional,
  withSeparators,
  type FieldAtom,
} from "~/domain/products/template";

/**
 * The editor never assembles a pattern by hand: it changes atoms and
 * concatenates them. So the only thing that has to be true is that atoms and
 * the string are the same information, and that every change to an atom comes
 * back out as something the parser reads the same way.
 *
 * Round-tripping is held to the canonical form rather than to the input
 * string, because the serializer normalises — `truncate:20` stays bare while a
 * separator gains quotes. That is the same guarantee parse and serialize
 * already give each other; what matters is that going through atoms adds no
 * further drift.
 */
function canonical(source: string): string {
  return serializeTemplate(parseTemplate(source).nodes);
}

const PATTERNS = [
  "",
  "{title}",
  "{title}[ {options}]",
  "{title}[ - {options}]",
  "{title}[ {options}][ {sku}]",
  "{vendor}[ {title}][ {options}]",
  "Acme {title}",
  '{title}{option1|prefix:" - "}',
  "{title|upper}[ {sku|lower}]",
  '{options|default:"one size"}[ {title}]',
  "{title} - {options} - {sku}",
  "{title}[ ({option1}/{option2})]",
  "{metafield.specs.area}[ m2]",
  "50% {title}",
  String.raw`\{not a field\} {title}`,
  "{title}]stray",
  "{title}[unclosed",
  "{}",
  "{title|nosuchfilter}",
];

describe("atoms and the pattern are the same information", () => {
  for (const pattern of PATTERNS) {
    it(`round-trips ${JSON.stringify(pattern)}`, () => {
      expect(fromAtoms(toAtoms(pattern))).toBe(canonical(pattern));
    });
  }

  it("round-trips a generated corpus", () => {
    const fields = ["title", "options", "sku", "vendor", "metafield.a.b"];
    const joins = ["", " ", " - ", " / ", "x"];

    for (const first of fields) {
      for (const join of joins) {
        for (const second of fields) {
          for (const shape of [
            `{${first}}${join}{${second}}`,
            `{${first}}[${join}{${second}}]`,
            `[${join}{${first}}]{${second}}`,
            `{${first}|upper}[${join}{${second}|truncate:5}]`,
          ]) {
            expect(fromAtoms(toAtoms(shape))).toBe(canonical(shape));
          }
        }
      }
    }
  });
});

describe("what an atom is", () => {
  it("binds a lone field's group to the field, separator and all", () => {
    const [, options] = toAtoms("{title}[ - {options}]");

    expect(options).toMatchObject({
      kind: "field",
      field: "options",
      before: " - ",
      after: "",
      optional: true,
      src: "[ - {options}]",
    });
  });

  it("leaves a bare field alone", () => {
    const [title] = toAtoms("{title} x");

    expect(title).toMatchObject({
      field: "title",
      optional: false,
      src: "{title}",
    });
  });

  it("keeps the merchant's own words as text", () => {
    const atoms = toAtoms("Acme {title}");

    expect(atoms[0]).toMatchObject({ kind: "text", text: "Acme " });
  });

  it("does not swallow a group holding two fields", () => {
    const atoms = toAtoms("{title}[ ({option1}/{option2})]");

    // The brackets become text rather than hiding structure that could then
    // not be edited.
    expect(atoms.map((atom) => atom.kind)).toEqual([
      "field",
      "text",
      "text",
      "field",
      "text",
      "field",
      "text",
      "text",
    ]);
  });

  it("escapes a brace the merchant typed as text", () => {
    const [atom] = toAtoms(String.raw`\{x`);

    expect(atom).toMatchObject({ kind: "text", text: "{x" });
    expect(atom?.src).toBe(String.raw`\{x`);
  });
});

describe("changing a field", () => {
  /** By name, because a pattern usually has more than one field in it. */
  const fieldNamed = (source: string, field: string): FieldAtom => {
    const atom = toAtoms(source).find(
      (candidate): candidate is FieldAtom =>
        candidate.kind === "field" && candidate.field === field,
    );
    if (!atom) throw new Error(`No {${field}} in ${source}`);
    return atom;
  };

  it("adds a filter and rebuilds the source", () => {
    const next = withFilter(fieldNamed("{title}", "title"), "upper", []);

    expect(next.src).toBe("{title|upper}");
  });

  it("replaces a filter rather than stacking it", () => {
    const once = withFilter(fieldNamed("{title}", "title"), "truncate", ["20"]);
    const twice = withFilter(once, "truncate", ["10"]);

    expect(twice.src).toBe("{title|truncate:10}");
  });

  it("removes a filter when its argument is emptied", () => {
    const withDefault = withFilter(
      fieldNamed("{options}", "options"),
      "default",
      ["one size"],
    );
    expect(withDefault.src).toBe('{options|default:"one size"}');

    // Not `default:""` — that would make every empty value non-empty and
    // defeat the collapsing the renderer depends on.
    expect(withFilter(withDefault, "default", [""]).src).toBe("{options}");
  });

  it("keeps the order of the filters it does not touch", () => {
    const start = withFilter(
      withFilter(fieldNamed("{title}", "title"), "upper", []),
      "truncate",
      ["20"],
    );

    expect(withFilter(start, "upper", []).src).toBe(
      "{title|upper|truncate:20}",
    );
  });

  it("reads an argument back, and says when a filter is absent", () => {
    const atom = withFilter(fieldNamed("{title}", "title"), "truncate", ["20"]);

    expect(filterArg(atom, "truncate")).toBe("20");
    expect(hasFilter(atom, "upper")).toBe(false);
    expect(filterArg(atom, "default")).toBe("");
  });

  it("turns the group on and off, carrying the separator with it", () => {
    const grouped = fieldNamed("{title}[ - {options}]", "options");

    expect(withOptional(grouped, false).src).toBe(" - {options}");
    expect(withOptional(withOptional(grouped, false), true).src).toBe(
      "[ - {options}]",
    );
  });

  it("changes the separator", () => {
    const grouped = fieldNamed("{title}[ - {options}]", "options");

    expect(withSeparators(grouped, " / ", "").src).toBe("[ / {options}]");
  });

  it("produces something the parser reads back as one field", () => {
    const atom = withFilter(
      withSeparators(
        fieldNamed("{title}[ - {options}]", "options"),
        " | ",
        " cm",
      ),
      "upper",
      [],
    );
    const { nodes, errors } = parseTemplate(atom.src);

    expect(errors).toEqual([]);
    expect(fromAtoms(toAtoms(atom.src))).toBe(serializeTemplate(nodes));
  });
});

describe("putting a field in", () => {
  const src = (atoms: ReturnType<typeof toAtoms>) => fromAtoms(atoms);

  it("hands the separator in front of it to the field", () => {
    // "Shirt - " then Options. Left as typed this ends "Shirt -" on a product
    // with no options; handed to the field, the dash goes when the value does.
    const atoms = toAtoms("Shirt - ");
    const result = insertField(atoms, 0, 8, 8, "options");

    expect(src(result.atoms)).toBe("Shirt[ - {options}]");
  });

  it("leaves a word alone, because a word is not punctuation", () => {
    const result = insertField(toAtoms("Shirt"), 0, 5, 5, "options");

    expect(src(result.atoms)).toBe("Shirt{options}");
  });

  it("drops the half-typed trigger it was called on", () => {
    // "Acme {opt" with the caret at the end: the "{opt" goes, the field lands.
    // Escaped, so the half-typed trigger really is text in the row rather
    // than something the parser has already thrown away.
    const atoms = toAtoms(String.raw`Acme \{opt`);
    expect(atoms[0]).toMatchObject({ kind: "text", text: "Acme {opt" });

    const result = insertField(atoms, 0, 5, 9, "options");

    expect(src(result.atoms)).toBe("Acme[ {options}]");
  });

  it("keeps what was typed after the caret", () => {
    const result = insertField(toAtoms("ab"), 0, 1, 1, "sku");

    expect(src(result.atoms)).toBe("a{sku}b");
  });

  it("inserts into an empty pattern", () => {
    const result = insertField([], 0, 0, 0, "title");

    expect(src(result.atoms)).toBe("{title}");
    expect(result.caret).toBe(0);
  });

  it("inserts between two fields without inventing a separator", () => {
    const atoms = toAtoms("{title}{sku}");
    const result = insertField(atoms, 0, 0, 0, "vendor");

    expect(src(result.atoms)).toBe("{title}{vendor}{sku}");
  });

  it("puts the caret after the field it just inserted", () => {
    const result = insertField(toAtoms("Shirt - "), 0, 8, 8, "options");

    expect(result.atoms[result.caret]).toMatchObject({
      kind: "field",
      field: "options",
    });
  });

  it("produces something the parser reads back unchanged", () => {
    const result = insertField(toAtoms("Shirt / "), 0, 8, 8, "sku");
    const text = src(result.atoms);

    expect(fromAtoms(toAtoms(text))).toBe(text);
  });
});

describe("taking a field out", () => {
  it("removes it and leaves the rest alone", () => {
    const atoms = toAtoms("{vendor} {title}");
    const result = removeAtom(atoms, 0);

    expect(fromAtoms(result.atoms)).toBe(" {title}");
  });

  it("takes the separator with it when the field owned one", () => {
    const atoms = toAtoms("{title}[ - {options}]");
    const result = removeAtom(atoms, 1);

    expect(fromAtoms(result.atoms)).toBe("{title}");
  });
});

describe("normalising the row", () => {
  it("merges neighbouring text, because the browser splits it as it likes", () => {
    const atoms = [
      makeTextAtom("Sh"),
      makeTextAtom("irt"),
      ...toAtoms("{sku}"),
    ];

    expect(normaliseAtoms(atoms)).toHaveLength(2);
    expect(fromAtoms(normaliseAtoms(atoms))).toBe("Shirt{sku}");
  });

  it("drops empty text left behind by an edit", () => {
    const atoms = [makeTextAtom(""), ...toAtoms("{sku}"), makeTextAtom("")];

    expect(normaliseAtoms(atoms)).toHaveLength(1);
  });

  it("keeps escaping right when it merges", () => {
    const atoms = [makeTextAtom("a{"), makeTextAtom("b")];

    expect(fromAtoms(normaliseAtoms(atoms))).toBe(String.raw`a\{b`);
  });
});

describe("the row an editor has to hold", () => {
  it("gives every field text on both sides", () => {
    const { display } = toDisplay(toAtoms("{title}{sku}"));

    // Without this a browser has nowhere to put the caret and the control
    // cannot be typed into at all.
    expect(display.map((atom) => atom.kind)).toEqual([
      "text",
      "field",
      "text",
      "field",
      "text",
    ]);
  });

  it("leaves text that is already there to do the job", () => {
    const { display } = toDisplay(toAtoms("a{sku}b"));

    expect(display.map((atom) => atom.kind)).toEqual(["text", "field", "text"]);
    expect(display[0]).toMatchObject({ text: "a" });
  });

  it("says where each atom went", () => {
    const atoms = toAtoms("{title}{sku}");
    const { display, map } = toDisplay(atoms);

    expect(map).toEqual([1, 3]);
    expect(display[map[0]!]).toMatchObject({ field: "title" });
    expect(display[map[1]!]).toMatchObject({ field: "sku" });
  });

  it("comes back to the same pattern once the holders are stripped", () => {
    for (const pattern of PATTERNS) {
      const { display } = toDisplay(toAtoms(pattern));

      expect(fromAtoms(stripHolders(display))).toBe(canonical(pattern));
    }
  });

  it("strips holders that a browser merged into typed text", () => {
    const typed = [makeTextAtom(`${CARET_HOLDER}Shirt${CARET_HOLDER}`)];

    expect(fromAtoms(stripHolders(typed))).toBe("Shirt");
  });
});

describe("finding a field again after the row is rebuilt", () => {
  it("counts fields, not atoms", () => {
    const atoms = toAtoms("a{title}b{sku}c");

    expect(fieldOrdinal(atoms, 1)).toBe(0);
    expect(fieldOrdinal(atoms, 3)).toBe(1);
  });

  it("survives padding and stripping", () => {
    const atoms = toAtoms("{title}{sku}");
    const ordinal = fieldOrdinal(atoms, 1);
    const { display, map } = toDisplay(atoms);

    // The sku is at a different index in every one of these, and is still
    // the same field.
    expect(indexOfField(atoms, ordinal)).toBe(1);
    expect(map[indexOfField(atoms, ordinal)]).toBe(3);
    expect(display[3]).toMatchObject({ field: "sku" });
    expect(indexOfField(stripHolders(display), ordinal)).toBe(1);
  });

  it("points past the end when there is no such field", () => {
    const atoms = toAtoms("{title}");

    expect(indexOfField(atoms, 5)).toBe(atoms.length);
  });
});

describe("merging text never re-escapes it", () => {
  it("keeps a group's bracket as a bracket", () => {
    // The bracket is a text atom whose source is a bare "[". Merging it by
    // re-escaping its text turned "[ m2]" into "\[ m2\]" and silently
    // changed a group into two literal characters.
    const atoms = toAtoms("{metafield.specs.area}[ m2]");

    expect(fromAtoms(normaliseAtoms(atoms))).toBe(
      "{metafield.specs.area}[ m2]",
    );
  });

  it("still escapes a brace the merchant typed", () => {
    const atoms = [makeTextAtom("a{"), makeTextAtom("}b")];

    expect(fromAtoms(normaliseAtoms(atoms))).toBe(String.raw`a\{\}b`);
  });
});
