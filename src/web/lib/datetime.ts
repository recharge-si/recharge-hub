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
