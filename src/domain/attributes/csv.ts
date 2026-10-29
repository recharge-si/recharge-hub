import { childrenOf, pathOf } from "~/domain/attributes/resolve";
import { parseAttributeSchema } from "~/domain/attributes/schema";
import {
  DATA_TYPES,
  emptySchema,
  isSelect,
  slugify,
  type Attribute,
  type AttributeSchema,
  type DataType,
  type IdSource,
  type ProductType,
} from "~/domain/attributes/types";

/**
 * The plan as one spreadsheet (docs/attributes.md § Import and export).
 *
 * One table, one row per thing, the `record` column saying which: a type, a
 * set, an attribute, an option, an attachment, a requirement or a removal.
 * Everything is named the way a person names it — a type by its path, a set
 * and an attribute by name — never by id, so a file can be written by hand,
 * in a spreadsheet or by an AI assistant and still import. Ids are made
 * fresh on the way in.
 */

export const CSV_COLUMNS = [
  "record",
  "type",
  "set",
  "attribute",
  "format",
  "unit",
  "level",
  "shopify_field",
  "required",
  "filterable",
  "searchable",
  "comparable",
  "native",
  "assignable",
  "shopify_category",
  "code",
  "label_en",
  "label_si",
  "description",
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

export const CSV_RECORDS = [
  "type",
  "set",
  "attribute",
  "option",
  "attach",
  "requirement",
  "remove",
] as const;

export type CsvRecord = (typeof CSV_RECORDS)[number];

/** Between the names of a type path: `All products > Windsurf > Sails`. */
export const PATH_SEPARATOR = " > ";

/* -------------------------------------------------------------------------- */
/* Cells                                                                      */
/* -------------------------------------------------------------------------- */

function cell(value: string): string {
  return /[",\n\r;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const yesNo = (value: boolean) => (value ? "yes" : "no");

/**
 * RFC 4180 rows. The delimiter is whatever the header uses — a comma, or the
 * semicolon a spreadsheet set to a European locale writes.
 */
export function parseCsvRows(
  text: string,
  options: { keepEmptyRows?: boolean } = {},
): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  const firstLine = source.slice(0, source.search(/\r?\n|$/));
  const delimiter =
    [",", ";", "\t"]
      .map((d) => ({ d, n: firstLine.split(d).length }))
      .sort((a, b) => b.n - a.n)[0]?.d ?? ",";

  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          value += '"';
          i++;
        } else quoted = false;
      } else value += char;
    } else if (char === '"' && value === "") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(value);
      value = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else value += char;
  }
  if (value !== "" || row.length > 0) {
    row.push(value);
    rows.push(row);
  }
  return options.keepEmptyRows
    ? rows
    : rows.filter((r) => r.some((v) => v.trim() !== ""));
}

/* -------------------------------------------------------------------------- */
/* Export                                                                     */
/* -------------------------------------------------------------------------- */

/** The whole plan as CSV text, with a header row even when it is empty. */
export function schemaToCsv(schema: AttributeSchema): string {
  const lines: Array<Partial<Record<CsvColumn, string>>> = [];
  const path = (typeId: string) => pathOf(schema, typeId).join(PATH_SEPARATOR);
  const attributeName = (id: string) =>
    schema.attributes.find((a) => a.id === id)?.name ?? "";
  const setName = (id: string | null) =>
    schema.sets.find((s) => s.id === id)?.name ?? "";

  const walk = (parentId: string | null) => {
    for (const type of childrenOf(schema, parentId)) {
      lines.push({
        record: "type",
        type: path(type.id),
        assignable: yesNo(type.leaf),
        shopify_category: type.shopifyCategory,
      });
      walk(type.id);
    }
  };
  walk(null);

  for (const set of schema.sets)
    lines.push({ record: "set", set: set.name, description: set.description });

  for (const attribute of schema.attributes) {
    lines.push({
      record: "attribute",
      attribute: attribute.name,
      set: setName(attribute.setId),
      format: attribute.dataType,
      unit: attribute.unit,
      level: attribute.scope,
      shopify_field: attribute.key,
      required: yesNo(attribute.requiredDefault),
      filterable: yesNo(attribute.filterable),
      searchable: yesNo(attribute.searchable),
      comparable: yesNo(attribute.comparable),
      native: yesNo(attribute.implementation === "native"),
      description: attribute.description,
    });
    const list = schema.valueLists.find((l) => l.id === attribute.valueListId);
    for (const item of list?.items ?? [])
      lines.push({
        record: "option",
        attribute: attribute.name,
        code: item.code,
        label_en: item.en,
        label_si: item.si,
      });
  }

  for (const row of schema.setAssignments)
    lines.push({
      record: "attach",
      type: path(row.typeId),
      set: setName(row.setId),
    });
  for (const row of schema.attributeAssignments)
    lines.push({
      record: "attach",
      type: path(row.typeId),
      attribute: attributeName(row.attributeId),
    });
  for (const row of schema.overrides)
    lines.push({
      record: "requirement",
      type: path(row.typeId),
      attribute: attributeName(row.attributeId),
      required: yesNo(row.required),
      description: row.reason,
    });
  for (const row of schema.exclusions)
    lines.push({
      record: "remove",
      type: path(row.typeId),
      attribute: attributeName(row.attributeId),
    });

  const text = [
    CSV_COLUMNS.join(","),
    ...lines.map((line) =>
      CSV_COLUMNS.map((column) => cell(line[column] ?? "")).join(","),
    ),
  ];
  return `${text.join("\r\n")}\r\n`;
}

