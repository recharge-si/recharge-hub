/**
 * Text mechanics shared by terminology discovery, translation memory and
 * post-translation validation (docs/translations.md § Translation
 * intelligence). Pure, deterministic, and deliberately free of any
 * language-specific vocabulary: what a word *means* is decided from the
 * store's own data, never from a list here.
 */

const HTML_TAG = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;

/** Visible text of an HTML fragment, whitespace collapsed. Plain text passes through. */
export function stripHtml(value: string): string {
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The canonical form of a term or a short string for matching: lower case,
 * trimmed, inner whitespace and dashes collapsed, trailing punctuation
 * dropped. "Wing  Foil" and "wing-foil" are the same term.
 */
export function normaliseTerm(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\s_]+/g, " ")
    .replace(/\s*-\s*/g, "-")
    .replace(/^[\s"'“”‘’.,;:!?()[\]]+|[\s"'“”‘’.,;:!?()[\]]+$/g, "")
    .trim();
}

/**
 * Words of a string as a shopper reads them: letters, digits and the joins
 * inside a token (`X-Wing`, `5.0`, `F-One`, `don't`). Punctuation between
 * words is a separator.
 */
export function wordsOf(value: string): string[] {
  const matches = value.match(/[\p{L}\p{N}]+(?:['’.\-/][\p{L}\p{N}]+)*/gu);
  return matches ?? [];
}

export function isAllCaps(word: string): boolean {
  return /\p{Lu}/u.test(word) && word === word.toUpperCase() && /^[\p{Lu}\p{N}&.-]+$/u.test(word);
}

export function isCapitalised(word: string): boolean {
  const first = word.codePointAt(0);
  if (first === undefined) return false;
  const char = String.fromCodePoint(first);
  return char !== char.toLowerCase() && char === char.toUpperCase();
}

/**
 * A model code, SKU or size designation: letters and digits in one token,
 * such as `RS:X`, `FCT-1800`, `XL-2024`, `ABC123`, `5.0m`. A bare number is
 * not one (numbers are checked separately), a bare word is not one, and
 * nor is a lower-case number-with-suffix such as `1st`, `2x` or `24h`,
 * which a translation legitimately rewrites while its digits are kept.
 */
export function looksLikeCode(word: string): boolean {
  if (word.length < 2) return false;
  const hasLetter = /\p{L}/u.test(word);
  const hasDigit = /\p{N}/u.test(word);
  if (hasLetter && hasDigit)
    return /\p{Lu}/u.test(word) || /[-./:]/.test(word) || (word.match(/\p{N}+/gu) ?? []).length >= 2;
  // A token like "RS:X" or "V8" style abbreviations with punctuation inside.
  return /^[\p{Lu}]{1,4}[:./-][\p{Lu}\p{N}]{1,4}$/u.test(word);
}

/**
 * Numeric tokens as they are compared across a translation: digit runs
 * with the decimal and thousands separators removed, so `5.0`, `5,0` and
 * `5·0` are the same number and a translator's separator change is not a
 * violation. Returned as a multiset (sorted list).
 */
export function numbersOf(value: string): string[] {
  const matches = value.match(/\p{N}+(?:[.,·]\p{N}+)*/gu) ?? [];
  return matches.map((token) => token.replace(/[.,·]/g, "")).sort();
}

/** Placeholders a template engine would fill: `{{name}}`, `{0}`, `%s`, `%1$d`, `${x}`, `[[x]]`. */
export function placeholdersOf(value: string): string[] {
  const matches =
    value.match(/\{\{\s*[^{}]+?\s*\}\}|\$\{[^}]+\}|\{[A-Za-z0-9_.]+\}|\[\[[^\]]+\]\]|%(?:\d+\$)?[sdif]/g) ??
    [];
  return matches.map((token) => token.replace(/\s+/g, "")).sort();
}

/** URLs and e-mail addresses, which are never translated. */
export function urlsOf(value: string): string[] {
  const matches =
    value.match(/https?:\/\/[^\s"'<>)]+|mailto:[^\s"'<>)]+|[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [];
  return matches.map((token) => token.replace(/[.,;:]+$/, "")).sort();
}

/**
 * The tag structure of an HTML fragment, as a list of `<tag>` / `</tag>`
 * entries with the attributes that carry meaning (`href`, `src`, `alt` is
 * translatable so it is excluded). Two fragments with the same skeleton
 * have the same markup; the text between the tags is what moved.
 */
export function htmlSkeleton(value: string): string[] {
  const skeleton: string[] = [];
  for (const match of value.matchAll(HTML_TAG)) {
    const raw = match[0];
    const name = (match[1] ?? "").toLowerCase();
    const closing = raw.startsWith("</");
    if (closing) {
      skeleton.push(`</${name}>`);
      continue;
    }
    const attrs: string[] = [];
    for (const attr of raw.matchAll(/\b(href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)) {
      attrs.push(`${attr[1]!.toLowerCase()}=${(attr[2] ?? "").replace(/^["']|["']$/g, "")}`);
    }
    skeleton.push(`<${name}${attrs.length > 0 ? " " + attrs.join(" ") : ""}${raw.endsWith("/>") ? "/" : ""}>`);
  }
  return skeleton;
}

/**
 * A rich-text document (Shopify's `RICH_TEXT_FIELD` JSON) with every text
 * value blanked, so two documents with the same nodes, marks and links
 * compare equal whatever the words say. Null when the value is not JSON.
 */
export function richTextSkeleton(value: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    return null;
  }
  return JSON.stringify(blankText(json));
}

function blankText(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(blankText);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      out[key] = key === "value" && typeof child === "string" ? "" : blankText(child);
    }
    return out;
  }
  return node;
}

/** Text values of a rich-text document, in order; empty when not JSON. */
export function richTextValues(value: string): string[] {
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        if (key === "value" && typeof child === "string") out.push(child);
        else walk(child);
      }
    }
  };
  walk(json);
  return out;
}

/** Whether `term` occurs in `text` as whole words, case-insensitively. */
export function containsTerm(text: string, term: string): boolean {
  const needle = normaliseTerm(term);
  if (needle === "") return false;
  const haystack = normaliseTerm(text);
  if (haystack === needle) return true;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s-]+/g, "[\\s-]+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(haystack);
}

/** Whether `term` occurs in `text` spelt exactly as given (case-sensitive), as whole words. */
export function containsExact(text: string, term: string): boolean {
  const needle = term.trim();
  if (needle === "") return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(text);
}

/** Multiset difference: what is in `a` and not in `b`, counting repeats. */
export function missingFrom(a: readonly string[], b: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const item of b) counts.set(item, (counts.get(item) ?? 0) + 1);
  const missing: string[] = [];
  for (const item of a) {
    const left = counts.get(item) ?? 0;
    if (left > 0) counts.set(item, left - 1);
    else missing.push(item);
  }
  return missing;
}

/** Clips a string for a prompt or a log, on a word boundary where it can. */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}
