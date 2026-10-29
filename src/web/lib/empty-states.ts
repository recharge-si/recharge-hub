/**
 * What an empty list says, in one place so a copy review is one diff
 * (docs/ui-conventions.md § Lists). Each says what to do next.
 */
export const EMPTY = {
  productsNoSuggestions:
    "No AI suggestions are waiting. Autofill products from this list, from a product's Attributes tab, or from Sources › Review.",
  productsNotRead:
    "The catalogue has not been read yet. It is read every night, and after a sale campaign asks for it.",
  productsNoMatch: "No products match.",
  metakockaNoSkus: "No SKUs have been read yet.",
  metakockaNotRead: "The catalogue has not been read yet.",
  salesNone: {
    heading: "No campaigns yet",
    body: "Put part of the catalogue on sale for a while. The original prices are put back when it ends.",
  },
  sourcesNone: {
    heading: "No sources yet",
    body: "Connect a catalogue export or a brand feed to start pushing products into the store.",
  },
  sourcesNoMatch: "No sources match these filters.",
  syncsNone:
    "No syncs yet. Translate the store, a language or a single resource and it appears here.",
} as const;
