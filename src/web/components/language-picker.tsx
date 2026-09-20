import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import {
  searchLanguages,
  type LanguageInfo,
} from "~/domain/translations/languages";
import { LanguageLabel } from "~/web/components/language-label";
import { LocaleFlag } from "~/web/components/locale-flag";

/**
 * Choosing one language out of the hundred-odd Shopify can enable
 * (docs/translations.md § Add language).
 *
 * A field that reads as a select — the chosen language with its flag, or
 * an invitation to search — and a floating list behind it with a search
 * box at the top. The list is every language, capped in height and
 * scrolling, so the page never grows by a hundred rows; the search narrows
 * it by English name, native name, code, locale or country, forgiving of
 * case and accents, best match first (`searchLanguages`).
 *
 * Languages the store already has are listed too, under their own heading
 * and marked, and choosing one opens its settings instead of selecting it:
 * the same language cannot be added twice, and the merchant who searched
 * for it should not have to work out why it is not offered.
 *
 * Why not a primitive: Polaris has no combobox. `s-select` is a native
 * `<select>` with no search and the operating system's list; `s-search-field`
 * is a box with no list. So this is built from what Polaris gives —
 * `s-clickable` for the field and the rows, `s-popover` for the floating
 * list, `s-search-field` for the box — with no styling of our own. The
 * keyboard is the native one for these parts, plus what a listbox owes:
 * arrows move between the rows, Home and End jump, Escape closes, Enter
 * chooses the focused row (it is a button), and typing while a row is
 * focused returns to the search box. Focus is moved, not simulated, so a
 * screen reader hears each row as it is reached.
 */
export interface ConfiguredLanguage extends LanguageInfo {
  /** Where the language's own page is. */
  href: string;
  /** "Published", "Default": what the store's list says about it. */
  state: string;
}

const LIST_MAX_BLOCK_SIZE = "320px";

/** The rows the arrow keys move between, in document order. */
function rowsIn(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return [...container.querySelectorAll<HTMLElement>("[data-language-row]")];
}

