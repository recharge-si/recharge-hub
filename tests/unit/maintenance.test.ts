import { describe, expect, it } from "vitest";

import { maintenanceNotice } from "~/web/lib/maintenance";

/** What the banner above every page shows for each banner.json answer. */
describe("maintenance notice", () => {
  it("shows nothing when no maintenance is on", () => {
    expect(maintenanceNotice({ active: false })).toBeNull();
  });

  it("warns about planned maintenance", () => {
    expect(
      maintenanceNotice({
        active: true,
        level: "planned",
        text: "Planned maintenance Mon 26 Oct, 22:00–22:30: DB move",
      }),
    ).toEqual({
      tone: "warning",
      text: "Planned maintenance Mon 26 Oct, 22:00–22:30: DB move",
    });
  });

  it("is critical while maintenance runs or a site is down", () => {
    expect(
      maintenanceNotice({ active: true, level: "now", text: "a" })?.tone,
    ).toBe("critical");
    expect(
      maintenanceNotice({ active: true, level: "down", text: "b" })?.tone,
    ).toBe("critical");
  });

  it("shows nothing for an answer it does not understand", () => {
    expect(maintenanceNotice(null)).toBeNull();
    expect(maintenanceNotice("<html>")).toBeNull();
    expect(maintenanceNotice({ active: true })).toBeNull();
    expect(
      maintenanceNotice({ active: true, level: "other", text: "x" }),
    ).toBeNull();
  });
});
