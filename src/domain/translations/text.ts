/**
 * Text mechanics shared by terminology discovery, translation memory and
 * post-translation validation (docs/translations.md § Translation
 * intelligence). Pure, deterministic, and deliberately free of any
 * language-specific vocabulary: what a word *means* is decided from the
 * store's own data, never from a list here.
 */

/** Visible text of an HTML fragment, whitespace collapsed. Plain text passes through. */
export function stripHtml(value: string): string {
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#0*160;|&#x0*a0;/gi, " ")
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
  // `&amp;` in a link's query is how HTML spells `&`; either way is the same URL.
  return matches.map((token) => token.replace(/&amp;/gi, "&").replace(/[.,;:]+$/, "")).sort();
}

/** Elements that never have children; `<br>`, `<br/>` and `<br />` are one tag. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

/** What a shopper sees even without text: never dropped as an empty element. */
const CONTENT_ELEMENTS: ReadonlySet<string> = new Set([
  "img", "iframe", "video", "audio", "source", "embed", "object", "picture", "svg", "input", "hr", "track",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
  "ul", "ol", "li", "dl", "dt", "dd",
]);

/** Spellings of one element that render the same. */
const SAME_ELEMENT: Readonly<Record<string, string>> = { b: "strong", i: "em" };

/** A start tag of one of these closes an open `<p>`, as a browser does. */
const CLOSES_P: ReadonlySet<string> = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre",
  "section", "table", "ul",
]);

/**
 * Elements a start tag closes implicitly when one is open, up to the
 * nearest boundary: an `<li>` ends the previous `<li>` of its list, a `<tr>`
 * the previous row and its cell. Supplier HTML leaves these unclosed and a
 * model writing the answer closes them; both are the same document.
 */
const IMPLIED_END: Readonly<Record<string, { closes: readonly string[]; within: readonly string[] }>> = {
  li: { closes: ["li"], within: ["ul", "ol"] },
  dt: { closes: ["dt", "dd"], within: ["dl"] },
  dd: { closes: ["dt", "dd"], within: ["dl"] },
  tr: { closes: ["tr", "td", "th"], within: ["table", "thead", "tbody", "tfoot"] },
  td: { closes: ["td", "th"], within: ["tr", "table"] },
  th: { closes: ["td", "th"], within: ["tr", "table"] },
  thead: { closes: ["thead", "tbody", "tfoot", "tr", "td", "th"], within: ["table"] },
  tbody: { closes: ["thead", "tbody", "tfoot", "tr", "td", "th"], within: ["table"] },
  tfoot: { closes: ["thead", "tbody", "tfoot", "tr", "td", "th"], within: ["table"] },
  option: { closes: ["option"], within: ["select", "datalist"] },
};

/** Where an open `<p>` stops being reachable (the HTML "button scope"). */
const P_SCOPE: ReadonlySet<string> = new Set(["button", "caption", "object", "table", "td", "th", "template"]);

const NO_BOUNDARY: ReadonlySet<string> = new Set();

