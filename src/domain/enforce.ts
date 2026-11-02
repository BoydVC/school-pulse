import type { NormalizedAssignment, NormalizedSnapshot, RejectedRow } from "../adapters/types.js";
import { assignmentDraft, explain, gradeValue, parseSource, type AssignmentDraft, type Source } from "./index.js";
import { slug } from "../util/text.js";

/**
 * Coerce adapter output onto the domain invariants, then refuse anything the
 * constructors still reject. SQLite CHECK constraints repeat the same rules.
 */
export function enforceSnapshot(snapshot: NormalizedSnapshot): NormalizedSnapshot {
  const source = parseSource(snapshot.source);
  if (!source.ok) throw new Error(explain(source.error));
  const householdByStudent = new Map(snapshot.students.map((student) => [student.sourceId, slug(student.name)]));
  const rejected: RejectedRow[] = [...(snapshot.rejected ?? [])];
  const assignments: NormalizedAssignment[] = [];
  snapshot.assignments.forEach((assignment, index) => {
    try {
      assignments.push(enforceAssignment(source.value, assignment, householdByStudent.get(assignment.studentSourceId) ?? "student"));
    } catch (error) {
      if (source.value !== "generic") throw error;
      const reason = error instanceof Error ? error.message : "row was rejected";
      rejected.push({ index: assignment.rowIndex ?? index, reason });
    }
  });
  rejected.sort((a, b) => a.index - b.index);
  return {
    ...snapshot,
    source: source.value,
    assignments,
    rejected,
    grades: snapshot.grades.flatMap((grade) => {
      let letter = grade.letter;
      let percent = grade.percent;
      let parsed = gradeValue(percent, letter);
      if (!parsed.ok && letter) {
        letter = null;
        parsed = gradeValue(percent, null);
      }
      if (!parsed.ok) return [];
      return [{ ...grade, percent: parsed.value.percent, letter: parsed.value.letter }];
    }),
  };
}

function enforceAssignment(source: Source, assignment: NormalizedAssignment, household: string): NormalizedAssignment {
  const coerced = coercePoints(assignment);
  const category = cleanCategory(coerced.category);
  const url = httpOrNull(coerced.url);
  const draft = assignmentDraft({
    source,
    sourceId: coerced.sourceId,
    householdKey: household,
    courseName: "Course",
    title: cleanTitle(coerced.title),
    status: coerced.status,
    earned: coerced.pointsEarned,
    possible: coerced.pointsPossible,
    assignedAt: coerced.assigned,
    dueAt: coerced.due,
    category,
    url,
  });
  if (!draft.ok) throw new Error(`${coerced.title}: ${explain(draft.error)}`);
  return {
    ...coerced,
    status: draft.value.status,
    pointsEarned: earnedOf(draft.value.points),
    pointsPossible: draft.value.points.possible,
    category,
    title: cleanTitle(coerced.title),
  };
}

function coercePoints(assignment: NormalizedAssignment): NormalizedAssignment {
  let status = assignment.status;
  let earned = assignment.pointsEarned;
  let possible = assignment.pointsPossible;
  if (possible !== null && (!(possible > 0) || !Number.isFinite(possible))) possible = null;
  if (earned !== null && (!Number.isFinite(earned) || earned < 0)) earned = null;
  if (status === "missing") {
    earned = 0;
  } else if (status === "graded") {
    if (earned === null || possible === null || earned > possible) {
      status = earned === null ? "assigned" : "turned_in";
      earned = null;
    }
  } else if (status === "assigned" || status === "turned_in" || status === "excused") {
    earned = null;
  } else if (status === "late" && earned !== null && possible !== null && earned > possible) {
    earned = possible;
  }
  return { ...assignment, status, pointsEarned: earned, pointsPossible: possible };
}

function cleanCategory(value: string | null): string | null {
  if (!value) return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.includes("@")) return null;
  return text.slice(0, 40);
}

function cleanTitle(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.slice(0, 160) || "Assignment";
}

function httpOrNull(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
  } catch {
    return null;
  }
  return null;
}

function earnedOf(points: AssignmentDraft["points"]): number | null {
  if (points.kind === "ungraded") return null;
  return points.earned;
}
