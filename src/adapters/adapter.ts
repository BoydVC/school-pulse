import type { Source, SnapshotDocument, SnapshotFormat } from "../domain/index.ts";
import type { SchoolSnapshot } from "../domain/index.ts";
import type { Result } from "../domain/index.ts";

export type AdapterFailure =
  | { readonly kind: "unsupported_format"; readonly source: Source; readonly format: string }
  | { readonly kind: "parse"; readonly source: Source; readonly message: string }
  | { readonly kind: "invalid"; readonly source: Source; readonly path: string; readonly message: string };

/**
 * Adapters are pure parsers. They never write to a school system.
 * Live network reads, when a source has one, return the same SchoolSnapshot.
 */
export interface SchoolAdapter {
  readonly source: Source;
  readonly formats: readonly SnapshotFormat[];
  parse(document: SnapshotDocument): Result<SchoolSnapshot, AdapterFailure>;
}

export function explainAdapter(failure: AdapterFailure): string {
  switch (failure.kind) {
    case "unsupported_format":
      return `${failure.source} cannot read ${failure.format}`;
    case "parse":
      return `${failure.source}: ${failure.message}`;
    case "invalid":
      return `${failure.source} ${failure.path}: ${failure.message}`;
  }
}
