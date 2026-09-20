import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";

import {
  KEY_PATTERN,
  isSelect,
  keyFor,
  slugify,
  type DataType,
  type Implementation,
  type Scope,
} from "~/domain/attributes/types";
import { Advanced } from "~/web/components/advanced";
import { Dropdown } from "~/web/components/dropdown";
import {
  DATA_TYPE_HELP,
  DATA_TYPE_OPTIONS,
  IMPLEMENTATION_LABEL,
  IMPLEMENTATION_OPTIONS,
  PRODUCT_SETUP_ROUTES,
  SCOPE_OPTIONS,
  takesUnit,
} from "~/web/lib/attributes";

/**
 * One attribute form, used to create and to edit (docs/attributes.md
 * § Screens). The fields follow the format: a measurement asks for its
 * unit, a choice asks for its options, and nothing asks for what it cannot
 * use. Names, keys and codes are the merchant's; the only thing generated is
 * a first suggestion for the Shopify field, made once from the name and
 * never touched again.
 */

export interface OptionRow {
  key: string;
  code: string;
  en: string;
  si: string;
}

export interface AttributeFormValue {
  name: string;
  dataType: DataType;
  unit: string;
  description: string;
  scope: Scope;
  requiredDefault: boolean;
  filterable: boolean;
  searchable: boolean;
  comparable: boolean;
  key: string;
  setId: string;
  implementation: Implementation;
  options: OptionRow[];
}

export function blankAttributeForm(): AttributeFormValue {
  return {
    name: "",
    dataType: "text",
    unit: "",
    description: "",
    scope: "product",
    requiredDefault: false,
    filterable: false,
    searchable: false,
    comparable: false,
    key: "",
    setId: "",
    implementation: "custom",
    options: [],
  };
}

let nextRowKey = 0;
export function newOptionRow(): OptionRow {
  nextRowKey += 1;
  return { key: `new-${nextRowKey}`, code: "", en: "", si: "" };
}

/** What stops the form from being saved, by field. Empty means nothing. */
export function attributeFormErrors(
  value: AttributeFormValue,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (value.name.trim() === "") errors.name = "Enter a name.";
  const key = value.key.trim();
  if (key !== "" && value.implementation === "custom" && !KEY_PATTERN.test(key))
    errors.key =
      "A Shopify field is namespace.key: letters, numbers, - and _, at least three characters each side of the dot.";
  if (isSelect(value.dataType)) {
    if (value.options.length === 0) errors.options = "Add at least one option.";
    const codes = new Map<string, number>();
    for (const option of value.options) {
      if (option.en.trim() === "")
        errors[`option-${option.key}`] = "Enter the English label.";
      const code = option.code.trim() || slugOf(option.en);
      codes.set(code, (codes.get(code) ?? 0) + 1);
    }
    for (const option of value.options) {
      const code = option.code.trim() || slugOf(option.en);
      if (code !== "" && (codes.get(code) ?? 0) > 1)
        errors[`option-code-${option.key}`] =
          `The code "${code}" is used twice.`;
    }
  }
  return errors;
}

function slugOf(text: string): string {
  return text.trim() === "" ? "" : slugify(text);
}

/** The payload the create and save actions read. */
export function serialiseAttributeForm(value: AttributeFormValue) {
  return {
    name: value.name,
    dataType: value.dataType,
    unit: takesUnit(value.dataType) ? value.unit : "",
    description: value.description,
    scope: value.scope,
    requiredDefault: value.requiredDefault,
    filterable: value.filterable,
    searchable: value.searchable,
    comparable: value.comparable,
    key: value.key,
    setId: value.setId,
    implementation: value.implementation,
    options: isSelect(value.dataType)
      ? value.options.map(({ code, en, si }) => ({ code, en, si }))
      : [],
  };
}

