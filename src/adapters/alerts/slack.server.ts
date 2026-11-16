/**
 * Posts one message to a Slack incoming webhook (docs/architecture.md
 * § Operator alerts).
 *
 * The webhook URL is the secret — anyone holding it can post to the channel —
 * so it is never logged, and an error says what Slack answered without
 * repeating the URL.
 */

export type FetchLike = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const TIMEOUT_MS = 10_000;

export async function postSlackMessage(
  webhookUrl: string,
  text: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const response = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // `unfurl_links: false`: the link is to the Shopify admin, which has
    // nothing to preview for anyone not signed in to it.
    body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(
      `Slack refused the alert: HTTP ${response.status} ${body}`.trim(),
    );
  }
}