/* -------------------------------------------------------------------------- */
/* Import                                                                     */
/* -------------------------------------------------------------------------- */

export type CsvImport =
  { ok: true; schema: AttributeSchema } | { ok: false; problems: string[] };

const MAX_PROBLEMS = 20;

const TRUE = new Set(["yes", "y", "true", "1", "x"]);
const FALSE = new Set(["no", "n", "false", "0"]);

/** Format codes, and the names a person might write instead. */
const FORMAT_ALIASES: Record<string, DataType> = {
  ...Object.fromEntries(DATA_TYPES.map((code) => [code, code])),
  "single choice": "single_select",
  "single-select": "single_select",
  select: "single_select",
  dropdown: "single_select",
  "multiple choices": "multi_select",
  "multi-select": "multi_select",
  "whole number": "integer",
  number: "decimal",
  "decimal number": "decimal",
  "yes or no": "boolean",
  "yes / no": "boolean",
};

const key = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * A plan from CSV text. Every row is read before anything is refused, so a
 * person sees every problem in the file at once, each with its row number;
 * the result is then held to the same checks as any stored document.
 */
export function schemaFromCsv(text: string, ids: IdSource): CsvImport {
  const rows = parseCsvRows(text);
  const header = rows[0]?.map((h) => key(h).replace(/ /g, "_")) ?? [];
  if (!header.includes("record"))
    return {
      ok: false,
      problems: [
        `The first row must name the columns, starting with "record". Export a CSV from this page to see the layout.`,
      ],
    };

  const problems: string[] = [];
  const problem = (line: number, message: string) =>
    problems.push(`Row ${line}: ${message}`);

  type Row = { line: number; get: (column: CsvColumn) => string };
  const parsed: Array<Row & { record: CsvRecord }> = [];
  rows.slice(1).forEach((values, index) => {
    const line = index + 2;
    const get = (column: CsvColumn) => {
      const at = header.indexOf(column);
      return at < 0 ? "" : (values[at] ?? "").trim();
    };
    const record = key(get("record"));
    if (!(CSV_RECORDS as readonly string[]).includes(record)) {
      problem(
        line,
        `"${get("record")}" is not a record kind. Use one of ${CSV_RECORDS.join(", ")}.`,
      );
      return;
    }
    parsed.push({ line, get, record: record as CsvRecord });
  });
  const of = (record: CsvRecord) => parsed.filter((r) => r.record === record);

  const flag = (row: Row, column: CsvColumn, fallback: boolean): boolean => {
    const value = key(row.get(column));
    if (value === "") return fallback;
    if (TRUE.has(value)) return true;
    if (FALSE.has(value)) return false;
    problem(row.line, `${column} must be yes or no, not "${row.get(column)}".`);
    return fallback;
  };

  const schema = emptySchema();

  /* Types: a path names its ancestors, which exist even when not listed. */
  const typeByPath = new Map<string, ProductType>();
  const listed = new Map<string, Row>();
  const rowOfType = new Map<string, Row>();
  const splitPath = (raw: string) =>
    raw
      .split(/\s*>\s*/)
      .map((name) => name.trim())
      .filter((name) => name !== "");
  const ensureType = (names: string[]): ProductType => {
    const path = names.map(key).join(">");
    const known = typeByPath.get(path);
    if (known) return known;
    const parent = names.length > 1 ? ensureType(names.slice(0, -1)) : null;
    const type: ProductType = {
      id: ids("type"),
      name: names[names.length - 1] ?? "",
      parentId: parent?.id ?? null,
      leaf: true,
      sortOrder: (schema.types.length + 1) * 1000,
      shopifyCategory: "",
      archetype: "",
    };
    schema.types.push(type);
    typeByPath.set(path, type);
    return type;
  };
  for (const row of of("type")) {
    const names = splitPath(row.get("type"));
    if (names.length === 0) {
      problem(row.line, "a type row needs the type's path in the type column.");
      continue;
    }
    const pathKey = names.map(key).join(">");
    if (listed.has(pathKey)) {
      problem(
        row.line,
        `the type "${names.join(PATH_SEPARATOR)}" is listed twice (also row ${listed.get(pathKey)?.line}).`,
      );
      continue;
    }
    listed.set(pathKey, row);
    const type = ensureType(names);
    type.shopifyCategory = row.get("shopify_category");
    rowOfType.set(type.id, row);
  }
  const hasChildren = new Set(schema.types.map((t) => t.parentId));
  for (const type of schema.types) {
    const row = rowOfType.get(type.id);
    const fallback = !hasChildren.has(type.id);
    type.leaf = row ? flag(row, "assignable", fallback) : fallback;
  }
  const typeFor = (row: Row): ProductType | null => {
    const names = splitPath(row.get("type"));
    const type = typeByPath.get(names.map(key).join(">"));
    if (!type)
      problem(
        row.line,
        names.length === 0
          ? "name the product type in the type column."
          : `the type "${names.join(PATH_SEPARATOR)}" has no type row. Add one, or write its full path from the top.`,
      );
    return type ?? null;
  };

  /* Sets. */
  const setByName = new Map<string, { id: string; line: number }>();
  for (const row of of("set")) {
    const name = row.get("set");
    if (name === "") {
      problem(row.line, "a set row needs the set's name in the set column.");
      continue;
    }
    const existing = setByName.get(key(name));
    if (existing) {
      problem(
        row.line,
        `the set "${name}" is listed twice (also row ${existing.line}).`,
      );
      continue;
    }
    const id = ids("set");
    setByName.set(key(name), { id, line: row.line });
    schema.sets.push({ id, name, description: row.get("description") });
  }
  const setFor = (row: Row): string | null => {
    const name = row.get("set");
    const set = setByName.get(key(name));
    if (!set) problem(row.line, `the set "${name}" has no set row.`);
    return set?.id ?? null;
  };

  /* Attributes. */
  const attributeByName = new Map<
    string,
    { attribute: Attribute; line: number }
  >();
  for (const row of of("attribute")) {
    const name = row.get("attribute");
    if (name === "") {
      problem(
        row.line,
        "an attribute row needs its name in the attribute column.",
      );
      continue;
    }
    const existing = attributeByName.get(key(name));
    if (existing) {
      problem(
        row.line,
        `the attribute "${name}" is listed twice (also row ${existing.line}). Attribute names must be unique in the file.`,
      );
      continue;
    }
    const formatText = row.get("format");
    const dataType =
      formatText === "" ? "text" : FORMAT_ALIASES[key(formatText)];
    if (!dataType)
      problem(
        row.line,
        `"${formatText}" is not a format. Use one of ${DATA_TYPES.join(", ")}.`,
      );
    const levelText = key(row.get("level"));
    if (levelText !== "" && levelText !== "product" && levelText !== "variant")
      problem(
        row.line,
        `level must be product or variant, not "${row.get("level")}".`,
      );
    const attribute: Attribute = {
      id: ids("attr"),
      name,
      setId: row.get("set") === "" ? null : setFor(row),
      dataType: dataType ?? "text",
      unit: row.get("unit"),
      description: row.get("description"),
      scope: levelText === "variant" ? "variant" : "product",
      key: row.get("shopify_field"),
      implementation: flag(row, "native", false) ? "native" : "custom",
      requiredDefault: flag(row, "required", false),
      filterable: flag(row, "filterable", false),
      searchable: flag(row, "searchable", false),
      comparable: flag(row, "comparable", false),
      valueListId: null,
    };
    attributeByName.set(key(name), { attribute, line: row.line });
    schema.attributes.push(attribute);
  }
  const attributeFor = (row: Row): Attribute | null => {
    const name = row.get("attribute");
    const found = attributeByName.get(key(name))?.attribute;
    if (!found)
      problem(
        row.line,
        name === ""
          ? "name the attribute in the attribute column."
          : `the attribute "${name}" has no attribute row.`,
      );
    return found ?? null;
  };

  /* Options, in the order they are listed. */
  for (const row of of("option")) {
    const attribute = attributeFor(row);
    if (!attribute) continue;
    if (!isSelect(attribute.dataType)) {
      problem(
        row.line,
        `"${attribute.name}" is ${attribute.dataType}; only single_select and multi_select take options.`,
      );
      continue;
    }
    const en = row.get("label_en");
    const code = row.get("code") || slugify(en);
    if (en === "") {
      problem(row.line, "an option needs an English label in label_en.");
      continue;
    }
    let list = schema.valueLists.find((l) => l.id === attribute.valueListId);
    if (!list) {
      list = { id: ids("options"), items: [] };
      schema.valueLists.push(list);
      attribute.valueListId = list.id;
    }
    if (list.items.some((item) => item.code === code)) {
      problem(
        row.line,
        `"${attribute.name}" already has an option with the code "${code}".`,
      );
      continue;
    }
    list.items.push({ code, en, si: row.get("label_si") });
  }

  /* Attachments, requirements and removals. */
  const once = new Set<string>();
  const stated = (row: Row, what: string, ...parts: string[]) => {
    const id = [what, ...parts].join("|");
    if (once.has(id)) {
      problem(row.line, `this ${what} is stated twice.`);
      return true;
    }
    once.add(id);
    return false;
  };
  for (const row of of("attach")) {
    const type = typeFor(row);
    const bySet = row.get("set") !== "";
    const byAttribute = row.get("attribute") !== "";
    if (bySet === byAttribute) {
      problem(
        row.line,
        "an attach row names either a set or an attribute, not both and not neither.",
      );
      continue;
    }
    if (bySet) {
      const setId = setFor(row);
      if (!type || !setId || stated(row, "attachment", type.id, setId))
        continue;
      schema.setAssignments.push({ id: ids("sa"), typeId: type.id, setId });
    } else {
      const attribute = attributeFor(row);
      if (
        !type ||
        !attribute ||
        stated(row, "attachment", type.id, attribute.id)
      )
        continue;
      schema.attributeAssignments.push({
        id: ids("aa"),
        typeId: type.id,
        attributeId: attribute.id,
      });
    }
  }
  for (const row of of("requirement")) {
    const type = typeFor(row);
    const attribute = attributeFor(row);
    if (row.get("required") === "")
      problem(
        row.line,
        "a requirement row says yes or no in the required column.",
      );
    const required = flag(row, "required", false);
    if (
      !type ||
      !attribute ||
      stated(row, "requirement", type.id, attribute.id)
    )
      continue;
    schema.overrides.push({
      id: ids("ov"),
      typeId: type.id,
      attributeId: attribute.id,
      required,
      reason: row.get("description"),
    });
  }
  for (const row of of("remove")) {
    const type = typeFor(row);
    const attribute = attributeFor(row);
    if (!type || !attribute || stated(row, "removal", type.id, attribute.id))
      continue;
    schema.exclusions.push({
      id: ids("ex"),
      typeId: type.id,
      attributeId: attribute.id,
    });
  }

  if (problems.length > 0) {
    const shown = problems.slice(0, MAX_PROBLEMS);
    if (problems.length > MAX_PROBLEMS)
      shown.push(`… and ${problems.length - MAX_PROBLEMS} more.`);
    return { ok: false, problems: shown };
  }

  const checked = parseAttributeSchema(schema);
  return checked.ok
    ? { ok: true, schema: checked.schema }
    : { ok: false, problems: [checked.message] };
}