export function AttributeFields({
  value,
  onChange,
  errors,
  sets,
  mode,
}: {
  value: AttributeFormValue;
  onChange: (next: AttributeFormValue) => void;
  /** Shown only once the person has tried to save. */
  errors: Record<string, string>;
  sets: Array<{ value: string; label: string }>;
  mode: "create" | "edit";
}) {
  const patch = (changes: Partial<AttributeFormValue>) =>
    onChange({ ...value, ...changes });
  const suggestedKey = value.name.trim() ? keyFor(value.name) : "";
  const setOptions = [{ value: "", label: "No set" }, ...sets];
  const setName = sets.find((set) => set.value === value.setId)?.label;

  return (
    <s-stack direction="block" gap="base">
      <s-text-field
        label="Name"
        placeholder="Sail size"
        value={value.name}
        onInput={(event) => patch({ name: event.currentTarget.value })}
        {...(errors.name ? { error: errors.name } : {})}
      />

      <s-grid
        gridTemplateColumns="@container (inline-size <= 480px) 1fr, 1fr 1fr"
        gap="base"
        alignItems="start"
      >
        <Dropdown
          name="dataType"
          label="Format"
          details={DATA_TYPE_HELP[value.dataType]}
          value={value.dataType}
          options={DATA_TYPE_OPTIONS}
          onChange={(dataType) =>
            patch({
              dataType: dataType as DataType,
              options:
                isSelect(dataType as DataType) && value.options.length === 0
                  ? [newOptionRow()]
                  : value.options,
            })
          }
        />
        <Dropdown
          name="scope"
          label="Applies to"
          details={
            value.scope === "variant"
              ? "One value per variant, such as a size."
              : "One value for the whole product."
          }
          value={value.scope}
          options={SCOPE_OPTIONS}
          onChange={(scope) => patch({ scope: scope as Scope })}
        />
      </s-grid>

      {takesUnit(value.dataType) ? (
        <s-text-field
          label={value.dataType === "measurement" ? "Unit" : "Unit (optional)"}
          placeholder="cm, L, m²"
          details={
            value.dataType === "measurement"
              ? "Shown after every value."
              : "Shown after the number, if it has one."
          }
          value={value.unit}
          onInput={(event) => patch({ unit: event.currentTarget.value })}
        />
      ) : null}

      {isSelect(value.dataType) ? (
        <OptionsEditor
          options={value.options}
          onChange={(options) => patch({ options })}
          errors={errors}
        />
      ) : null}

      <s-text-field
        label="Description (optional)"
        value={value.description}
        onInput={(event) => patch({ description: event.currentTarget.value })}
      />

      <s-checkbox
        label="Required by default"
        details="The default for every product type that has this attribute. A type can still make it required or optional for itself."
        checked={value.requiredDefault}
        onChange={(event) =>
          patch({ requiredDefault: event.currentTarget.checked })
        }
      />

      {mode === "edit" ? (
        <s-grid
          gridTemplateColumns="@container (inline-size <= 560px) 1fr, 1fr 1fr 1fr"
          gap="small-300"
        >
          <s-checkbox
            label="Filterable"
            checked={value.filterable}
            onChange={(event) =>
              patch({ filterable: event.currentTarget.checked })
            }
          />
          <s-checkbox
            label="Searchable"
            checked={value.searchable}
            onChange={(event) =>
              patch({ searchable: event.currentTarget.checked })
            }
          />
          <s-checkbox
            label="Comparable"
            checked={value.comparable}
            onChange={(event) =>
              patch({ comparable: event.currentTarget.checked })
            }
          />
        </s-grid>
      ) : null}

      <Advanced
        summary={[
          setName ? `In ${setName}` : "No set",
          value.key.trim() ||
            (suggestedKey
              ? `Shopify field ${suggestedKey}`
              : "no Shopify field"),
          IMPLEMENTATION_LABEL[value.implementation].toLowerCase(),
        ].join(" · ")}
      >
        <s-stack direction="block" gap="base">
          <Dropdown
            name="setId"
            label="Attribute set"
            details={
              mode === "edit"
                ? "Changing the set adds or removes this attribute wherever the old and new sets are attached."
                : "A set is attached to product types as one."
            }
            value={value.setId}
            options={setOptions}
            onChange={(setId) => patch({ setId })}
          />
          <s-text-field
            label="Shopify field"
            placeholder={suggestedKey || "recharge.sail_size"}
            details={
              mode === "create"
                ? "namespace.key of the metafield definition this would become. Left empty, the suggestion is used."
                : "namespace.key of the metafield definition this would become. Renaming the attribute never changes it."
            }
            value={value.key}
            onInput={(event) => patch({ key: event.currentTarget.value })}
            {...(errors.key ? { error: errors.key } : {})}
          />
          <Dropdown
            name="implementation"
            label="Field implementation"
            value={value.implementation}
            options={IMPLEMENTATION_OPTIONS}
            onChange={(implementation) =>
              patch({ implementation: implementation as Implementation })
            }
          />
        </s-stack>
      </Advanced>
    </s-stack>
  );
}

