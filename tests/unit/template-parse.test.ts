import { describe, expect, it } from "vitest";

import {
  parseTemplate,
  serializeTemplate,
  tokensOf,
} from "~/domain/products/template";

describe("parsing", () => {
  it("reads a field and its filters", () => {
    const { nodes, errors } = parseTemplate('{title|upper|prefix:" - "}');
    expect(errors).toEqual([]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      kind: "token",
      field: "title",
      filters: [
        { name: "upper", args: [] },
        { name: "prefix", args: [" - "] },
      ],
    });
  });

  it("reads a metafield path", () => {
    const { nodes, errors } = parseTemplate("{metafield.specs.length}");
    expect(errors).toEqual([]);
    expect(nodes[0]).toMatchObject({
      kind: "token",
      field: "metafield.specs.length",
    });
  });

  it("keeps a quoted argument containing a colon", () => {
    const { nodes } = parseTemplate('{title|replace:"a:b":"c"}');
    expect(tokensOf(nodes)[0]?.filters[0]?.args).toEqual(["a:b", "c"]);
  });

  it("reads a group", () => {
    const { nodes, errors } = parseTemplate("{title}[ - {options}]");
    expect(errors).toEqual([]);
    expect(nodes).toHaveLength(2);
    expect(nodes[1]).toMatchObject({ kind: "group" });
  });

  it("escapes braces and brackets", () => {
    const { nodes, errors } = parseTemplate("\\{not a token\\}");
    expect(errors).toEqual([]);
    expect(nodes).toEqual([
      expect.objectContaining({ kind: "literal", text: "{not a token}" }),
    ]);
  });
});

describe("parse errors carry a position", () => {
  const cases: { name: string; source: string; code: string }[] = [
    { name: "unclosed token", source: "{title", code: "unclosed_token" },
    { name: "unclosed group", source: "[ {title}", code: "unclosed_group" },
    { name: "empty field", source: "{}", code: "empty_field" },
    { name: "bad field", source: "{ti tle}", code: "bad_field" },
    { name: "unknown filter", source: "{title|shout}", code: "unknown_filter" },
    {
      name: "wrong argument count",
      source: "{title|truncate}",
      code: "bad_filter_args",
    },
    {
      name: "stray closing bracket",
      source: "{title}]",
      code: "unexpected_group_close",
    },
    {
      name: "nested group",
      source: "[{title}[{sku}]]",
      code: "nested_group",
    },
  ];

  for (const { name, source, code } of cases) {
    it(name, () => {
      const { errors } = parseTemplate(source);
      expect(errors.map((error) => error.code)).toContain(code);
      for (const error of errors) {
        expect(error.start).toBeGreaterThanOrEqual(0);
        expect(error.start).toBeLessThanOrEqual(source.length);
        expect(error.length).toBeGreaterThan(0);
        expect(error.message.length).toBeGreaterThan(0);
      }
    });
  }

  it("never throws, whatever it is handed", () => {
    const junk = [
      "",
      "{",
      "}",
      "[",
      "]",
      "{{{{",
      "}}}}",
      "[[[[",
      "{|||}",
      "{a|b:c:d:e}",
      '{a|replace:"unclosed}',
      "\\",
      "\\\\",
      "{title}{",
      "]]{title}[[",
      "{TITLE}",
      "{ title }",
    ];
    for (const source of junk) {
      expect(() => parseTemplate(source)).not.toThrow();
    }
  });
});

/**
 * A seeded generator rather than a property-testing dependency: the brief said
 * no new packages without asking, and a deterministic corpus is also easier to
 * reproduce from a failure than a random seed nobody recorded.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32 — small, deterministic, good enough to shuffle a grammar.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

const FIELDS = [
  "title",
  "options",
  "option1",
  "sku",
  "vendor",
  "metafield.specs.length",
];
const FILTERS: string[] = [
  "",
  "|upper",
  "|lower",
  "|trim",
  "|truncate:12",
  "|first:2",
  "|last:1",
  '|prefix:" - "',
  '|suffix:" cm"',
  '|default:"none"',
  '|replace:"a":"b"',
  '|upper|prefix:" / "',
];
const LITERALS = ["", " ", " - ", " / ", ", ", " (", ") ", "cm", "x", " | "];

function generate(random: () => number, depth = 0): string {
  const pick = <T>(list: T[]): T =>
    list[Math.floor(random() * list.length)] as T;

  const parts: string[] = [];
  const count = 1 + Math.floor(random() * 4);

  for (let index = 0; index < count; index += 1) {
    const roll = random();
    if (roll < 0.5) {
      parts.push(`{${pick(FIELDS)}${pick(FILTERS)}}`);
    } else if (roll < 0.8) {
      parts.push(pick(LITERALS));
    } else if (depth === 0) {
      parts.push(`[${generate(random, depth + 1)}]`);
    } else {
      parts.push(`{${pick(FIELDS)}}`);
    }
  }

  return parts.join("");
}

describe("parse and serialize are inverses", () => {
  it("round-trips a generated corpus", () => {
    const random = makeRandom(0x5eed);
    const failures: string[] = [];

    for (let index = 0; index < 2000; index += 1) {
      const source = generate(random);
      const first = parseTemplate(source);
      const written = serializeTemplate(first.nodes);
      const second = parseTemplate(written);

      // Spans move when the source is normalised, so compare the meaning.
      const meaning = (result: typeof first) =>
        JSON.stringify(result.nodes, (key, value) =>
          key === "start" || key === "length" ? undefined : value,
        );

      if (meaning(first) !== meaning(second)) {
        failures.push(`${source} -> ${written}`);
      }
      // And serialising twice must be a fixed point.
      if (serializeTemplate(second.nodes) !== written) {
        failures.push(`unstable: ${source} -> ${written}`);
      }
    }

    expect(failures.slice(0, 5)).toEqual([]);
  });

  it("round-trips literals that contain syntax characters", () => {
    const source = "\\[100%\\] {title} \\{x\\}";
    const first = parseTemplate(source);
    const written = serializeTemplate(first.nodes);
    expect(parseTemplate(written).nodes).toEqual(first.nodes);
  });
});
