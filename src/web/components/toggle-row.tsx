/**
 * One on-or-off setting: its name and what it does on the left, the switch
 * on the right, the way the admin's own settings pages lay them out.
 *
 * A column of these reads as a list of answers; a column of checkboxes with
 * their descriptions underneath reads as a form. `dependent` indents the
 * row under the one it needs, and a row that cannot work because that one
 * is off is disabled rather than hidden, so the merchant sees what turning
 * the parent on would give them. The switch carries the label for
 * assistive technology; the visible text beside it is the same words.
 */
export function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled = false,
  dependent = false,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  dependent?: boolean;
}) {
  return (
    <s-box {...(dependent ? { paddingInlineStart: "large" } : {})}>
      <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="start">
        <s-stack direction="block" gap="small-500">
          <s-text {...(disabled ? { color: "subdued" } : { type: "strong" })}>
            {label}
          </s-text>
          {description ? <s-text color="subdued">{description}</s-text> : null}
        </s-stack>
        <s-switch
          label={label}
          labelAccessibilityVisibility="exclusive"
          checked={checked}
          onChange={(event) => onChange(event.currentTarget.checked)}
          {...(disabled ? { disabled: true } : {})}
        />
      </s-grid>
    </s-box>
  );
}
