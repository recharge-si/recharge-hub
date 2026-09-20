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

interface CreateResult {
  ok: boolean;
  message: string;
}

/**
 * The New attribute dialog, complete in one flow: format, unit, options,
 * default requirement and where to put it. Posts to the catalogue's action
 * from wherever it is opened, so the product type page keeps its selection.
 */
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
  const fetcher = useFetcher<CreateResult>();
  const busy = fetcher.state !== "idle";
  const overlay = useRef<Overlay | null>(null);
  const [form, setForm] = useState<AttributeFormValue>(blankAttributeForm);
  const [attachTo, setAttachTo] = useState(preselectedTypeId ?? "");
  const [tried, setTried] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const errors = tried ? attributeFormErrors(form) : {};

  useEffect(() => {
    setAttachTo(preselectedTypeId ?? "");
  }, [preselectedTypeId]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      overlay.current?.hideOverlay?.();
      if (typeof shopify !== "undefined")
        shopify.toast.show(fetcher.data.message);
      setForm(blankAttributeForm());
      setTried(false);
      setServerError(null);
    } else {
      setServerError(fetcher.data.message);
    }
  }, [fetcher.state, fetcher.data]);

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

  const typeOptions = [{ value: "", label: "Not yet" }, ...types];
  const missing = Object.keys(errors).length;

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
        setForm(blankAttributeForm());
        setTried(false);
        setServerError(null);
        setAttachTo(preselectedTypeId ?? "");
      }}
    >
      <s-stack direction="block" gap="base">
        {serverError ? (
          <s-banner tone="critical" heading="Not saved">
            <s-paragraph>{serverError}</s-paragraph>
          </s-banner>
        ) : null}
        <AttributeFields
          value={form}
          onChange={setForm}
          errors={errors}
          sets={sets}
          mode="create"
        />
        <Dropdown
          name="attachTo"
          label="Add to product type"
          details="The type and every type beneath it get the attribute. It can be added elsewhere later."
          value={attachTo}
          options={typeOptions}
          onChange={setAttachTo}
        />
        {tried && missing > 0 ? (
          <s-text tone="critical">
            {missing === 1
              ? "One field above needs attention before this can be saved."
              : `${missing} fields above need attention before this can be saved.`}
          </s-text>
        ) : null}
      </s-stack>
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={submit}
        {...(busy ? { loading: true, disabled: true } : {})}
      >
        Add attribute
      </s-button>
      <s-button slot="secondary-actions" command="--hide" commandFor={id}>
        Cancel
      </s-button>
    </s-modal>
  );
}
