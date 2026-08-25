import { z } from "zod";

import type { EndpointPath } from "~/adapters/metakocka/endpoints";
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
 * Calls are POSTed to `{BASE_URL}{path}` with a JSON body that always carries
 * `secret_key` and `company_id`, and every response carries `opr_code`, where
 * "0" means success (CLAUDE.md section 3).
 *
 * `path` comes from ENDPOINTS rather than being the bare endpoint name: some
 * endpoints live under a `json/` segment and some do not, and asking for the
 * wrong one returns an HTML 404. See endpoints.ts.
 */
export const METAKOCKA_BASE_URL = "https://main.metakocka.si/rest/eshop/v1/";

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

/**
 * The envelope most responses share. Endpoint schemas extend it.
 *
 * **[verified] `opr_code` is optional, because not every endpoint sends one.**
 * `add_partner` answers a successful create with the new ids and nothing else
 * — no `opr_code`, no `opr_desc`. Requiring it rejected a response that was
 * perfectly fine, as "an unrecognised response envelope", and took the job down
 * with it. Absence is treated as success: an endpoint that reports failures does
 * so with a code, so no code means nothing went wrong.
 */
export const mkEnvelopeSchema = z
  .object({
    opr_code: z.union([z.string(), z.number()]).transform(String).optional(),
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
    path: EndpointPath,
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
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new MetakockaError(`MetaKocka ${path} could not be reached`, {
        endpoint: path,
        kind: classifyTransportError(),
        cause,
      });
    }

    if (!response.ok) {
      throw new MetakockaError(
        `MetaKocka ${path} returned HTTP ${response.status}`,
        {
          endpoint: path,
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
        `MetaKocka ${path} returned a response that is not JSON`,
        {
          endpoint: path,
          kind: "exception",
          httpStatus: response.status,
          cause,
        },
      );
    }

    const envelope = mkEnvelopeSchema.safeParse(raw);
    if (!envelope.success) {
      throw new MetakockaError(
        `MetaKocka ${path} returned an unrecognised response envelope`,
        { endpoint: path, kind: "exception", cause: envelope.error },
      );
    }

    const { opr_code: oprCode, opr_desc: oprDesc } = envelope.data;

    // No code at all means the endpoint does not report one; see the envelope.
    if (oprCode !== undefined && oprCode !== MK_SUCCESS) {
      throw new MetakockaError(
        `MetaKocka ${path} failed with opr_code ${oprCode}`,
        {
          endpoint: path,
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
        `MetaKocka ${path} returned a payload that did not match its schema`,
        { endpoint: path, kind: "exception", oprCode, cause: parsed.error },
      );
    }

    log.info(
      { endpoint: path, durationMs: Math.round(performance.now() - startedAt) },
      "MetaKocka call succeeded",
    );

    return parsed.data;
  }
}
