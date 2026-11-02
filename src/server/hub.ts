import type { ServerResponse } from "node:http";
import type { IngestResult } from "../ingest/ingest.js";

export interface Pulse {
  changeIds: string[];
  assignmentIds: string[];
  courseIds: string[];
  summaries: string[];
}

export interface Hub {
  add(response: ServerResponse): void;
  remove(response: ServerResponse): void;
  publish(result: IngestResult): void;
}

export function createHub(): Hub {
  const clients = new Set<ServerResponse>();
  return {
    add(response) {
      clients.add(response);
    },
    remove(response) {
      clients.delete(response);
    },
    publish(result) {
      if (result.unchanged || result.changes.length === 0) return;
      const ordered = result.changes.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const pulse: Pulse = {
        changeIds: ordered.map((change) => change.id),
        assignmentIds: ordered.flatMap((change) => (change.assignmentId ? [change.assignmentId] : [])),
        courseIds: ordered.flatMap((change) => (change.courseId ? [change.courseId] : [])),
        summaries: ordered.map((change) => change.summary),
      };
      const message = `event: pulse\ndata: ${JSON.stringify(pulse)}\n\n`;
      for (const client of clients) {
        try {
          client.write(message);
        } catch {
          clients.delete(client);
        }
      }
    },
  };
}
