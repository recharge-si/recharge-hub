import type { ReadinessComponent } from "~/domain/readiness";

/**
 * The one banner for a shop that has not pressed Finish setup, shared by Home
 * and the settings hub so they cannot say two different things.
 *
 * It used to say "nothing is written to MetaKocka" whatever the state of the
 * configuration — true, but it read as an alarm on a shop where every
 * required answer was in and the only things not running were the ones the
 * merchant had switched off. So the banner now says what is actually the
 * case: either something still needs answering, named, or everything required
 * is ready and one press starts it, with what stays off said in passing
 * rather than as a warning.
 *
 * Nothing here decides anything: readiness is `domain/readiness`, and
 * `activated` is `shop.setup_completed_at` (docs/ui-conventions.md § Setup
 * state).
 */
export function SetupBanner({
  components,
  overall,
}: {
  components: ReadinessComponent[];
  overall: "ready" | "needs_attention";
}) {
  const missing = components.filter(
    (component) => component.required && component.status === "needs_attention",
  );
  const off = components.filter((component) => component.status === "disabled");

  if (overall === "needs_attention" && missing.length > 0) {
    return (
      <s-banner tone="warning" heading="Setup is not finished">
        <s-paragraph>
          {`${list(missing.map((component) => component.title))} ${missing.length === 1 ? "needs" : "need"} answering before synchronization can start. Whatever you have already answered is saved.`}
        </s-paragraph>
        <s-link slot="primary-action" href="/app/setup">
          Finish setup
        </s-link>
      </s-banner>
    );
  }

  return (
    <s-banner tone="info" heading="Ready to start">
      <s-paragraph>
        {`Everything required is in. Finish setup to start synchronizing.${
          off.length > 0
            ? ` ${list(off.map((component) => component.title))} ${off.length === 1 ? "is" : "are"} switched off and ${off.length === 1 ? "stays" : "stay"} off.`
            : ""
        }`}
      </s-paragraph>
      <s-link slot="primary-action" href="/app/setup">
        Finish setup
      </s-link>
    </s-banner>
  );
}

function list(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