const TAG = /<(\/?)([a-zA-Z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

interface HtmlNode {
  name: string;
  attrs: string;
  children: HtmlNode[];
  text: boolean;
}

/**
 * The element tree of an HTML fragment, parsed the lenient way a browser
 * parses supplier markup: comments and doctype ignored, void elements
 * childless whichever way they are written, unclosed `<p>`, `<li>`, `<td>`
 * and their kind closed where a browser would close them, a stray end tag
 * ignored, and anything left open closed at the end.
 */
function htmlTree(value: string): HtmlNode {
  const source = value
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<![^>]*>|<\?[^>]*>/g, "")
    .replace(/(<(script|style)\b[^>]*>)[\s\S]*?(<\/\2\s*>)/gi, "$1$3");
  const root: HtmlNode = { name: "#root", attrs: "", children: [], text: false };
  const stack: HtmlNode[] = [root];
  const top = () => stack[stack.length - 1]!;
  const markText = (text: string) => {
    if (stripHtml(text) !== "") top().text = true;
  };
  /**
   * Index of an open element named in `names` reachable before a boundary,
   * or -1: the innermost one, or with `outermost` the outermost, so a `<tr>`
   * closes the open row and not only its cell.
   */
  const openIndex = (names: readonly string[], boundary: ReadonlySet<string>, outermost = false) => {
    let found = -1;
    for (let i = stack.length - 1; i > 0; i -= 1) {
      const node = stack[i]!;
      if (names.includes(node.name)) {
        found = i;
        if (!outermost) break;
        continue;
      }
      if (boundary.has(node.name)) break;
    }
    return found;
  };

  let last = 0;
  for (const match of source.matchAll(TAG)) {
    markText(source.slice(last, match.index));
    last = match.index + match[0].length;
    const closing = match[1] === "/";
    const raw = (match[2] ?? "").toLowerCase();
    const name = SAME_ELEMENT[raw] ?? raw;
    const rest = match[3] ?? "";

    // `</br>` is read as `<br>` by a browser; every other end tag closes
    // the innermost open element of its name, or nothing.
    if (closing && name !== "br") {
      const index = openIndex([name], NO_BOUNDARY);
      if (index > 0) stack.length = index;
      continue;
    }

    if (CLOSES_P.has(name)) {
      const p = openIndex(["p"], P_SCOPE);
      if (p > 0) stack.length = p;
    }
    const implied = IMPLIED_END[name];
    if (implied) {
      const index = openIndex(implied.closes, new Set(implied.within), true);
      if (index > 0) stack.length = index;
    }

    const node: HtmlNode = { name, attrs: meaningfulAttributes(rest), children: [], text: false };
    top().children.push(node);
    if (!VOID_ELEMENTS.has(name) && !/\/\s*$/.test(rest)) stack.push(node);
  }
  markText(source.slice(last));
  return root;
}

/** `href` and `src`, entities decoded and quotes dropped, in a fixed order. */
function meaningfulAttributes(raw: string): string {
  const attrs: string[] = [];
  for (const attr of raw.matchAll(/(?:^|\s)(href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)) {
    const value = (attr[2] ?? "")
      .replace(/^["']|["']$/g, "")
      .replace(/&amp;|&#0*38;/gi, "&")
      .trim();
    attrs.push(`${attr[1]!.toLowerCase()}=${value}`);
  }
  return attrs.sort().join(" ");
}

/**
 * Drops elements that show nothing: no text, no image, table or list, no
 * link under them — an empty `<span style>`, a `<p>&nbsp;</p>` or a
 * `<p><br></p>` spacer. A model tidying the markup removes those, and
 * keeping them is not what a shopper would notice.
 */
function prune(node: HtmlNode): HtmlNode | null {
  const children = node.children.map(prune).filter((child): child is HtmlNode => child !== null);
  const kept = { ...node, children };
  if (node.name === "#root" || node.text || CONTENT_ELEMENTS.has(node.name)) return kept;
  if (node.name === "a" && node.attrs !== "") return kept;
  if (children.some((child) => child.name !== "br")) return kept;
  return null;
}

/**
 * The tag structure of an HTML fragment, as a list of `<tag>` / `</tag>`
 * entries with the attributes that carry meaning (`href`, `src`; `alt` is
 * translatable so it is excluded). Two fragments with the same skeleton
 * have the same markup; the text between the tags is what moved.
 *
 * Both sides of a comparison are read as a browser would read them
 * (`htmlTree`), so what differs only in spelling — `<br>` and `<br />`, an
 * unclosed `<p>` or `<li>`, `<b>` and `<strong>`, attribute order, quotes,
 * `&amp;` in a link, comments, empty spacer elements — is the same
 * skeleton, while an element, a link or an image added, dropped or moved
 * is not (docs/translations.md § HTML structure).
 */
export function htmlSkeleton(value: string): string[] {
  const out: string[] = [];
  const walk = (node: HtmlNode) => {
    for (const child of node.children) {
      out.push(`<${child.name}${child.attrs === "" ? "" : ` ${child.attrs}`}>`);
      if (VOID_ELEMENTS.has(child.name)) continue;
      walk(child);
      out.push(`</${child.name}>`);
    }
  };
  const tree = prune(htmlTree(value));
  if (tree) walk(tree);
  return out;
}

/**
 * Where two skeletons first part, for the correction request: the model
 * is told which tag it dropped or added rather than only that one moved.
 */
export function skeletonDifference(before: readonly string[], after: readonly string[]): string | null {
  const length = Math.max(before.length, after.length);
  for (let i = 0; i < length; i += 1) {
    if (before[i] === after[i]) continue;
    const near = before.slice(Math.max(0, i - 2), i).join("");
    const expected = before[i] ?? "the end of the field";
    const found = after[i] ?? "the end of the field";
    return `The source has ${before.length} tags and your answer ${after.length}; after ${near || "the start"} the source has ${expected} where your answer has ${found}.`;
  }
  return null;
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
