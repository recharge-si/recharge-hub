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

/**
 * A number of minutes as the phrase that follows "every".
 *
 * A schedule is stored in minutes because that is what the field asks for and
 * what the tick compares against, but nobody reads "every 720 minutes". Whole
 * days and whole hours are said as days and hours, and anything else keeps the
 * remainder rather than rounding a merchant's own answer away.
 */
export function formatInterval(minutes: number): string {
  const whole = Math.max(1, Math.round(minutes));

  if (whole % 1440 === 0) {
    const days = whole / 1440;
    return days === 1 ? "day" : `${days} days`;
  }

  if (whole % 60 === 0) {
    const hours = whole / 60;
    return hours === 1 ? "hour" : `${hours} hours`;
  }

  if (whole < 60) return whole === 1 ? "minute" : `${whole} minutes`;

  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${hours} ${hours === 1 ? "hour" : "hours"} ${rest} ${rest === 1 ? "minute" : "minutes"}`;
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}