/** Options of a choice attribute: add, edit, reorder, remove, before saving. */
export function OptionsEditor({
  options,
  onChange,
  errors,
}: {
  options: OptionRow[];
  onChange: (options: OptionRow[]) => void;
  errors: Record<string, string>;
}) {
  const update = (key: string, changes: Partial<OptionRow>) =>
    onChange(
      options.map((row) => (row.key === key ? { ...row, ...changes } : row)),
    );
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= options.length) return;
    const next = [...options];
    const [row] = next.splice(index, 1);
    if (row) next.splice(target, 0, row);
    onChange(next);
  };

  return (
    <s-stack direction="block" gap="small-300">
      <s-stack direction="block" gap="small-500">
        <s-text type="strong">Options</s-text>
        <s-text color="subdued">
          The code is what is stored and stays the same when a label changes.
          Left empty, it is made from the English label.
        </s-text>
      </s-stack>
      {errors.options ? (
        <s-text tone="critical">{errors.options}</s-text>
      ) : null}
      {options.map((option, index) => (
        <s-grid
          key={option.key}
          gridTemplateColumns="@container (inline-size <= 640px) 1fr, 1fr 1fr 1fr auto"
          gap="small-300"
          alignItems="start"
        >
          <s-text-field
            label={`Option ${index + 1}, English`}
            labelAccessibilityVisibility={index === 0 ? "visible" : "exclusive"}
            placeholder="English label"
            value={option.en}
            onInput={(event) =>
              update(option.key, { en: event.currentTarget.value })
            }
            {...(errors[`option-${option.key}`]
              ? { error: errors[`option-${option.key}`] }
              : {})}
          />
          <s-text-field
            label={`Option ${index + 1}, Slovenian`}
            labelAccessibilityVisibility={index === 0 ? "visible" : "exclusive"}
            placeholder="Slovenian label"
            value={option.si}
            onInput={(event) =>
              update(option.key, { si: event.currentTarget.value })
            }
          />
          <s-text-field
            label={`Option ${index + 1}, code`}
            labelAccessibilityVisibility={index === 0 ? "visible" : "exclusive"}
            placeholder={slugOf(option.en) || "code"}
            value={option.code}
            onInput={(event) =>
              update(option.key, { code: event.currentTarget.value })
            }
            {...(errors[`option-code-${option.key}`]
              ? { error: errors[`option-code-${option.key}`] }
              : {})}
          />
          <s-stack direction="inline" gap="none" alignItems="center">
            <s-button
              variant="tertiary"
              icon="arrow-up"
              accessibilityLabel={`Move option ${index + 1} up`}
              onClick={() => move(index, -1)}
              {...(index === 0 ? { disabled: true } : {})}
            />
            <s-button
              variant="tertiary"
              icon="arrow-down"
              accessibilityLabel={`Move option ${index + 1} down`}
              onClick={() => move(index, 1)}
              {...(index === options.length - 1 ? { disabled: true } : {})}
            />
            <s-button
              variant="tertiary"
              tone="critical"
              icon="delete"
              accessibilityLabel={`Remove option ${index + 1}`}
              onClick={() =>
                onChange(options.filter((row) => row.key !== option.key))
              }
            />
          </s-stack>
        </s-grid>
      ))}
      <s-stack direction="inline">
        <s-button
          variant="secondary"
          icon="plus"
          onClick={() => onChange([...options, newOptionRow()])}
        >
          Add option
        </s-button>
      </s-stack>
    </s-stack>
  );
}

/* -------------------------------------------------------------------------- */
/* Creating                                                                   */
/* -------------------------------------------------------------------------- */

type Overlay = { showOverlay?: () => void; hideOverlay?: () => void };

interface FormResult {
  ok: boolean;
  message: string;
}

