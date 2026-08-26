/**
 * The one place MetaKocka failures are classified (CLAUDE.md section 11).
 * Nothing else in the codebase decides whether a MetaKocka failure is worth
 * retrying or worth a human.
 *
 * MetaKocka does not return machine-readable errors: a call reports `opr_code`
 * plus a human-readable `opr_desc` (section 3), and no list of codes is
 * documented beyond `"0"` meaning success. So the default for any non-zero code
 * is `exception`, not `retryable`. Guessing that an unknown failure is transient
 * would make the app retry a permanent rejection forever and never tell anyone.
 *
 * CLAUDE.md section 14 item 2 exists to fill in the known cases: send a
 * profit_center that does not exist, record the exact code and description, and
 * add it to KNOWN_CODES below with a real value rather than an assumed one.
 */

/** A failure the queue should retry on its own. No human involved, no UI. */
export type RetryableFailure = "retryable";

/** A business condition needing a human. Goes to the exceptions queue. */
export type BusinessException = "exception";

export type FailureKind = RetryableFailure | BusinessException;

export const MK_SUCCESS = "0";

/**
 * Populated only from codes observed against a real company, never from memory.
 *
 * "2" is what MetaKocka returns for a request it will not accept as written.
 * Observed for both "Partner data are missing" and "Cannot find document type
 * sales_order with id = null", so it is a general validation failure: retrying
 * an identical payload will fail identically, and a human has to change
 * something.
 */
/**
 * Codes observed to be validation refusals — MetaKocka read the request,
 * rejected it, and filed nothing. These are the only answers that prove no
 * document was created: code 2 refuses a request as written, 6 rejects a named
 * value (profit centre, doc_date), 8 an unknown product code, all before
 * anything is stored. Any *other* code is an answer whose consequences nobody
 * has observed, and the duplicate guard treats it like a timeout: look before
 * sending again.
 */
export const VALIDATION_REJECTION_CODES: ReadonlySet<string> = new Set([
  "2",
  "6",
  "8",
]);

const KNOWN_CODES: Record<string, FailureKind> = {
  // "Partner data are missing", "Cannot find document type sales_order with
  // id = null". A request MetaKocka will not accept as written: retrying the
  // same payload fails identically, so a human has to change something.
  "2": "exception",
  // "Profit center 'X' doesn't exist." A named entity that must pre-exist in
  // the MetaKocka UI (CLAUDE.md section 3) and does not. Not exclusively that,
  // though: code 6 also answers a malformed doc_date, so the cause has to be
  // read from opr_desc rather than the code. See exceptionKindFor.
  "6": "exception",
  // "Product with code X not found - unit must be set to add new product."
  // The SKU is not in the catalogue. Retrying changes nothing; either the
  // product is created in MetaKocka or a human decides otherwise.
  "8": "exception",
};

export interface MetakockaErrorOptions {
  endpoint: string;
  kind: FailureKind;
  oprCode?: string;
  oprDesc?: string;
  httpStatus?: number;
  cause?: unknown;
}

export class MetakockaError extends Error {
  readonly endpoint: string;
  readonly kind: FailureKind;
  readonly oprCode: string | undefined;
  readonly oprDesc: string | undefined;
  readonly httpStatus: number | undefined;

  constructor(message: string, options: MetakockaErrorOptions) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "MetakockaError";
    this.endpoint = options.endpoint;
    this.kind = options.kind;
    this.oprCode = options.oprCode;
    this.oprDesc = options.oprDesc;
    this.httpStatus = options.httpStatus;
  }

  get isRetryable(): boolean {
    return this.kind === "retryable";
  }
}

/**
 * Classify a transport-level outcome: no response, or a response we never got to
 * parse. These are the only failures we can call transient with confidence.
 */
export function classifyHttpStatus(status: number): FailureKind {
  if (status === 429) return "retryable";
  if (status >= 500) return "retryable";
  return "exception";
}

/** A thrown fetch error: DNS, connection reset, timeout, aborted request. */
export function classifyTransportError(): FailureKind {
  return "retryable";
}

/**
 * Classify an application-level `opr_code`. Unknown codes are exceptions on
 * purpose; see the note at the top of this file.
 */
export function classifyOprCode(oprCode: string): FailureKind {
  return KNOWN_CODES[oprCode] ?? "exception";
}

/**
 * Turn a MetaKocka failure into a message a merchant can act on
 * (CLAUDE.md section 2.8: say what is wrong and how to fix it).
 *
 * `opr_desc` is written for a MetaKocka operator, not for a Shopify merchant, so
 * it is quoted rather than paraphrased. Inventing a friendlier wording would
 * mean guessing at a cause we were not told.
 */
export function describeForMerchant(error: MetakockaError): string {
  if (error.oprDesc) {
    return `MetaKocka rejected the request: ${error.oprDesc}`;
  }

  if (error.httpStatus) {
    return `MetaKocka returned HTTP ${error.httpStatus}. Check that the company ID and secret key are correct and that MetaKocka is reachable.`;
  }

  return "MetaKocka could not be reached. Check your connection and try again.";
}

/**
 * Which exception kind a MetaKocka rejection belongs to.
 *
 * **Not derived from `opr_code`.** This once mapped code 6 straight to
 * "profit centre rejected", on the strength of the one code-6 response anyone
 * had seen — `"Profit center 'X' doesn't exist."`. A live order then came back
 * with code 6 and `"Not valid date for doc_date"`, and the merchant was shown a
 * red banner blaming a profit centre that was perfectly fine. Code 6 is a
 * general rejection, not a named-entity one.
 *
 * So the kind comes from the description, and anything unrecognised is the
 * honest `metakocka_write_failed` rather than a confident wrong guess. The full
 * `opr_desc` is always shown alongside (see `describeForMerchant`), so a
 * mislabelled heading is the only thing at stake — but a heading that names the
 * wrong cause sends someone to change a setting that was never the problem.
 */
export function exceptionKindFor(
  error: MetakockaError,
):
  | "profit_center_rejected"
  | "warehouse_invalid"
  | "tax_undeterminable"
  | "sku_not_in_metakocka"
  | "unmapped_payment_gateway"
  | "metakocka_write_failed" {
  const description = (error.oprDesc ?? "").toLowerCase();

  // "Product with code 'X' not found - unit must be set to add new product."
  if (
    description.includes("product with code") &&
    description.includes("not found")
  ) {
    return "sku_not_in_metakocka";
  }

  // "Attribute 'tax' for product with code 'X' ... must be set."
  if (description.includes("attribute 'tax'")) return "tax_undeterminable";

  // "Paramether 'payment_type' has invalid value", or "The payment instrument
  // X needs to be tax certified". Both mean the gateway is mapped to a type this
  // company cannot use, which is a mapping to change rather than a write to fix.
  if (
    description.includes("payment_type") ||
    description.includes("payment instrument")
  ) {
    return "unmapped_payment_gateway";
  }

  if (
    description.includes("profit center") ||
    description.includes("profit centre")
  ) {
    return "profit_center_rejected";
  }
  if (description.includes("warehouse") || description.includes("skladi")) {
    return "warehouse_invalid";
  }
  return "metakocka_write_failed";
}
