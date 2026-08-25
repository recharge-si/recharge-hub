/**
 * One date format for the whole admin, so two screens never disagree about
 * what a timestamp looks like.
 *
 * The locale is the viewer's, which is what a merchant expects of a date in
 * their own admin.
 */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * The same timestamp, shortened for a table cell.
 *
 * A column of "25 Aug 2026, 06:29" is mostly repetition: every row on an orders
 * page was received in the last few days, so the date is the least informative
 * part of it. This drops what the reader can infer — today and yesterday become
 * words, and the year is only printed once it is not this one — which is what
 * makes a dense list scannable.
 *
 * `formatDateTime` stays the format everywhere a timestamp is stated on its own
 * rather than repeated down a column, so the two never disagree about a date
 * they both show: this is the short form of that, not a second opinion.
 *
 * `now` is injected so the boundaries can be tested.
 */
export function formatListDateTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString(undefined, { timeStyle: "short" });

  // Rounded, not floored: a day that spans a daylight-saving change is 23 or
  // 25 hours long, and flooring turns yesterday into "Today" twice a year.
  const daysAgo = Math.round(
    (startOfDay(now).getTime() - startOfDay(at).getTime()) / 86_400_000,
  );

  if (daysAgo === 0) return `Today at ${time}`;
  if (daysAgo === 1) return `Yesterday at ${time}`;

  const sameYear = at.getFullYear() === now.getFullYear();
  const date = at.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });

  return `${date} at ${time}`;
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}
