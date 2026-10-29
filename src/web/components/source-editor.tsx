import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useFetcher } from "react-router";

import type { Field, Source } from "~/domain/export-portal/contract";
import {
  PortalField,
  initialFieldState,
  type FieldState,
} from "~/web/components/portal-fields";
import {
  Card,
  CardHeading,
  FactList,
  type FactRow,
} from "~/web/components/source-overview";
import {
  SOURCE_ROUTES,
  displayFieldValue,
  leadingSwitch,
  shortLabel,
  type SourceActionResult,
} from "~/web/lib/sources";

/**
 * One part of a source, edited (docs/sources.md § Screens).
 *
 * The source is stated in cards and changed in none of them; each group
 * of settings is edited on its own, in a dialog on the source's page or
 * as a view inside the source dialog on the list. Both are the same
 * editor: it opens with what the portal holds, saves only when something
 * differs, posts only the fields it showed — so the action leaves every
 * other group alone — and is done only once the portal has accepted. A
 * refusal stays with the fields, against the one it names. Leaving
 * without saving discards what was typed.
 *
 * The editor has its own fetcher, so a refusal in one group is never
 * shown in another and the page's own actions do not mix with it.
 */
export interface SourceEdit {
  name: string;
  setName: (name: string) => void;
  state: FieldState;
  setField: (key: string, value: string) => void;
  dirty: boolean;
  busy: boolean;
  /** The reply to this editor's last save, until the editor is reset. */
  result: SourceActionResult | undefined;
  errors: Record<string, string>;
  save: () => void;
  reset: () => void;
}

export function useSourceEdit(
  source: Source,
  fields: readonly Field[],
  editName: boolean,
  onSaved: (message: string) => void,
): SourceEdit {
  const fetcher = useFetcher<SourceActionResult>();
  /** A save was sent since the last reset; a reply is expected. */
  const submitted = useRef(false);

  const [name, setName] = useState(source.name);
  const [state, setState] = useState<FieldState>(() =>
    initialFieldState(fields, source.values),
  );

  const busy = fetcher.state !== "idle";
  const result = submitted.current ? fetcher.data : undefined;
  const errors = result && !result.ok ? (result.fieldErrors ?? {}) : {};

  const dirty =
    (editName && name !== source.name) ||
    JSON.stringify(state) !==
      JSON.stringify(initialFieldState(fields, source.values));

  // Done by the reply, never before it: the page has been revalidated
  // by then, so what it states is what was saved.
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  useEffect(() => {
    if (fetcher.state !== "idle" || !submitted.current) return;
    if (!fetcher.data?.ok) return;
    submitted.current = false;
    onSavedRef.current(fetcher.data.message);
  }, [fetcher.state, fetcher.data]);

  return {
    name,
    setName,
    state,
    setField: (key, value) =>
      setState((current) => ({ ...current, [key]: value })),
    dirty,
    busy,
    result,
    errors,
    save: () => {
      submitted.current = true;
      const body: Record<string, string> = { intent: "save" };
      if (editName) body.name = name;
      for (const field of fields) body[field.key] = state[field.key] ?? "";
      void fetcher.submit(body, {
        method: "post",
        action: SOURCE_ROUTES.source(source.id),
      });
    },
    reset: () => {
      setName(source.name);
      setState(initialFieldState(fields, source.values));
      submitted.current = false;
    },
  };
}

const NAME_HELP = "How the source is listed here and in the export portal.";

/**
 * A switch as one row across the card: its state where the box goes, then
 * its name and what it does. Read, the state is a mark (a filled tick, or
 * an empty circle); edited, the design system's own checkbox stands in
 * the same place with the same name and help, so its name toggles it and
 * Edit moves nothing. The help keeps a reading measure, not the card's.
 */
function SwitchRow({
  field,
  on,
  control,
}: {
  field: Field;
  on: boolean;
  control: ReactNode | null;
}) {
  return (
    <s-box maxInlineSize="640px">
      {control ?? (
        <s-grid
          gridTemplateColumns="auto 1fr"
          gap="small-300"
          alignItems="start"
        >
          <s-icon
            type={on ? "check-circle-filled" : "circle"}
            tone="neutral"
          />
          <s-stack direction="block" gap="small-500">
            <s-text>
              {field.label}
              <s-text accessibilityVisibility="exclusive">
                {on ? ", on" : ", off"}
              </s-text>
            </s-text>
            {field.help ? <s-text color="subdued">{field.help}</s-text> : null}
          </s-stack>
        </s-grid>
      )}
    </s-box>
  );
}

