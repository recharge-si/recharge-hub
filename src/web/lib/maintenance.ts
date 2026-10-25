import { z } from "zod";

/**
 * The maintenance notices every t4a app shows, set from Slack with
 * `/maintenance` or from maintenance.time-4-action.com/admin
 * (time-4-action/t4a-maintenance). `?app=hub` returns the ones for every app
 * plus the ones aimed at this one. The file is public and cached for a
 * minute; each text arrives ready to show.
 */
export const MAINTENANCE_BANNER_URL =
  "https://maintenance.time-4-action.com/banner.json?app=hub";

/** More than this many strips would push the page out of view. */
export const MAX_MAINTENANCE_NOTICES = 3;

const bannerSchema = z.object({
  items: z.array(
    z.object({
      id: z.union([z.number(), z.string()]),
      level: z.enum(["planned", "now", "down"]),
      text: z.string().min(1),
    }),
  ),
});

export type MaintenanceNotice = {
  id: string;
  tone: "warning" | "critical";
  text: string;
};

/** What to show for a banner.json body, most urgent first; empty for nothing. */
export function maintenanceNotices(body: unknown): MaintenanceNotice[] {
  const parsed = bannerSchema.safeParse(body);
  if (!parsed.success) return [];
  return parsed.data.items.slice(0, MAX_MAINTENANCE_NOTICES).map((item) => ({
    id: String(item.id),
    tone: item.level === "planned" ? "warning" : "critical",
    text: item.text,
  }));
}
