import type { Allowed } from "./ui-rules";

/** Violations known at the start of PRD 3; each story removes its own. */
export const PENDING: Record<string, Allowed[]> = {
  lastRun: [
    { file: "src/web/components/source-overview.tsx", includes: "label=\"Last run\"", reason: "pending US-303 ProcessHeader" },
    { file: "src/web/components/source-overview.tsx", includes: "label=\"Next run\"", reason: "pending US-303 ProcessHeader" },
    { file: "src/web/components/source-overview.tsx", includes: "label=\"Next run\"", reason: "pending US-303 ProcessHeader" },
    { file: "src/web/components/sources-list.tsx", includes: "label: \"Last run\",", reason: "pending US-303 ProcessHeader" },
    { file: "src/web/components/sources-list.tsx", includes: "label: \"Next run\",", reason: "pending US-303 ProcessHeader" },
    { file: "src/web/components/sources-list.tsx", includes: "<s-table-header listSlot=\"labeled\">Last ", reason: "pending US-303 ProcessHeader" },
    { file: "src/web/components/sources-list.tsx", includes: "<s-table-header listSlot=\"labeled\">Next ", reason: "pending US-303 ProcessHeader" },
  ],
  article: [
    { file: "src/web/components/ai-translation-settings.tsx", includes: "description=\"Products are translated wit", reason: "pending US-308 reword" },
    { file: "src/web/lib/exceptions.ts", includes: "\"The goods were sent, but MetaKocka has ", reason: "pending US-308 reword" },
    { file: "src/web/routes/app.metakocka.products.sync.tsx", includes: "\"Enter the VAT rate for products this ap", reason: "pending US-308 reword" },
    { file: "src/web/routes/app.metakocka.products.sync.tsx", includes: "\"Choose at least one product type. An ar", reason: "pending US-308 reword" },
    { file: "src/web/routes/app.metakocka.products.sync.tsx", includes: "MetaKocka files an article as a sales it", reason: "pending US-308 reword" },
    { file: "src/web/routes/app.orders.settings._index.tsx", includes: "message: `Nothing was saved: MetaKocka h", reason: "pending US-308 reword" },
    { file: "src/web/routes/app.orders.settings._index.tsx", includes: "The shipping product code is the MetaKoc", reason: "pending US-308 reword" },
    { file: "src/web/routes/app.orders.settings._index.tsx", includes: "A shipping or discount article is never ", reason: "pending US-308 reword" },
    { file: "src/web/routes/app.setup.tsx", includes: "message: `MetaKocka has no product with ", reason: "pending US-308 reword" },
    { file: "src/web/routes/app.setup.tsx", includes: "details=\"The code exactly as MetaKocka h", reason: "pending US-308 reword" },
    { file: "src/web/routes/app.translations._index.tsx", includes: "A page, product or article written in an", reason: "pending US-308 reword" },
    { file: "src/web/routes/app.translations.add.tsx", includes: "Every product, collection, page, article", reason: "pending US-308 reword" },
    { file: "src/web/routes/app.translations.languages.$locale.tsx", includes: "Shopify — products, collections, pages, ", reason: "pending US-308 reword" },
  ],
  exception: [
    { file: "src/web/lib/exceptions.ts", includes: "\"The exact reason is on the exception. F", reason: "pending US-308 reword" },
    { file: "src/web/lib/exceptions.ts", includes: "\"A job ran out of retries and will not r", reason: "pending US-308 reword" },
    { file: "src/web/routes/app.exceptions.tsx", includes: "? `, last ${formatListDateTime(exception", reason: "pending US-308 reword" },
    { file: "src/web/routes/app.exceptions.tsx", includes: "? ` · order ${exception.orderNumber}`", reason: "pending US-308 reword" },
    { file: "src/web/routes/app.metakocka.locations.settings.tsx", includes: "<s-banner tone=\"warning\" heading=\"Saved,", reason: "pending US-308 reword" },
    { file: "src/web/routes/app.product-setup.settings.tsx", includes: "{`${stated}, every set and every excepti", reason: "pending US-308 reword" },
    { file: "src/web/routes/app.product-setup.types.($typeId).tsx", includes: "what.push(`${countOf(impact.rulesHere, \"", reason: "pending US-308 reword" },
    { file: "src/web/routes/app.product-setup.types.($typeId).tsx", includes: "`“${name}” has no children, sources or e", reason: "pending US-308 reword" },
    { file: "src/web/routes/app.settings.taxes._index.tsx", includes: "\"Deliberate exceptions by country or SKU", reason: "pending US-308 reword" },
  ],
  blocked: [
    { file: "src/web/routes/app.metakocka.locations.settings.tsx", includes: "`Saved. ${blocked.join(\", \")} kept ${blo", reason: "pending US-308 reword" },
    { file: "src/web/routes/app.setup.tsx", includes: "? `${blocked.join(\", \")} kept ${blocked.", reason: "pending US-308 reword" },
  ],
  successfully: [
    { file: "src/web/routes/app.settings.metakocka.tsx", includes: ": \"The credentials have not been used su", reason: "pending US-308 reword" },
    { file: "src/web/routes/app.sources.connection.tsx", includes: "? \"The key has not been used successfull", reason: "pending US-308 reword" },
  ],
  feed: [
    { file: "src/web/routes/app.sources._index.tsx", includes: "? `Connect a catalogue export or a brand", reason: "pending US-308 reword" },
    { file: "src/web/routes/app.sources._index.tsx", includes: ": \"Connect a catalogue export or a brand", reason: "pending US-308 reword" },
  ],
};
