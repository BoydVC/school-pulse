import type { DatabaseSync } from "node:sqlite";
import { formatPercent } from "../model/english.js";
import type { Alert, AlertRuleType } from "../model/types.js";
import {
  alertExists,
  getSetting,
  insertAlert,
  listAlerts,
  listAssignments,
  listCourses,
  listGradesForCourse,
  listRules,
  listStudents,
  replaceRules,
  setSetting,
} from "../store/db.js";

export function evaluateAlerts(db: DatabaseSync, now: Date): Alert[] {
  const rules = listRules(db).filter((rule) => rule.enabled);
  if (rules.length === 0) return [];
  const students = listStudents(db);
  const courses = listCourses(db);
  const assignments = listAssignments(db);
  const nameOf = (studentId: string): string => students.find((student) => student.id === studentId)?.name ?? "Student";
  const fired: Alert[] = [];

  for (const rule of rules) {
    if (rule.type === "grade_below") {
      for (const course of courses) {
        const studentName = nameOf(course.studentId);
        if (rule.studentName && rule.studentName !== studentName) continue;
        const snaps = listGradesForCourse(db, course.id);
        const latest = snaps[snaps.length - 1];
        if (latest?.percent == null || latest.percent >= rule.threshold) continue;
        const dedupeKey = `${rule.id}:grade_below:${course.id}`;
        if (alertExists(db, dedupeKey)) continue;
        fired.push(
          insertAlert(db, {
            ruleId: rule.id,
            summary: `${course.name} is ${formatPercent(latest.percent)} for ${studentName}, below ${formatPercent(rule.threshold)}`,
            dedupeKey,
            createdAt: now.toISOString(),
            source: course.source,
          }),
        );
      }
    }

    if (rule.type === "missing_above") {
      const counts = new Map<string, number>();
      for (const assignment of assignments) {
        if (assignment.status !== "missing") continue;
        const studentName = nameOf(assignment.studentId);
        counts.set(studentName, (counts.get(studentName) ?? 0) + 1);
      }
      for (const [studentName, count] of counts) {
        if (rule.studentName && rule.studentName !== studentName) continue;
        if (count <= rule.threshold) continue;
        const dedupeKey = `${rule.id}:missing:${studentName}`;
        if (alertExists(db, dedupeKey)) continue;
        fired.push(
          insertAlert(db, {
            ruleId: rule.id,
            summary: `${studentName} has ${count} missing, above ${formatPercent(rule.threshold)}`,
            dedupeKey,
            createdAt: now.toISOString(),
            source: "household",
          }),
        );
      }
    }

    if (rule.type === "grade_drop") {
      for (const course of courses) {
        const studentName = nameOf(course.studentId);
        if (rule.studentName && rule.studentName !== studentName) continue;
        const snaps = listGradesForCourse(db, course.id);
        const latest = snaps[snaps.length - 1];
        const previous = snaps.length >= 2 ? snaps[snaps.length - 2] : undefined;
        if (!latest || !previous || latest.percent == null || previous.percent == null) continue;
        const drop = previous.percent - latest.percent;
        if (drop + 1e-6 < rule.threshold) continue;
        const dedupeKey = `${rule.id}:drop:${course.id}:${latest.id}`;
        if (alertExists(db, dedupeKey)) continue;
        fired.push(
          insertAlert(db, {
            ruleId: rule.id,
            summary: `${course.name} dropped ${formatPercent(drop)} points for ${studentName}`,
            dedupeKey,
            createdAt: now.toISOString(),
            source: course.source,
          }),
        );
      }
    }
  }

  return fired;
}

export function saveRules(
  db: DatabaseSync,
  rules: Array<{ id?: string; enabled?: boolean; type: AlertRuleType; threshold: number; studentName?: string | null }>,
  now: Date,
): void {
  replaceRules(
    db,
    rules.map((rule) => ({
      id: rule.id,
      enabled: rule.enabled ?? false,
      type: rule.type,
      threshold: rule.threshold,
      studentName: rule.studentName ?? null,
    })),
    now,
  );
}

export function readAlerts(db: DatabaseSync, now: Date): { rules: ReturnType<typeof listRules>; webhook: string | null; alerts: Alert[] } {
  evaluateAlerts(db, now);
  return { rules: listRules(db), webhook: getSetting(db, "webhook_url"), alerts: listAlerts(db) };
}

export async function deliverWebhooks(db: DatabaseSync, alerts: Alert[]): Promise<void> {
  if (alerts.length === 0) return;
  const url = getSetting(db, "webhook_url");
  if (!url) return;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ alerts }),
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`Webhook responded ${response.status}`);
}

export function setWebhook(db: DatabaseSync, url: string | null): void {
  if (url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Webhook URL must be http or https.");
    }
  }
  setSetting(db, "webhook_url", url);
}
