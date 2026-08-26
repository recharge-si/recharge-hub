import type { ReadinessComponent } from "~/domain/readiness";

/**
 * The shared readiness model, rendered.
 *
 * One component for the home page, guided setup's review step and the settings
 * hub, so the three cannot describe the same shop differently — which they did:
 * home called a shop set up on one rule, the wizard on another.
 *
 * Colour marks exceptions only (docs/ui-conventions.md). A healthy row is a
 * neutral badge and a sentence; a row needing attention is the loud one, and it
 * is the only one that carries a reason and a button. Disabled and optional are
 * not problems and are not coloured.
 */
const TONE: Record<ReadinessComponent["status"], "neutral" | "critical"> = {
  ready: "neutral",
  needs_attention: "critical",
  disabled: "neutral",
  optional: "neutral",
};

const LABEL: Record<ReadinessComponent["status"], string> = {
  ready: "Ready",
  needs_attention: "Needs attention",
  disabled: "Off",
  optional: "Optional",
};

export function ReadinessList({
  components,
  /** Hide the rows that are fine, for a page that only wants the problems. */
  onlyProblems = false,
}: {
  components: ReadinessComponent[];
  onlyProblems?: boolean;
}) {
  const rows = onlyProblems
    ? components.filter((component) => component.status === "needs_attention")
    : components;

  if (rows.length === 0) return null;

  return (
    <s-stack direction="block" gap="base">
      {rows.map((component) => (
        <s-stack key={component.key} direction="block" gap="small-400">
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
            <s-stack direction="block" gap="small-500">
              <s-text type="strong">{component.title}</s-text>
              <s-text color="subdued">{component.summary}</s-text>
            </s-stack>
            <s-badge tone={TONE[component.status]}>
              {LABEL[component.status]}
            </s-badge>
          </s-grid>

          {component.reason ? (
            <s-text
              color="subdued"
              tone={
                component.status === "needs_attention" ? "critical" : "auto"
              }
            >
              {component.reason}
            </s-text>
          ) : null}

          {/*
           * A button only where there is something to do. Every row having one
           * turns the list into a menu, and the point of the list is that the
           * eye lands on the row that needs a person.
           */}
          {component.action &&
          (component.status === "needs_attention" || onlyProblems) ? (
            <s-stack direction="inline">
              <s-button variant="secondary" href={component.action.href}>
                {component.action.label}
              </s-button>
            </s-stack>
          ) : null}
        </s-stack>
      ))}
    </s-stack>
  );
}
