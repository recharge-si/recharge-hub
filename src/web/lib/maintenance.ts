import { z } from "zod";

/**
 * The maintenance notice every t4a app shows, set from Slack with
 * `/maintenance` (time-4-action/t4a-infra, servers/t4a/README.md). The file
 * is public and cached for a minute; the text arrives ready to show.
 */
export const MAINTENANCE_BANNER_URL =
  "https://maintenance.time-4-action.com/banner.json";

const bannerSchema = z.object({
  active: z.boolean(),
  level: z.enum(["planned", "now", "down"]).optional(),
  text: z.string().optional(),
});

export type MaintenanceNotice = { tone: "warning" | "critical"; text: string };

/** What to show for a banner.json body, or null for nothing. */
export function maintenanceNotice(body: unknown): MaintenanceNotice | null {
  const parsed = bannerSchema.safeParse(body);
  if (!parsed.success || !parsed.data.active || !parsed.data.text) return null;
  return {
    tone: parsed.data.level === "planned" ? "warning" : "critical",
    text: parsed.data.text,
  };
}