export function LanguagePicker({
  label,
  languages,
  configured = [],
  value,
  onChange,
  disabled = false,
  placeholder = "Search for a language",
}: {
  label: string;
  /** Languages that can be chosen, in the order to show them unsearched. */
  languages: readonly LanguageInfo[];
  /** Languages the store has already; shown, marked, never selectable. */
  configured?: readonly ConfiguredLanguage[];
  value: string | null;
  onChange: (locale: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  // An id attribute cannot hold the colons React puts in a generated id.
  const listId = `language-picker-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const overlay = useRef<{ hideOverlay?: () => void } | null>(null);
  const search = useRef<HTMLElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);

  const selected = useMemo(
    () => languages.find((language) => language.locale === value) ?? null,
    [languages, value],
  );
  const matches = useMemo(
    () => searchLanguages(languages, query),
    [languages, query],
  );
  const configuredMatches = useMemo(
    () => searchLanguages(configured, query),
    [configured, query],
  );

  const choose = useCallback(
    (locale: string) => {
      onChange(locale);
      overlay.current?.hideOverlay?.();
    },
    [onChange],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = rowsIn(list.current);
    const target = event.target as HTMLElement;
    const rowIndex = rows.findIndex(
      (row) => row === target || row.contains(target),
    );
    const inSearch = rowIndex === -1;

    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        const next = inSearch ? 0 : Math.min(rowIndex + 1, rows.length - 1);
        rows[next]?.focus();
        return;
      }
      case "ArrowUp": {
        event.preventDefault();
        if (inSearch) return;
        if (rowIndex === 0) search.current?.focus();
        else rows[rowIndex - 1]?.focus();
        return;
      }
      case "Home":
        if (inSearch) return;
        event.preventDefault();
        rows[0]?.focus();
        return;
      case "End":
        if (inSearch) return;
        event.preventDefault();
        rows[rows.length - 1]?.focus();
        return;
      case "Escape":
        overlay.current?.hideOverlay?.();
        return;
      case "Enter":
        // In the search box, Enter takes the best match; on a row the
        // button handles it.
        if (inSearch && matches[0]) {
          event.preventDefault();
          choose(matches[0].locale);
        }
        return;
      default:
        // A letter typed on a row belongs in the search box.
        if (
          !inSearch &&
          event.key.length === 1 &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey
        )
          search.current?.focus();
    }
  };

  const total = languages.length;
  const status = query.trim()
    ? matches.length === 0 && configuredMatches.length === 0
      ? `No language matches “${query.trim()}”`
      : `${matches.length.toLocaleString("en")} of ${total.toLocaleString("en")} languages`
    : `${total.toLocaleString("en")} languages available`;

  return (
    <s-stack direction="block" gap="small-400">
      <s-text type="strong">{label}</s-text>

      <s-clickable
        commandFor={listId}
        border="base"
        borderRadius="base"
        background="base"
        paddingInline="small-200"
        paddingBlock="small-300"
        inlineSize="100%"
        accessibilityLabel={`${label}: ${selected ? `${selected.name} (${selected.locale})` : "none chosen"}. ${open ? "Close" : "Open"} the list`}
        {...(disabled ? { disabled: true } : {})}
      >
        <s-grid
          gridTemplateColumns="1fr auto"
          gap="small-200"
          alignItems="center"
        >
          {selected ? (
            <LanguageLabel language={selected} />
          ) : (
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-icon type="search" color="subdued" />
              <s-text color="subdued">{placeholder}</s-text>
            </s-stack>
          )}
          <s-icon type={open ? "chevron-up" : "chevron-down"} />
        </s-grid>
      </s-clickable>

      <s-popover
        id={listId}
        minInlineSize="360px"
        ref={(element) => {
          overlay.current = (element as { hideOverlay?: () => void }) ?? null;
        }}
        onShow={() => setOpen(true)}
        onAfterShow={() => search.current?.focus()}
        onAfterHide={() => {
          setOpen(false);
          setQuery("");
        }}
      >
        <div onKeyDown={handleKeyDown}>
          <s-box padding="small-200" paddingBlockEnd="none">
            <s-stack direction="block" gap="small-400">
              <s-search-field
                label="Search languages"
                labelAccessibilityVisibility="exclusive"
                placeholder="Name, native name, code or country"
                value={query}
                autocomplete="off"
                ref={(element) => {
                  search.current = element;
                }}
                onInput={(event) => setQuery(event.currentTarget.value)}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
              <s-box accessibilityRole="status">
                <s-text color="subdued">{status}</s-text>
              </s-box>
            </s-stack>
          </s-box>

          <s-scroll-box maxBlockSize={LIST_MAX_BLOCK_SIZE} padding="small-200">
            <div ref={list}>
              <s-stack direction="block" gap="none">
                {configuredMatches.length > 0 ? (
                  <>
                    <s-box paddingInline="small-200" paddingBlock="small-400">
                      <s-text color="subdued" type="strong">
                        Already added
                      </s-text>
                    </s-box>
                    {configuredMatches.map((language) => (
                      <s-clickable
                        key={`configured-${language.locale}`}
                        href={language.href}
                        borderRadius="base"
                        paddingInline="small-200"
                        paddingBlock="small-300"
                        inlineSize="100%"
                        accessibilityLabel={`${language.name} (${language.locale}), already added: open its settings`}
                        data-language-row=""
                      >
                        <LanguageLabel
                          language={language}
                          trailing={<s-badge>{language.state}</s-badge>}
                        />
                      </s-clickable>
                    ))}
                    {matches.length > 0 ? (
                      <s-box paddingInline="small-200" paddingBlock="small-400">
                        <s-text color="subdued" type="strong">
                          Available
                        </s-text>
                      </s-box>
                    ) : null}
                  </>
                ) : null}

                {matches.map((language) => (
                  <s-clickable
                    key={language.locale}
                    borderRadius="base"
                    paddingInline="small-200"
                    paddingBlock="small-300"
                    inlineSize="100%"
                    accessibilityLabel={`${language.name}${language.nativeName && language.nativeName !== language.name ? `, ${language.nativeName}` : ""} (${language.locale})`}
                    onClick={() => choose(language.locale)}
                    data-language-row=""
                  >
                    <LanguageLabel
                      language={language}
                      trailing={
                        language.locale === value ? (
                          <s-icon type="check" />
                        ) : null
                      }
                    />
                  </s-clickable>
                ))}

                {matches.length === 0 && configuredMatches.length === 0 ? (
                  <s-box padding="small-200">
                    <s-stack
                      direction="inline"
                      gap="small-200"
                      alignItems="center"
                    >
                      <LocaleFlag regionCode={null} size="small" />
                      <s-text color="subdued">
                        Shopify lists the languages a store can have. Try the
                        English name, the language&apos;s own name, its code or
                        a country.
                      </s-text>
                    </s-stack>
                  </s-box>
                ) : null}
              </s-stack>
            </div>
          </s-scroll-box>
        </div>
      </s-popover>
    </s-stack>
  );
}
