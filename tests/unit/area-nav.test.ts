import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AreaNav } from "~/web/components/area-nav";

const items = [
  { key: "a", label: "Alpha", href: "/app/a" },
  { key: "b", label: "Beta", href: "/app/b" },
  { key: "c", label: "Gamma", href: "/app/c" },
];

describe("AreaNav", () => {
  for (const current of ["a", "b", "c"])
    it(`marks only ${current} as the current page`, () => {
      const html = renderToStaticMarkup(
        createElement(AreaNav, { items, current, label: "Test sections" }),
      );
      expect(html.match(/aria-current="page"/g)).toHaveLength(1);
      const label = items.find((i) => i.key === current)!.label;
      expect(html).toMatch(new RegExp(`aria-current="page"[^>]*>${label}<`));
      // The others are links with an address, reachable by keyboard.
      expect(html.match(/href="\/app\//g)).toHaveLength(2);
    });
});