/**
 * A group of settings as rows, read or edited: each field's name with the
 * portal's help under it, and beside it its value — or, editing, its
 * control in the same place. Every field has its row in both states and
 * the same order, so Edit changes what is in the value column and nothing
 * else: the card does not grow, shrink or reflow.
 *
 * A group led by a switch (`leadingSwitch`: "Round shelf prices", then
 * its settings) states only the switch while it is off, read or edited;
 * turning it on in the editor opens its settings.
 */
function SettingRows({
  source,
  fields,
  facts,
  edit,
  editing,
  editName,
}: {
  source: Source;
  fields: readonly Field[];
  facts: Array<{ label: string; value: string; subdued: boolean }> | undefined;
  edit: SourceEdit;
  editing: boolean;
  editName: boolean;
}) {
  const leader = leadingSwitch(fields);
  const leaderOn = leader
    ? editing
      ? edit.state[leader.key] === "true"
      : displayFieldValue(leader, source.values).text === "On"
    : true;
  const shown = leader && !leaderOn ? [leader] : fields;

  const rows: FactRow[] = [
    ...(facts ?? []).map((fact, index): FactRow => {
      // The first fact of the details card is the name, the one it edits.
      const isName = editName && index === 0;
      return {
        key: fact.label,
        label: fact.label,
        help: isName ? NAME_HELP : null,
        subdued: fact.subdued,
        value:
          isName && editing ? (
            <s-box maxInlineSize="520px">
              <s-text-field
                name="name"
                label="Name"
                labelAccessibilityVisibility="exclusive"
                value={edit.name}
                onChange={(e) => edit.setName(e.currentTarget.value)}
                {...(edit.errors.name ? { error: edit.errors.name } : {})}
                {...(edit.busy ? { disabled: true } : {})}
              />
            </s-box>
          ) : (
            fact.value
          ),
      };
    }),
    ...shown.map((field): FactRow => {
      if (field.type === "boolean")
        return {
          key: field.key,
          label: field.label,
          wide: true,
          value: (
            <SwitchRow
              field={field}
              on={
                editing
                  ? edit.state[field.key] === "true"
                  : displayFieldValue(field, source.values).text === "On"
              }
              control={
                editing ? (
                  <PortalField
                    field={field}
                    stored={source.values[field.key] ?? null}
                    value={edit.state[field.key] ?? ""}
                    error={edit.errors[field.key]}
                    onChange={(value) => edit.setField(field.key, value)}
                    disabled={edit.busy}
                  />
                ) : null
              }
            />
          ),
        };
      // A pattern is edited the way the MetaKocka name is: its label over
      // an editor as wide as the card, the preview under it.
      if (editing && field.tokens && field.tokens.length > 0)
        return {
          key: field.key,
          label: field.label,
          wide: true,
          value: (
            <PortalField
              field={field}
              stored={source.values[field.key] ?? null}
              value={edit.state[field.key] ?? ""}
              error={edit.errors[field.key]}
              onChange={(value) => edit.setField(field.key, value)}
              disabled={edit.busy}
            />
          ),
        };
      if (editing)
        return {
          key: field.key,
          label: field.label,
          help: field.help,
          value: (
            <PortalField
              field={field}
              stored={source.values[field.key] ?? null}
              value={edit.state[field.key] ?? ""}
              error={edit.errors[field.key]}
              onChange={(value) => edit.setField(field.key, value)}
              disabled={edit.busy}
              bare
            />
          ),
        };
      const read = displayFieldValue(field, source.values);
      return {
        key: field.key,
        label: field.label,
        help: field.help,
        value: read.text,
        subdued: !read.set,
      };
    }),
  ];

  if (rows.length === 0)
    return <s-text color="subdued">Nothing to configure.</s-text>;
  return <FactList rows={rows} />;
}

