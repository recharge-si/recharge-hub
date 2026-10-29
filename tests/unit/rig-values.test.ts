import { describe, expect, it } from "vitest";

import {
  carbonPercentFromTitle,
  finLengthFromText,
  mastDiameterFromTitle,
  mastLengthFromText,
  sailAreaFromText,
} from "~/domain/rig/derive";
import { ENGINE_KEYS, KEYS, placementGaps } from "~/domain/rig/keys";
import { readCode, readList, readNumber } from "~/domain/rig/values";

/*
 * The shapes below are the ones stored on the production store (samples in
 * docs/rig-builder.md, "Stored formats"): numbers as text, measurements as a
 * JSON string with a unit, lists as a JSON array string.
 */

const decimal = (value: string) => ({ type: "number_decimal", value });
const dimension = (value: number, unit: string) => ({
  type: "dimension",
  value: JSON.stringify({ value, unit }),
});

describe("readNumber", () => {
  it("reads number_decimal text", () => {
    expect(readNumber(decimal("5.0"), "m2")).toBe(5);
    expect(readNumber(decimal("4.5"))).toBe(4.5);
    expect(readNumber(decimal("100.0"))).toBe(100);
  });

  it("reads a dimension by its unit", () => {
    expect(readNumber(dimension(37, "CENTIMETERS"), "cm")).toBe(37);
    expect(readNumber(dimension(1.9, "METERS"), "cm")).toBe(190);
    expect(readNumber(dimension(370, "MILLIMETERS"), "cm")).toBe(37);
    expect(readNumber({ type: "weight", value: '{"value":82.0,"unit":"KILOGRAMS"}' }, "kg")).toBe(82);
    expect(readNumber({ type: "volume", value: '{"value":105.0,"unit":"LITERS"}' }, "l")).toBe(105);
  });

  it("does not guess a unit it does not know, or one that does not fit", () => {
    expect(readNumber(dimension(37, "FURLONGS"), "cm")).toBeNull();
    expect(readNumber(dimension(37, "KILOGRAMS"), "cm")).toBeNull();
    expect(readNumber({ type: "dimension", value: '{"value":37.0}' }, "cm")).toBeNull();
  });

  it("answers null for nothing, text that is not a number, and broken JSON", () => {
    expect(readNumber(undefined, "cm")).toBeNull();
    expect(readNumber(decimal(""), "cm")).toBeNull();
    expect(readNumber(decimal("big"), "cm")).toBeNull();
    expect(readNumber({ type: "dimension", value: "{oops" }, "cm")).toBeNull();
    expect(readNumber({ type: "dimension", value: '{"value":"x","unit":"CENTIMETERS"}' }, "cm")).toBeNull();
  });
});

describe("readCode and readList", () => {
  it("reads a single code lower-cased", () => {
    expect(readCode({ type: "single_line_text_field", value: "power_box" })).toBe("power_box");
    expect(readCode({ type: "single_line_text_field", value: " RDM " })).toBe("rdm");
    expect(readCode({ type: "single_line_text_field", value: "" })).toBeNull();
  });

  it("does not read a list as a single code", () => {
    expect(readCode({ type: "list.single_line_text_field", value: '["rdm","sdm"]' })).toBeNull();
  });

  it("reads the stored JSON array, sorted, without repeats", () => {
    expect(readList({ type: "list.single_line_text_field", value: '["rdm","sdm"]' })).toEqual(["rdm", "sdm"]);
    expect(readList({ type: "list.single_line_text_field", value: '["us_box","deep_tuttle","us_box"]' })).toEqual([
      "deep_tuttle",
      "us_box",
    ]);
    expect(readList({ type: "list.single_line_text_field", value: '["power_box"]' })).toEqual(["power_box"]);
  });

  it("takes a bare code as a list of one and nothing as no data", () => {
    expect(readList({ type: "single_line_text_field", value: "rdm" })).toEqual(["rdm"]);
    expect(readList({ type: "list.single_line_text_field", value: "[]" })).toBeNull();
    expect(readList({ type: "list.single_line_text_field", value: "[1,2]" })).toBeNull();
    expect(readList({ type: "list.single_line_text_field", value: "[oops" })).toBeNull();
    expect(readList(undefined)).toBeNull();
  });
});