/**
 * The state behind creating an attribute, complete in one flow: format,
 * unit, options, default requirement and where to put it. Posts to the
 * catalogue's action from wherever it is used, so the page that hosts it
 * keeps its place. The host renders the fields and the buttons; `onDone`
 * fires once the server has accepted.
 */
export function useAttributeCreate({
  revision,
  preselectedTypeId,
  onDone,
}: {
  revision: number;
  preselectedTypeId: string | null;
  onDone: () => void;
}) {
  const fetcher = useFetcher<FormResult>();
  const busy = fetcher.state !== "idle";
  const [form, setForm] = useState<AttributeFormValue>(blankAttributeForm);
  const [attachTo, setAttachTo] = useState(preselectedTypeId ?? "");
  const [tried, setTried] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const settled = useRef<FormResult | null>(null);

  useEffect(() => {
    setAttachTo(preselectedTypeId ?? "");
  }, [preselectedTypeId]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (settled.current === fetcher.data) return;
    settled.current = fetcher.data;
    if (fetcher.data.ok) {
      if (typeof shopify !== "undefined")
        shopify.toast.show(fetcher.data.message);
      setForm(blankAttributeForm());
      setTried(false);
      setServerError(null);
      onDone();
    } else {
      setServerError(fetcher.data.message);
    }
  }, [fetcher.state, fetcher.data, onDone]);

  const reset = () => {
    setForm(blankAttributeForm());
    setTried(false);
    setServerError(null);
    setAttachTo(preselectedTypeId ?? "");
  };

  const submit = () => {
    setTried(true);
    setServerError(null);
    if (Object.keys(attributeFormErrors(form)).length > 0) return;
    fetcher.submit(
      {
        intent: "create",
        revision: String(revision),
        attachTo,
        form: JSON.stringify(serialiseAttributeForm(form)),
      },
      { method: "post", action: PRODUCT_SETUP_ROUTES.attributes },
    );
  };

  return {
    form,
    setForm,
    attachTo,
    setAttachTo,
    errors: tried ? attributeFormErrors(form) : {},
    tried,
    serverError,
    busy,
    submit,
    reset,
  };
}

/** The body of the create form, for a dialog or a panel inside one. */
export function AttributeCreatePanel({
  state,
  sets,
  types,
}: {
  state: ReturnType<typeof useAttributeCreate>;
  sets: Array<{ value: string; label: string }>;
  types: Array<{ value: string; label: string }>;
}) {
  const missing = Object.keys(state.errors).length;
  return (
    <s-stack direction="block" gap="base">
      {state.serverError ? (
        <s-banner tone="critical" heading="Not saved">
          <s-paragraph>{state.serverError}</s-paragraph>
        </s-banner>
      ) : null}
      <AttributeFields
        value={state.form}
        onChange={state.setForm}
        errors={state.errors}
        sets={sets}
        mode="create"
      />
      <Dropdown
        name="attachTo"
        label="Add to product type"
        details="The type and every type beneath it get the attribute. It can be added elsewhere later."
        value={state.attachTo}
        options={[{ value: "", label: "Not yet" }, ...types]}
        onChange={state.setAttachTo}
      />
      {state.tried && missing > 0 ? (
        <s-text tone="critical">
          {missing === 1
            ? "One field above needs attention before this can be saved."
            : `${missing} fields above need attention before this can be saved.`}
        </s-text>
      ) : null}
    </s-stack>
  );
}

