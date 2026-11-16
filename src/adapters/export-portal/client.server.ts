import type { z } from "zod";

import { getLogger } from "~/adapters/observability/logger.server";
import {
  API_PREFIX,
  errorReplySchema,
  replies,
  type CategorizeRequest,
  type Connection,
  type ExtractAttributesRequest,
  type Run,
  type Source,
  type SourceCreate,
  type SourceSummary,
  type SourceType,
  type SourceWrite,
} from "~/domain/export-portal/contract";

import { ExportPortalError, kindForStatus } from "./errors";

/**
 * The export portal, called (docs/sources.md § The adapter).
 *
 * One client per request, built from the deployment's portal origin and the
 * shop's API key. Every call carries the key as a bearer token and the shop
 * domain as a header, and the portal is expected to refuse a key that was
 * not issued for that shop — the check that stops a pasted key from
 * configuring another partner's sources.
 *
 * Every reply is parsed against `domain/export-portal/contract` before it is
 * returned. The key is never logged; the path and the status are.
 */

export interface ExportPortalCredentials {
  baseUrl: string;
  apiKey: string;
  shopDomain: string;
}

export interface ExportPortalClientOptions {
  fetchImpl?: typeof fetch;
  /** A screen is waiting, so this is short; the default suits a loader. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;

type Method = "GET" | "POST" | "PATCH" | "DELETE";

export class ExportPortalClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly credentials: ExportPortalCredentials,
    options: ExportPortalClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Who this key is, according to the portal. The connection test. */
  connection(): Promise<Connection> {
    return this.call("GET", "/connection", undefined, replies.connection);
  }

  async listSourceTypes(): Promise<SourceType[]> {
    return (
      await this.call("GET", "/source-types", undefined, replies.sourceTypes)
    ).types;
  }

  async listSources(): Promise<SourceSummary[]> {
    return (await this.call("GET", "/sources", undefined, replies.sources))
      .sources;
  }

  async getSource(id: string): Promise<Source> {
    return (
      await this.call("GET", `/sources/${enc(id)}`, undefined, replies.source)
    ).source;
  }

  async createSource(input: SourceCreate): Promise<Source> {
    return (await this.call("POST", "/sources", input, replies.source)).source;
  }

  async updateSource(id: string, input: SourceWrite): Promise<Source> {
    return (
      await this.call("PATCH", `/sources/${enc(id)}`, input, replies.source)
    ).source;
  }

  async deleteSource(id: string): Promise<void> {
    await this.call("DELETE", `/sources/${enc(id)}`, undefined, null);
  }

  async startRun(sourceId: string): Promise<Run> {
    return (
      await this.call("POST", `/sources/${enc(sourceId)}/runs`, {}, replies.run)
    ).run;
  }

  async listRuns(sourceId: string, limit = 20): Promise<Run[]> {
    return (
      await this.call(
        "GET",
        `/sources/${enc(sourceId)}/runs?limit=${limit}`,
        undefined,
        replies.runs,
      )
    ).runs;
  }

  /** One product type per product, or none; nothing is stored or written. */
  async categorize(
    input: CategorizeRequest,
  ): Promise<z.infer<typeof replies.categorize>["results"]> {
    return (
      await this.call("POST", "/ai/categorize", input, replies.categorize)
    ).results;
  }

  /** Values for the attributes described, read from one product's data. */
  async extractAttributes(
    input: ExtractAttributesRequest,
  ): Promise<z.infer<typeof replies.extractAttributes>["values"]> {
    return (
      await this.call(
        "POST",
        "/ai/extract-attributes",
        input,
        replies.extractAttributes,
      )
    ).values;
  }

  getRun(runId: string): Promise<z.infer<typeof replies.runDetail>> {
    return this.call(
      "GET",
      `/runs/${enc(runId)}`,
      undefined,
      replies.runDetail,
    );
  }

  private async call<T>(
    method: Method,
    path: string,
    body: unknown,
    schema: z.ZodType<T> | null,
  ): Promise<T> {
    const url = `${this.credentials.baseUrl}${API_PREFIX}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const log = getLogger();

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.credentials.apiKey}`,
          "x-shop-domain": this.credentials.shopDomain,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const timedOut = error instanceof Error && error.name === "AbortError";
      log.warn(
        { path, method, timedOut },
        "Export portal could not be reached",
      );
      throw new ExportPortalError({
        kind: "unavailable",
        path,
        message: timedOut
          ? "The export portal did not answer in time."
          : "The export portal could not be reached.",
        cause: error,
      });
    }
    clearTimeout(timer);

    const status = response.status;
    const text = await response.text();
    const json: unknown = text === "" ? null : safeJson(text);

    if (status >= 200 && status < 300) {
      if (schema === null) return undefined as T;
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        log.warn(
          { path, method, status, issues: parsed.error.issues.slice(0, 5) },
          "Export portal reply did not match the contract",
        );
        throw new ExportPortalError({
          kind: "unreadable",
          path,
          httpStatus: status,
          message: "The export portal's reply could not be read.",
        });
      }
      return parsed.data;
    }

    const refusal = errorReplySchema.safeParse(json);
    const kind = kindForStatus(status);
    const fieldErrors = refusal.success ? (refusal.data.errors ?? []) : [];
    const message =
      (refusal.success ? refusal.data.error?.message : undefined) ??
      (fieldErrors.length > 0
        ? fieldErrors.map((e) => e.message).join(" ")
        : `The export portal answered ${status}.`);

    log.warn({ path, method, status, kind }, "Export portal refused a call");
    throw new ExportPortalError({
      kind,
      path,
      httpStatus: status,
      message,
      fieldErrors,
    });
  }
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