describe("derivations", () => {
  it("reads a mast length from the Size option, 370 to 520 only", () => {
    expect(mastLengthFromText(["490"])).toBe(490);
    expect(mastLengthFromText(["472"])).toBe(472);
    expect(mastLengthFromText(["460 cm"])).toBe(460);
    expect(mastLengthFromText(["369"])).toBeNull();
    expect(mastLengthFromText(["521"])).toBeNull();
    expect(mastLengthFromText(["Standard"])).toBeNull();
    expect(mastLengthFromText(["5.8 m2 / Orange"])).toBeNull();
  });

  it("reads a sail area from option text", () => {
    expect(sailAreaFromText(["5.8 m2 / Orange"])).toBe(5.8);
    expect(sailAreaFromText(["2.5 m2 / Light Green"])).toBe(2.5);
    expect(sailAreaFromText(["4,0 m² / Pink"])).toBe(4);
    expect(sailAreaFromText(["One size"])).toBeNull();
    expect(sailAreaFromText(["58 m2"])).toBeNull();
  });

  it("reads a fin length in millimetres, or in cm when the text says so", () => {
    expect(finLengthFromText(["440"])).toBe(44);
    expect(finLengthFromText(["460"])).toBe(46);
    expect(finLengthFromText(["36 cm Power Box"])).toBe(36);
    expect(finLengthFromText(["36 cm Tuttle Box"])).toBe(36);
    expect(finLengthFromText(["36"])).toBe(36);
    expect(finLengthFromText(["900"])).toBeNull();
    expect(finLengthFromText(["12"])).toBeNull();
  });

  it("reads RDM or SDM and the carbon percent from a mast title", () => {
    const hd = "Unifiber - HD RDM C75 Constant FL Curve Incl. Mastbag";
    expect(mastDiameterFromTitle(hd)).toBe("rdm");
    expect(carbonPercentFromTitle(hd)).toBe(75);
    const elite = "Unifiber - Elite SDM C100 Constant FL Curve Incl. Mastbag";
    expect(mastDiameterFromTitle(elite)).toBe("sdm");
    expect(carbonPercentFromTitle(elite)).toBe(100);
    expect(mastDiameterFromTitle("Unifiber - Mast Epoxy SDM")).toBe("sdm");
    expect(carbonPercentFromTitle("Unifiber - Mast Epoxy SDM")).toBeNull();
    expect(mastDiameterFromTitle("RDM and SDM adapter")).toBeNull();
    expect(mastDiameterFromTitle("Universal Mast")).toBeNull();
  });
});

describe("keys", () => {
  it("lists only the store keys, not the old rig pack ones", () => {
    expect(ENGINE_KEYS).toContain("canopy_area");
    expect(ENGINE_KEYS).toContain("fin_box_types");
    expect(ENGINE_KEYS).not.toContain("sail_area_m2");
    expect(ENGINE_KEYS).not.toContain("board_fin_box");
  });

  it("says what each role needs to be placed", () => {
    expect(placementGaps("sail", {})).toEqual([KEYS.canopyArea]);
    expect(placementGaps("sail", { areaM2: 5.8 })).toEqual([]);
    expect(placementGaps("mast", { lengthCm: 460 })).toEqual([KEYS.mastDiameter]);
    expect(placementGaps("boom", { boomMinCm: 150 })).toEqual([KEYS.boomMaxCm]);
    expect(placementGaps("fin", {})).toEqual([KEYS.finBox]);
    // A board needs a volume or a sail range, and its fin boxes.
    expect(placementGaps("board", {})).toEqual([KEYS.volumeL, KEYS.finBoxTypes]);
    expect(placementGaps("board", { sailMinM2: 4, sailMaxM2: 6, finBoxTypes: ["tuttle"] })).toEqual([]);
    expect(placementGaps("board", { volumeL: 100, finBoxTypes: ["tuttle"] })).toEqual([]);
    expect(placementGaps("base", {})).toEqual([]);
  });
});
