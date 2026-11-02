import type { ChangeRow, Store } from './store.js';
import { shortHash } from './text.js';

export interface AlertFire {
  ruleId: string;
  summary: string;
  payload: Record<string, unknown>;
  delivered: boolean;
}

export async function evaluateAlerts(
  store: Store,
  changes: ChangeRow[],
  fetchImpl: typeof fetch = fetch,
): Promise<AlertFire[]> {
  const rules = store.listAlertRules().filter((rule) => rule.enabled === 1 || rule.enabled === true);
  if (rules.length === 0 || changes.length === 0) return [];
  const dashboard = store.state();
  const fired: AlertFire[] = [];
  const queue: { ruleId: string; kind: string; threshold: number; webhook: string | null; summary: string; at: string; source: string }[] = [];
  for (const rule of rules) {
    const webhook = rule.webhook;
    if (rule.kind === 'missing_above') {
      if (!changes.some((change) => change.summary.startsWith('Missing:'))) continue;
      for (const student of dashboard.students) {
        if (rule.student_id && rule.student_id !== student.id) continue;
        if (student.missing > rule.threshold) {
          queue.push({
            ruleId: rule.id,
            kind: rule.kind,
            threshold: rule.threshold,
            webhook,
            summary: `${student.name} has ${student.missing} missing`,
            at: changes[0]?.at ?? new Date().toISOString(),
            source: changes[0]?.source ?? 'generic',
          });
        }
      }
      continue;
    }
    for (const change of changes) {
      const summary = matchRule(rule.kind, rule.threshold, change);
      if (!summary) continue;
      queue.push({ ruleId: rule.id, kind: rule.kind, threshold: rule.threshold, webhook, summary, at: change.at, source: change.source });
    }
  }
  for (const item of queue) {
    const payload = { ruleId: item.ruleId, kind: item.kind, threshold: item.threshold, summary: item.summary, at: item.at, source: item.source };
    let delivered = false;
    if (item.webhook) {
      try {
        const response = await fetchImpl(item.webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        delivered = response.ok;
      } catch {
        delivered = false;
      }
    }
    store.recordAlert({
      id: `alert:${shortHash(`${item.ruleId}|${item.summary}|${item.at}`)}`,
      ruleId: item.ruleId,
      summary: item.summary,
      payload,
      at: item.at,
      delivered,
    });
    fired.push({ ruleId: item.ruleId, summary: item.summary, payload, delivered });
  }
  return fired;
}

function matchRule(kind: string, threshold: number, change: ChangeRow): string | null {
  if (kind === 'grade_drop' && change.kind === 'grade') {
    const match = /went from (\d+(?:\.\d+)?) to (\d+(?:\.\d+)?)/.exec(change.summary);
    if (!match?.[1] || !match[2]) return null;
    const drop = Number(match[1]) - Number(match[2]);
    if (drop >= threshold) return change.summary;
  }
  if (kind === 'grade_below' && change.kind === 'grade') {
    const match = /to (\d+(?:\.\d+)?)/.exec(change.summary);
    if (match?.[1] && Number(match[1]) < threshold) return change.summary;
  }
  return null;
}
