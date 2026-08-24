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
 * Deliberately empty. Populate it from CLAUDE.md section 14, with codes observed
 * against a real test company, never from memory.
 */
const KNOWN_CODES: Record<string, FailureKind> = {};

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
