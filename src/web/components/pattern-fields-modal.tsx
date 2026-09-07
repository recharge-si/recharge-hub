import type { PickerGroup } from "~/domain/products/template";

/**
 * What a pattern can be built from, for a merchant who does not yet know there
 * is anything to type.
 *
 * The list under the field is the fast way in, but it only appears once they
 * have started typing — which is no help at all before they have. This is the
 * same list, in full, behind a button: every field, grouped, each showing what
 * it comes to for one real record of theirs.
 *
 * Shared by both patterns a merchant edits, because "how do I find out what I
 * can put in here" has one answer in this app and it should look the same
 * wherever it is asked.
 */
export interface PatternFieldsModalProps {
  id: string;
  /** "What you can put in a name", "What you can put in a reference". */
  heading: string;
  /** What the fields resolve against, in the merchant's own words. */
  resolvedAgainst: string;
  groups: PickerGroup[];
}

export function PatternFieldsModal({
  id,
  heading,
  resolvedAgainst,
  groups,
}: PatternFieldsModalProps) {
  return (
    <s-modal id={id} heading={heading}>
      <s-stack direction="block" gap="base">
        <s-paragraph>
          Start typing any of these and it will offer itself — there is no
          syntax to learn. Each one shows what it comes to for {resolvedAgainst}.
        </s-paragraph>

        {groups.map((group) => (
          <s-stack key={group.id} direction="block" gap="none">
            <s-box paddingBlock="small-300">
              <s-text color="subdued" type="strong">
                {group.label}
              </s-text>
            </s-box>
            {group.rows.map((row) => (
              <s-box key={row.field.id} paddingBlock="small-400">
                <s-grid
                  gridTemplateColumns="1fr auto"
                  gap="base"
                  alignItems="center"
                >
                  <s-text>{row.field.label}</s-text>
                  {/*
                   * Null is "there is nothing here to resolve against" — an
                   * empty catalogue, a shop with no orders, a field this app
                   * keeps nothing for. Empty is "this record has none". They
                   * are different answers and neither is a made-up example.
                   */}
                  <s-text color="subdued">
                    {row.value === null
                      ? ""
                      : row.value === ""
                        ? "empty here"
                        : row.value}
                  </s-text>
                </s-grid>
              </s-box>
            ))}
          </s-stack>
        ))}
      </s-stack>
      {/*
       * `type="button"` because guided setup renders this inside a real
       * `<Form>`: a button with no type in a form is a submit button, and
       * closing a modal is not submitting a setup step.
       */}
      <s-button
        type="button"
        slot="primary-action"
        variant="primary"
        command="--hide"
        commandFor={id}
      >
        Close
      </s-button>
    </s-modal>
  );
}
