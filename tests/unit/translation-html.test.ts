import { describe, expect, it } from "vitest";

import {
  htmlToText,
  isHtmlEmpty,
  needsSourceEditing,
  sanitizeHtml,
} from "~/web/lib/html";

/**
 * What the editor will render and keep (docs/translations.md § Editor). The
 * one that matters: a description is the merchant's own stored markup, and
 * rendering it inside the admin must not run anything.
 */

describe("sanitizeHtml", () => {
  it("keeps the markup a description is made of", () => {
    const html =
      "<p>Our line of <strong>SUPs</strong> covers <em>inflatable</em> boards.</p><ul><li>Former windsurfer</li></ul><h4>Our team</h4>";
    expect(sanitizeHtml(html)).toBe(html);
  });

  it("drops what could run, and its content with it", () => {
    expect(
      sanitizeHtml("<p>Before</p><script>alert(1)</script><p>After</p>"),
    ).toBe("<p>Before</p><p>After</p>");
    expect(
      sanitizeHtml(
        '<p>A</p><iframe src="https://youtube.com/embed/x"></iframe><p>B</p>',
      ),
    ).toBe("<p>A</p><p>B</p>");
    expect(sanitizeHtml("<style>p{display:none}</style><p>Visible</p>")).toBe(
      "<p>Visible</p>",
    );
    // Nested drops close on their own tag, not on the first close they meet.
    expect(sanitizeHtml("<script><script>x</script></script><p>Kept</p>")).toBe(
      "<p>Kept</p>",
    );
  });

  it("drops every attribute it does not know, handlers above all", () => {
    expect(sanitizeHtml('<p onclick="steal()" class="x">Text</p>')).toBe(
      "<p>Text</p>",
    );
    expect(
      sanitizeHtml('<a href="https://recharge.si" title="Shop">Go</a>'),
    ).toBe('<a href="https://recharge.si" title="Shop">Go</a>');
    expect(sanitizeHtml('<a href="/collections/sup">Go</a>')).toBe(
      '<a href="/collections/sup">Go</a>',
    );
    // A link that would run something keeps its words and loses its address.
    expect(sanitizeHtml('<a href="javascript:alert(1)">Go</a>')).toBe(
      "<a>Go</a>",
    );
    expect(
      sanitizeHtml('<img src="https://cdn/x.png" alt="Board" onerror="x">'),
    ).toBe('<img src="https://cdn/x.png" alt="Board" />');
  });

  it("keeps the words of a tag it does not know, and drops comments", () => {
    expect(sanitizeHtml("<custom-block>Words</custom-block>")).toBe("Words");
    expect(sanitizeHtml("<p>A<!-- a note -->B</p>")).toBe("<p>AB</p>");
  });

  it("leaves text and entities alone", () => {
    expect(sanitizeHtml("Wind &amp; foil &lt;3")).toBe("Wind &amp; foil &lt;3");
    expect(sanitizeHtml("")).toBe("");
  });
});

describe("what has to stay HTML", () => {
  it("names the content rich text editing would mangle", () => {
    expect(needsSourceEditing('<p>x</p><iframe src="y"></iframe>')).toBe(true);
    expect(needsSourceEditing("<table><tr><td>1</td></tr></table>")).toBe(true);
    expect(needsSourceEditing("<p>Plain <strong>prose</strong></p>")).toBe(
      false,
    );
  });
});

describe("reading HTML as text", () => {
  it("knows an empty field from a full one", () => {
    expect(isHtmlEmpty("")).toBe(true);
    expect(isHtmlEmpty("<p>&nbsp;</p>")).toBe(true);
    expect(isHtmlEmpty("<p><br></p>")).toBe(true);
    expect(isHtmlEmpty("<p>Something</p>")).toBe(false);
  });

  it("reads a description as one line", () => {
    expect(
      htmlToText(
        "<h4>Our team</h4><ul><li>A windsurfer</li><li>A coach</li></ul>",
      ),
    ).toBe("Our team A windsurfer A coach");
  });
});
