import { z } from "zod";

import { getLogger } from "~/adapters/observability/logger.server";
import {
  MK_SUCCESS,
  MetakockaError,
  classifyHttpStatus,
  classifyOprCode,
  classifyTransportError,
} from "~/adapters/metakocka/errors";

/**
 * The MetaKocka REST client.
 *
 * Verified against
 * https://github.com/metakocka/metakocka_api_base/blob/master/docs/warehouse_list.md :
 * calls are POSTed to `{BASE_URL}{endpoint}` with a JSON body that always carries
 * `secret_key` and `company_id`, and every response carries `opr_code`, where
 * "0" means success (CLAUDE.md section 3).
 *
 * Note the `json/` segment in the path. CLAUDE.md section 3 gives the base as
 * `https://main.metakocka.si/rest/eshop/v1/`; the documented endpoint URL is
 * `https://main.metakocka.si/rest/eshop/v1/json/warehouse_list`.
 */
export const METAKOCKA_BASE_URL = "https://main.metakocka.si/rest/eshop/v1/json/";

/**
 * MetaKocka is slow. The documented `put_document` example with
 * `create_invoice` reports about 47 seconds (CLAUDE.md section 3), which is why
 * no request path may ever await one (section 2.5). This ceiling exists so a
 * hung connection cannot pin a worker indefinitely.
 */
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface MetakockaCredentials {
  companyId: string;
  secretKey: string;
}

export interface MetakockaClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** Every response shares this envelope. Endpoint schemas extend it. */
export const mkEnvelopeSchema = z
  .object({
    opr_code: z.union([z.string(), z.number()]).transform(String),
    opr_desc: z.string().optional(),
    opr_desc_app: z.string().optional(),
    opr_time_ms: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

export class MetakockaClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly credentials: MetakockaCredentials,
    options: MetakockaClientOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? METAKOCKA_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Posts one call and parses the response with `schema`.
   *
   * Never logs the request body: it contains `secret_key` on every single call
   * (CLAUDE.md section 10).
   */
  async call<T>(
    endpoint: string,
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const log = getLogger();
    const startedAt = performance.now();

    const payload = {
      secret_key: this.credentials.secretKey,
      company_id: this.credentials.companyId,
      ...body,
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new MetakockaError(`MetaKocka ${endpoint} could not be reached`, {
        endpoint,
        kind: classifyTransportError(),
        cause,
      });
    }

    if (!response.ok) {
      throw new MetakockaError(
        `MetaKocka ${endpoint} returned HTTP ${response.status}`,
        {
          endpoint,
          kind: classifyHttpStatus(response.status),
          httpStatus: response.status,
        },
      );
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch (cause) {
      // A 200 that is not JSON is not something a retry will fix.
      throw new MetakockaError(
        `MetaKocka ${endpoint} returned a response that is not JSON`,
        { endpoint, kind: "exception", httpStatus: response.status, cause },
      );
    }

    const envelope = mkEnvelopeSchema.safeParse(raw);
    if (!envelope.success) {
      throw new MetakockaError(
        `MetaKocka ${endpoint} returned an unrecognised response envelope`,
        { endpoint, kind: "exception", cause: envelope.error },
      );
    }

    const { opr_code: oprCode, opr_desc: oprDesc } = envelope.data;

    if (oprCode !== MK_SUCCESS) {
      throw new MetakockaError(
        `MetaKocka ${endpoint} failed with opr_code ${oprCode}`,
        {
          endpoint,
          kind: classifyOprCode(oprCode),
          oprCode,
          oprDesc,
        },
      );
    }

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      // Section 3: never let a raw MetaKocka value reach domain code. A shape we
      // do not recognise is a bug or an API change, and a human needs to see it.
      throw new MetakockaError(
        `MetaKocka ${endpoint} returned a payload that did not match its schema`,
        { endpoint, kind: "exception", oprCode, cause: parsed.error },
      );
    }

    log.info(
      { endpoint, durationMs: Math.round(performance.now() - startedAt) },
      "MetaKocka call succeeded",
    );

    return parsed.data;
  }
}
