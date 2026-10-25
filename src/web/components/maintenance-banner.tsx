import { useEffect, useState } from "react";

import {
  MAINTENANCE_BANNER_URL,
  maintenanceNotices,
  type MaintenanceNotice,
} from "~/web/lib/maintenance";

const POLL_MS = 60_000;

/**
 * Announced or running maintenance, above every page: one banner per
 * maintenance, at most three. Read in the browser only, so no page load
 * waits on it; a failed read shows nothing.
 */
export function MaintenanceBanner() {
  const [notices, setNotices] = useState<MaintenanceNotice[]>([]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch(MAINTENANCE_BANNER_URL);
        const body: unknown = response.ok ? await response.json() : null;
        if (alive) setNotices(maintenanceNotices(body));
      } catch {
        if (alive) setNotices([]);
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <>
      {notices.map((notice) => (
        <s-banner key={notice.id} tone={notice.tone}>
          <s-paragraph>{notice.text}</s-paragraph>
        </s-banner>
      ))}
    </>
  );
}
