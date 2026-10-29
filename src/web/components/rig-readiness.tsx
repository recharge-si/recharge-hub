import { readinessText, type ReadinessLine } from "~/web/lib/rig-readiness";

/**
 * Rig readiness (docs/attributes.md, Rig readiness): one line per rig type
 * saying how many products have what the rig builder needs. Plain text, no
 * badge and no colour; a type with something missing links to exactly the
 * products that lack it.
 */
export function RigReadiness({ lines }: { lines: readonly ReadinessLine[] }) {
  return (
    <s-section heading="Rig readiness">
      <s-stack direction="block" gap="small-300">
        {lines.map((line) => (
          <s-grid
            key={line.type}
            gridTemplateColumns="140px 1fr auto"
            gap="small-300"
            alignItems="center"
          >
            <s-text type="strong">{line.name}</s-text>
            <s-text color="subdued">{readinessText(line)}</s-text>
            {line.href ? (
              <s-link href={line.href}>{`Show the ${line.incomplete}`}</s-link>
            ) : (
              <span />
            )}
          </s-grid>
        ))}
      </s-stack>
    </s-section>
  );
}
