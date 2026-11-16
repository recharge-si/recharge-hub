/**
 * The HTML a translation field may show and keep (docs/translations.md
 * § Editor).
 *
 * A translated description is the merchant's own HTML, and the editor both
 * renders it and lets a person edit it as rich text. Rendering someone's
 * stored markup inside the admin means it has to be cleaned first — a
 * description that once had a script in it must not run here — and pasting
 * from a word processor must not drag a page of foreign markup into a
 * product description.
 *
 * No dependency and no DOM: this is a tokeniser over the string, so it runs
 * the same on the server, in the browser and in a test. It keeps a small
 * allowlist of tags and attributes, drops everything else, and keeps the
 * *text* of a tag it does not know rather than throwing the sentence away.
 * Content that cannot be edited as rich text without being mangled —
 * embeds, scripts, tables — is detected here too, and the editor stays in
 * HTML for those fields.
 */

/** Tags kept as themselves. */
const ALLOWED = new Set([
  "p",
  "br",
  "hr",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "strike",
  "del",
  "ins",
  "sub",
  "sup",
  "small",
  "mark",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "blockquote",
  "code",
  "pre",
  "a",
  "img",
  "span",
  "div",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "caption",
  "figure",
  "figcaption",
]);

/** Tags dropped together with everything inside them. */
const DROPPED_WHOLE = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "video",
  "audio",
  "source",
  "track",
  "canvas",
  "svg",
  "math",
  "noscript",
  "template",
  "form",
  "input",
  "button",
  "select",
  "option",
  "textarea",
  "link",
  "meta",
  "base",
  "title",
]);

/** Tags that never close. */
const VOID = new Set(["br", "hr", "img", "wbr"]);

/** What each tag may carry; everything else, `on*` above all, is dropped. */
const ALLOWED_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  a: new Set(["href", "title", "target", "rel"]),
  img: new Set(["src", "alt", "title", "width", "height"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
};

const SAFE_URL = /^(https?:|mailto:|tel:|[/#?])/i;

const TOKEN =
  /<!--[\s\S]*?-->|<\/\s*([a-zA-Z][a-zA-Z0-9-]*)\s*>|<\s*([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s/>"'=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|<[^>]*>/g;

const ATTRIBUTE =
  /([^\s/>"'=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function keepAttributes(tag: string, raw: string): string {
  const allowed = ALLOWED_ATTRIBUTES[tag];
  if (!allowed || raw.trim() === "") return "";
  const kept: string[] = [];
  for (const match of raw.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? "").toLowerCase();
    if (!allowed.has(name)) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if ((name === "href" || name === "src") && !SAFE_URL.test(value.trim()))
      continue;
    kept.push(`${name}="${value.replace(/"/g, "&quot;")}"`);
  }
  return kept.length > 0 ? ` ${kept.join(" ")}` : "";
}

/**
 * The same HTML with everything this app will not render taken out. A tag
 * that is not allowed loses its markup but keeps its text; a tag that
 * carries something executable loses its content too.
 */
export function sanitizeHtml(html: string): string {
  let out = "";
  let cursor = 0;
  /** The tag whose content is being dropped, and how deep in it we are. */
  let dropping: { tag: string; depth: number } | null = null;

  for (const match of html.matchAll(TOKEN)) {
    const at = match.index ?? 0;
    if (!dropping) out += html.slice(cursor, at);
    cursor = at + match[0].length;

    const closing = match[1]?.toLowerCase();
    const opening = match[2]?.toLowerCase();

    if (dropping) {
      if (opening === dropping.tag) dropping.depth += 1;
      else if (closing === dropping.tag) {
        dropping.depth -= 1;
        if (dropping.depth === 0) dropping = null;
      }
      continue;
    }

    if (opening && DROPPED_WHOLE.has(opening)) {
      // A void form of a dropped tag closes itself; nothing follows to skip.
      if (match[4] !== "/") dropping = { tag: opening, depth: 1 };
      continue;
    }
    if (closing && DROPPED_WHOLE.has(closing)) continue;

    if (opening && ALLOWED.has(opening)) {
      const attributes = keepAttributes(opening, match[3] ?? "");
      out += VOID.has(opening)
        ? `<${opening}${attributes} />`
        : `<${opening}${attributes}>`;
      continue;
    }
    if (closing && ALLOWED.has(closing) && !VOID.has(closing)) {
      out += `</${closing}>`;
      continue;
    }
    // A comment, an unknown tag, or something that is not a tag at all: the
    // markup goes, the words stay.
  }
  if (!dropping) out += html.slice(cursor);
  return out;
}

const EMBEDDED =
  /<\s*(iframe|script|video|audio|object|embed|svg|table|form)\b/i;

/**
 * Whether this field has to be edited as HTML. Rich text editing rewrites
 * what it is given, and an embed or a table does not survive that, so the
 * editor stays in HTML for those and says why.
 */
export function needsSourceEditing(html: string): boolean {
  return EMBEDDED.test(html);
}

/** Whether there is anything to read once the markup is taken away. */
export function isHtmlEmpty(html: string): boolean {
  return (
    html
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ")
      .trim() === ""
  );
}

/** HTML as one line of plain text, for a tooltip or a summary. */
export function htmlToText(html: string): string {
  return sanitizeHtml(html)
    .replace(/<(br|\/p|\/li|\/h[1-6]|\/div)[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}
