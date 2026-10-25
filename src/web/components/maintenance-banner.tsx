import { useEffect, useState } from "react";

import {
  MAINTENANCE_BANNER_URL,
  maintenanceNotice,
  type MaintenanceNotice,
} from "~/web/lib/maintenance";

const POLL_MS = 60_000;

/**
 * Announced or running maintenance, above every page. Read in the browser
 * only, so no page load waits on it; a failed read shows nothing.
 */
export function MaintenanceBanner() {
  const [notice, setNotice] = useState<MaintenanceNotice | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch(MAINTENANCE_BANNER_URL);
        const body: unknown = response.ok ? await response.json() : null;
        if (alive) setNotice(maintenanceNotice(body));
      } catch {
        if (alive) setNotice(null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (!notice) return null;
  return (
    <s-banner tone={notice.tone}>
      <s-paragraph>{notice.text}</s-paragraph>
    </s-banner>
  );
}
