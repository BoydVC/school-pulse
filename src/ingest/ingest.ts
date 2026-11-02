import { adapterFor, explainAdapter, formatFor, type AdapterFailure } from "../adapters/index.ts";
import type { AlertEvent } from "../alerts/engine.ts";
import { err, ok, type IsoInstant, type Result, type Source } from "../domain/index.ts";
import { sha256 } from "../hash.ts";
import { Store } from "../store/store.ts";

export type IngestOutcome =
  | { readonly outcome: "unchanged"; readonly contentHash: string; readonly source: Source }
  | {
      readonly outcome: "applied";
      readonly contentHash: string;
      readonly source: Source;
      readonly baseline: boolean;
      readonly messages: readonly string[];
      readonly changeIds: readonly string[];
      readonly alerts: readonly AlertEvent[];
      readonly webhookError: string | null;
    };

export type IngestFailure = AdapterFailure | { readonly kind: "format"; readonly message: string } | { readonly kind: "link"; readonly message: string };

export function explainIngest(failure: IngestFailure): string {
  if (failure.kind === "format" || failure.kind === "link") return failure.message;
  return explainAdapter(failure);
}

export async function ingestText(
  store: Store,
  source: Source,
  text: string,
  filename: string,
  now: IsoInstant,
  hooks?: { readonly postWebhook?: (url: string, body: string) => Promise<void> },
): Promise<Result<IngestOutcome, IngestFailure>> {
  const contentHash = sha256(`${source}\n${text}`);
  if (store.hasReceipt(contentHash)) return ok({ outcome: "unchanged", contentHash, source });
  const format = formatFor(filename);
  if (!format) return err({ kind: "format", message: `cannot tell how to read ${filename}` });
  const parsed = adapterFor(source).parse({ format, filename, text, now });
  if (!parsed.ok) return parsed;
  let applied;
  try {
    applied = store.applySnapshot(parsed.value, contentHash, filename);
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not store snapshot";
    return err({ kind: "link", message });
  }
  let webhookError: string | null = null;
  const webhook = store.webhook();
  if (applied.alerts.length > 0 && webhook.enabled && webhook.url) {
    const body = JSON.stringify({ alerts: applied.alerts });
    try {
      await (hooks?.postWebhook ?? postJson)(webhook.url, body);
    } catch (error) {
      webhookError = error instanceof Error ? error.message : "webhook failed";
    }
  }
  return ok({
    outcome: "applied",
    contentHash,
    source,
    baseline: applied.baseline,
    messages: applied.messages,
    changeIds: applied.changes.map((change) => change.id),
    alerts: applied.alerts,
    webhookError,
  });
}

async function postJson(url: string, body: string): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`webhook responded ${response.status}`);
}