/**
 * What the portal says about each field of a group, gathered behind the
 * card's help button: the field's help (also on its row), and for a
 * choice each option with its explanation, which a row has no room for.
 * Help the portal did not give is not invented.
 */
function GroupHelp({
  id,
  heading,
  fields,
}: {
  id: string;
  heading: string;
  fields: readonly Field[];
}) {
  const explained = fields.filter(
    (field) =>
      field.help ||
      (field.options ?? []).some((o) => shortLabel(o.label) !== o.label),
  );
  return (
    <s-modal id={id} heading={heading}>
      <s-stack direction="block" gap="base">
        {explained.length === 0 ? (
          <s-text color="subdued">
            The export portal gives no further explanation for these settings.
          </s-text>
        ) : (
          explained.map((field) => (
            <s-stack key={field.key} direction="block" gap="small-500">
              <s-text type="strong">{field.label}</s-text>
              {field.help ? <s-text>{field.help}</s-text> : null}
              {(field.options ?? []).some(
                (o) => shortLabel(o.label) !== o.label,
              ) ? (
                <s-unordered-list>
                  {(field.options ?? []).map((option) => (
                    <s-list-item key={option.value}>{option.label}</s-list-item>
                  ))}
                </s-unordered-list>
              ) : null}
            </s-stack>
          ))
        )}
      </s-stack>
      <s-button
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

/**
 * A group of settings as one card: what the portal holds, and — after
 * Edit — the same group as fields in the card itself, with Save and
 * Cancel. Nothing leaves the page; the card is the editor. Saving sends
 * only this group's fields. The one dialog is help, opened from the
 * card's question mark.
 */
export function EditableCard({
  heading,
  source,
  fields,
  editName = false,
  facts,
  disabled,
}: {
  heading: string;
  source: Source;
  fields: readonly Field[];
  editName?: boolean;
  /** What to state instead of the fields' values, for the name card. */
  facts?: Array<{ label: string; value: string; subdued: boolean }>;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const edit = useSourceEdit(source, fields, editName, (message) => {
    setEditing(false);
    if (typeof shopify !== "undefined") shopify.toast.show(message);
  });
  // An id attribute cannot hold the colons React puts in a generated id.
  const helpId = `help-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  // Each field's help is on its row; the dialog is for what a row cannot
  // hold: what each choice of a select means.
  const hasHelp = fields.some((field) =>
    (field.options ?? []).some((o) => shortLabel(o.label) !== o.label),
  );

  return (
    <Card label={heading}>
      <GroupHelp id={helpId} heading={heading} fields={fields} />
      <s-stack direction="block" gap="base">
        <CardHeading
          heading={heading}
          action={
            <s-stack direction="inline" gap="small-200" alignItems="center">
              {hasHelp ? (
                <s-button
                  variant="secondary"
                  icon="question-circle"
                  accessibilityLabel={`About ${heading.toLowerCase()}`}
                  command="--show"
                  commandFor={helpId}
                />
              ) : null}
              {editing ? null : (
                <s-button
                  variant="secondary"
                  accessibilityLabel={`Edit ${heading.toLowerCase()}`}
                  onClick={() => {
                    edit.reset();
                    setEditing(true);
                  }}
                  {...(disabled ? { disabled: true } : {})}
                >
                  Edit
                </s-button>
              )}
            </s-stack>
          }
        />
        {editing && edit.result && !edit.result.ok ? (
          <s-banner tone="critical" heading="That did not save">
            <s-paragraph>{edit.result.message}</s-paragraph>
          </s-banner>
        ) : null}
        <SettingRows
          source={source}
          fields={fields}
          facts={facts}
          edit={edit}
          editing={editing}
          editName={editName}
        />
        {editing ? (
          <s-stack direction="inline" gap="small-300" justifyContent="end">
            <s-button
              onClick={() => {
                edit.reset();
                setEditing(false);
              }}
              {...(edit.busy ? { disabled: true } : {})}
            >
              Cancel
            </s-button>
            <s-button
              variant="primary"
              onClick={edit.save}
              {...(!edit.dirty || edit.busy ? { disabled: true } : {})}
              {...(edit.busy ? { loading: true } : {})}
            >
              Save
            </s-button>
          </s-stack>
        ) : null}
      </s-stack>
    </Card>
  );
}
