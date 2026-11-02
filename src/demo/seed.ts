import { ingestText } from "../ingest/ingest.ts";
import { explainIngest } from "../ingest/ingest.ts";
import type { IsoInstant } from "../domain/index.ts";
import { dashboard } from "../server/view.ts";
import type { Store } from "../store/store.ts";
import { demoDocuments, liveDocument, type DemoDocument } from "./documents.ts";

export async function seedDemo(store: Store, now: IsoInstant): Promise<{ students: number; assignments: number; sources: number }> {
  for (const document of demoDocuments(now)) {
    const result = await ingestText(store, document.source, document.text, document.filename, now);
    if (!result.ok) throw new Error(explainIngest(result.error));
  }
  const view = dashboard(store, now);
  return { students: view.students.length, assignments: view.assignments.length, sources: view.sources.length };
}

export function liveDrop(now: IsoInstant): DemoDocument {
  return liveDocument(now);
}