/** The New attribute dialog on its own. */
export function AttributeCreateModal({
  id,
  revision,
  sets,
  types,
  preselectedTypeId,
}: {
  id: string;
  revision: number;
  sets: Array<{ value: string; label: string }>;
  types: Array<{ value: string; label: string }>;
  /** The type the dialog was opened from; it is added there by default. */
  preselectedTypeId: string | null;
}) {
  const overlay = useRef<Overlay | null>(null);
  const state = useAttributeCreate({
    revision,
    preselectedTypeId,
    onDone: () => overlay.current?.hideOverlay?.(),
  });

  return (
    <s-modal
      id={id}
      heading="New attribute"
      size="large"
      ref={(element) => {
        overlay.current = (element as Overlay) ?? null;
      }}
      onAfterHide={(event) => {
        // The format and scope lists are popovers inside this dialog, and
        // their own `afterhide` bubbles up here when a choice closes them.
        // Only the dialog closing resets the form.
        if (event.target !== event.currentTarget) return;
        state.reset();
      }}
    >
      <AttributeCreatePanel state={state} sets={sets} types={types} />
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={state.submit}
        {...(state.busy ? { loading: true, disabled: true } : {})}
      >
        Add attribute
      </s-button>
      <s-button slot="secondary-actions" command="--hide" commandFor={id}>
        Cancel
      </s-button>
    </s-modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Editing                                                                    */
/* -------------------------------------------------------------------------- */

export interface EditableAttribute {
  id: string;
  name: string;
  form: AttributeFormValue;
  /** How many product types it is on, for the delete confirmation. */
  usedBy: number;
}

/**
 * The state behind editing one attribute in place. Saves and deletes
 * through the attribute's own route with `stay`, which keeps the page that
 * hosts it where it is.
 */
export function useAttributeEdit({
  attribute,
  revision,
  onDone,
}: {
  attribute: EditableAttribute;
  revision: number;
  onDone: () => void;
}) {
  const fetcher = useFetcher<FormResult>();
  const busy = fetcher.state !== "idle";
  const [form, setForm] = useState<AttributeFormValue>(attribute.form);
  const [tried, setTried] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const settled = useRef<FormResult | null>(null);
  const action = PRODUCT_SETUP_ROUTES.attribute(attribute.id);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (settled.current === fetcher.data) return;
    settled.current = fetcher.data;
    if (fetcher.data.ok) {
      if (typeof shopify !== "undefined")
        shopify.toast.show(fetcher.data.message);
      onDone();
    } else {
      setServerError(fetcher.data.message);
    }
  }, [fetcher.state, fetcher.data, onDone]);

  const reset = () => {
    setForm(attribute.form);
    setTried(false);
    setConfirmingDelete(false);
    setServerError(null);
  };

  const save = () => {
    setTried(true);
    setServerError(null);
    if (Object.keys(attributeFormErrors(form)).length > 0) return;
    fetcher.submit(
      {
        intent: "save",
        stay: "1",
        revision: String(revision),
        form: JSON.stringify(serialiseAttributeForm(form)),
      },
      { method: "post", action },
    );
  };

  const remove = () =>
    fetcher.submit(
      { intent: "delete", stay: "1", revision: String(revision) },
      { method: "post", action },
    );

  return {
    form,
    setForm,
    errors: tried ? attributeFormErrors(form) : {},
    tried,
    serverError,
    busy,
    confirmingDelete,
    setConfirmingDelete,
    save,
    remove,
    reset,
  };
}

/** The body of the edit form, with its two-step delete. */
export function AttributeEditPanel({
  state,
  attribute,
  sets,
}: {
  state: ReturnType<typeof useAttributeEdit>;
  attribute: EditableAttribute;
  sets: Array<{ value: string; label: string }>;
}) {
  const missing = Object.keys(state.errors).length;
  const usage =
    attribute.usedBy === 0
      ? "On no product type."
      : `On ${attribute.usedBy === 1 ? "1 product type" : `${attribute.usedBy} product types`}.`;
  return (
    <s-stack direction="block" gap="base">
      {state.serverError ? (
        <s-banner tone="critical" heading="Not saved">
          <s-paragraph>{state.serverError}</s-paragraph>
        </s-banner>
      ) : null}
      <AttributeFields
        value={state.form}
        onChange={state.setForm}
        errors={state.errors}
        sets={sets}
        mode="edit"
      />
      {state.tried && missing > 0 ? (
        <s-text tone="critical">
          {missing === 1
            ? "One field above needs attention before this can be saved."
            : `${missing} fields above need attention before this can be saved.`}
        </s-text>
      ) : null}
      <s-divider />
      {state.confirmingDelete ? (
        <s-stack direction="block" gap="small-300">
          <s-text>
            {attribute.usedBy === 0
              ? `Delete “${attribute.name}” everywhere? It is on no product type; it leaves the catalogue with its options. This cannot be undone.`
              : `Delete “${attribute.name}” everywhere? It leaves the catalogue and ${attribute.usedBy === 1 ? "1 product type" : `${attribute.usedBy} product types`}, with every requirement change and removal about it. This cannot be undone.`}
          </s-text>
          <s-stack direction="inline" gap="small-300">
            <s-button
              tone="critical"
              variant="primary"
              onClick={state.remove}
              {...(state.busy ? { disabled: true, loading: true } : {})}
            >
              Delete everywhere
            </s-button>
            <s-button onClick={() => state.setConfirmingDelete(false)}>
              Keep it
            </s-button>
          </s-stack>
        </s-stack>
      ) : (
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-button
            variant="tertiary"
            tone="critical"
            onClick={() => state.setConfirmingDelete(true)}
          >
            Delete attribute
          </s-button>
          <s-text color="subdued">{usage}</s-text>
        </s-stack>
      )}
    </s-stack>
  );
}

