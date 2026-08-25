/**
 * Filters a token can carry: `{title|upper|truncate:20}`.
 *
 * Two rules shape the whole set:
 *
 *  - A filter never turns an empty value into a non-empty one, except
 *    `default`, whose entire job is that. Everything downstream relies on
 *    "empty in, empty out" to know a token contributed nothing.
 *  - `prefix` and `suffix` only apply to a non-empty value. That is what makes
 *    the separator belong to the token: when the value goes, its separator goes
 *    with it, and no dangling dash is left behind.
 *
 * An unknown filter is a parse error, never a silent pass-through. A template
 * that quietly ignores a typo writes the wrong name into the ERP for every
 * product, and nobody finds out until someone reads the catalogue.
 */

export interface FilterSpec {
  name: string;
  /** Fixed number of arguments, or a range. */
  minArgs: number;
  maxArgs: number;
  label: string;
  /** Shown next to the filter in the editor. */
  hint: string;
  apply: (value: string, args: string[]) => string;
}

function count(arg: string | undefined): number | null {
  if (arg === undefined) return null;
  if (!/^\d+$/.test(arg)) return null;
  const n = Number.parseInt(arg, 10);
  return Number.isFinite(n) ? n : null;
}

/** Applied to a non-empty value only, so an empty token drops its separator. */
function whenPresent(fn: (value: string, args: string[]) => string) {
  return (value: string, args: string[]) =>
    value === "" ? "" : fn(value, args);
}

export const FILTERS: FilterSpec[] = [
  {
    name: "upper",
    minArgs: 0,
    maxArgs: 0,
    label: "Upper case",
    hint: "SHIRT",
    apply: (value) => value.toUpperCase(),
  },
  {
    name: "lower",
    minArgs: 0,
    maxArgs: 0,
    label: "Lower case",
    hint: "shirt",
    apply: (value) => value.toLowerCase(),
  },
  {
    name: "trim",
    minArgs: 0,
    maxArgs: 0,
    label: "Trim spaces",
    hint: "removes spaces at both ends",
    apply: (value) => value.trim(),
  },
  {
    name: "truncate",
    minArgs: 1,
    maxArgs: 1,
    label: "Truncate",
    hint: "keep the first N characters",
    apply: whenPresent((value, args) => {
      const n = count(args[0]);
      return n === null ? value : value.slice(0, n).trim();
    }),
  },
  {
    name: "first",
    minArgs: 1,
    maxArgs: 1,
    label: "First words",
    hint: "keep the first N words",
    apply: whenPresent((value, args) => {
      const n = count(args[0]);
      if (n === null) return value;
      return value.trim().split(/\s+/).slice(0, n).join(" ");
    }),
  },
  {
    name: "last",
    minArgs: 1,
    maxArgs: 1,
    label: "Last words",
    hint: "keep the last N words",
    apply: whenPresent((value, args) => {
      const n = count(args[0]);
      if (n === null) return value;
      const words = value.trim().split(/\s+/);
      return n === 0 ? "" : words.slice(-n).join(" ");
    }),
  },
  {
    name: "replace",
    minArgs: 2,
    maxArgs: 2,
    label: "Replace",
    hint: 'replace:"from":"to"',
    apply: whenPresent((value, args) => {
      const from = args[0] ?? "";
      if (from === "") return value;
      return value.split(from).join(args[1] ?? "");
    }),
  },
  {
    name: "prefix",
    minArgs: 1,
    maxArgs: 1,
    label: "Before",
    hint: "added only when there is a value",
    apply: whenPresent((value, args) => `${args[0] ?? ""}${value}`),
  },
  {
    name: "suffix",
    minArgs: 1,
    maxArgs: 1,
    label: "After",
    hint: "added only when there is a value",
    apply: whenPresent((value, args) => `${value}${args[0] ?? ""}`),
  },
  {
    name: "default",
    minArgs: 1,
    maxArgs: 1,
    label: "Fallback",
    hint: "used when the value is empty",
    // The one filter allowed to fill an empty value, which is the point of it.
    apply: (value, args) => (value === "" ? (args[0] ?? "") : value),
  },
];

const BY_NAME = new Map(FILTERS.map((filter) => [filter.name, filter]));

export function findFilter(name: string): FilterSpec | undefined {
  return BY_NAME.get(name);
}

export function applyFilters(
  value: string,
  filters: { name: string; args: string[] }[],
): string {
  return filters.reduce((current, call) => {
    const spec = BY_NAME.get(call.name);
    // Unknown filters are rejected at parse time; if one reaches here the
    // safest thing is to leave the value untouched rather than guess.
    return spec ? spec.apply(current, call.args) : current;
  }, value);
}
