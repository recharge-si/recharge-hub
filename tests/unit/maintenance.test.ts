import { describe, expect, it } from "vitest";

import {
  MAINTENANCE_BANNER_URL,
  maintenanceNotices,
} from "~/web/lib/maintenance";

/** What the banners above every page show for each banner.json answer. */
const item = (id: number, level: string, text = `notice ${id}`) => ({
  id,
  level,
  text,
  startsAt: "2026-10-26T21:00:00.000Z",
  endsAt: "2026-10-26T21:30:00.000Z",
});

describe("maintenance notices", () => {
  it("asks for the maintenances aimed at this app", () => {
    expect(new URL(MAINTENANCE_BANNER_URL).searchParams.get("app")).toBe("hub");
  });

  it("shows nothing when no maintenance is on", () => {
    expect(maintenanceNotices({ active: false, items: [] })).toEqual([]);
  });

  it("warns about planned maintenance and is critical while one runs", () => {
    expect(
      maintenanceNotices({
        active: true,
        items: [
          item(2, "down", "Moving servers"),
          item(1, "planned", "DB move"),
        ],
      }),
    ).toEqual([
      { id: "2", tone: "critical", text: "Moving servers" },
      { id: "1", tone: "warning", text: "DB move" },
    ]);
    expect(maintenanceNotices({ items: [item(3, "now")] })[0]?.tone).toBe(
      "critical",
    );
  });

  it("shows at most three, in the order given", () => {
    const notices = maintenanceNotices({
      items: [1, 2, 3, 4].map((id) => item(id, "planned")),
    });

    expect(notices.map((notice) => notice.id)).toEqual(["1", "2", "3"]);
  });

  it("shows nothing for an answer it does not understand", () => {
    expect(maintenanceNotices(null)).toEqual([]);
    expect(maintenanceNotices("<html>")).toEqual([]);
    expect(maintenanceNotices({ active: true, text: "old shape" })).toEqual([]);
    expect(maintenanceNotices({ items: [item(1, "other")] })).toEqual([]);
  });
});