/**
 * The attribute's editor as a dialog, so the catalogue edits in place.
 *
 * One `s-modal` for the page's lifetime, whatever it shows. A row's click
 * both chooses the attribute and commands the dialog to show, and a command
 * lands on the element that exists at that moment — so the element must
 * stay and only its contents may change. The body is keyed by attribute so
 * its form state starts fresh for each one.
 */
export function AttributeEditModal({
  id,
  revision,
  sets,
  attribute,
}: {
  id: string;
  revision: number;
  sets: Array<{ value: string; label: string }>;
  /** Null until a row is chosen; the dialog then renders that attribute. */
  attribute: EditableAttribute | null;
}) {
  const overlay = useRef<Overlay | null>(null);
  const [closedAt, setClosedAt] = useState(0);

  return (
    <s-modal
      id={id}
      heading={attribute?.name ?? "Edit attribute"}
      size="large"
      ref={(element) => {
        overlay.current = (element as Overlay) ?? null;
      }}
      onAfterHide={(event) => {
        if (event.target !== event.currentTarget) return;
        // Remounts the body, which is what resets an abandoned edit.
        setClosedAt(Date.now());
      }}
    >
      {attribute ? (
        <AttributeEditBody
          key={`${attribute.id}:${closedAt}`}
          revision={revision}
          sets={sets}
          attribute={attribute}
          hide={() => overlay.current?.hideOverlay?.()}
          cancelId={id}
        />
      ) : null}
    </s-modal>
  );
}

/** The dialog's contents: the panel and the footer, as direct children. */
function AttributeEditBody({
  revision,
  sets,
  attribute,
  hide,
  cancelId,
}: {
  revision: number;
  sets: Array<{ value: string; label: string }>;
  attribute: EditableAttribute;
  hide: () => void;
  cancelId: string;
}) {
  const state = useAttributeEdit({ attribute, revision, onDone: hide });
  return (
    <>
      <AttributeEditPanel state={state} attribute={attribute} sets={sets} />
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={state.save}
        {...(state.busy ? { loading: true, disabled: true } : {})}
      >
        Save
      </s-button>
      <s-button slot="secondary-actions" command="--hide" commandFor={cancelId}>
        Cancel
      </s-button>
    </>
  );
}

/** The dialog's own copy of an attribute, from the stored one. */
export function editableAttribute(
  attribute: {
    id: string;
    name: string;
    dataType: DataType;
    unit: string;
    description: string;
    scope: Scope;
    requiredDefault: boolean;
    filterable: boolean;
    searchable: boolean;
    comparable: boolean;
    key: string;
    setId: string | null;
    implementation: Implementation;
  },
  options: Array<{ code: string; en: string; si: string }>,
  usedBy: number,
): EditableAttribute {
  return {
    id: attribute.id,
    name: attribute.name,
    usedBy,
    form: {
      name: attribute.name,
      dataType: attribute.dataType,
      unit: attribute.unit,
      description: attribute.description,
      scope: attribute.scope,
      requiredDefault: attribute.requiredDefault,
      filterable: attribute.filterable,
      searchable: attribute.searchable,
      comparable: attribute.comparable,
      key: attribute.key,
      setId: attribute.setId ?? "",
      implementation: attribute.implementation,
      options: options.map((item, index) => ({
        key: `saved-${index}`,
        ...item,
      })),
    },
  };
}
