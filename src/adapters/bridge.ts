import type { ParsedBatch } from "../faithful/model.js";
import { activeTimezone, endOfCivilDate } from "../time/zone.js";
import type { NormalizedAssignment, NormalizedGrade, NormalizedSnapshot } from "./types.js";

/** Turn a source-faithful batch into the dashboard snapshot. Civil dates end on the household day. */
export function fromFaithful(batch: ParsedBatch, timeZone = activeTimezone()): NormalizedSnapshot {
  return {
    source: batch.source,
    fetchedAt: toInstant(batch.fetchedAt),
    students: batch.students.map((student) => ({
      sourceId: student.sourceId,
      name: student.name,
      school: student.school || null,
      gradeLevel: null,
    })),
    courses: batch.courses.map((course) => ({
      sourceId: course.sourceId,
      studentSourceId: course.studentSourceId,
      name: course.name,
      teacher: course.teacher,
      period: course.period,
    })),
    assignments: batch.assignments
      .filter((assignment) => !assignment.dropped)
      .map((assignment) => ({
        sourceId: assignment.sourceId,
        studentSourceId: assignment.studentSourceId,
        courseSourceId: assignment.courseSourceId,
        title: assignment.title,
        due: dueInstant(assignment.due, timeZone),
        assigned: dueInstant(assignment.assigned, timeZone),
        status: assignment.status,
        pointsEarned: assignment.pointsEarned,
        pointsPossible: assignment.pointsPossible,
        category: assignment.category,
        url: assignment.url,
      })),
    grades: batch.grades
      .filter((grade) => grade.percent !== null || (grade.letter !== null && grade.letter !== ""))
      .map((grade) => ({
        studentSourceId: grade.studentSourceId,
        courseSourceId: grade.courseSourceId,
        percent: grade.percent,
        letter: grade.letter,
        asOf: toInstant(grade.asOf),
      })),
  };
}

export function usableFaithful(batch: ParsedBatch): boolean {
  if (batch.students.length === 0) return false;
  if (batch.students.some((student) => /class score detail|grades and attendance/i.test(student.name))) return false;
  const named = batch.students.some((student) => student.school.trim().length > 0);
  if (!named && batch.grades.length === 0 && batch.assignments.length === 0) return false;
  if (batch.assignments.length === 0 && batch.grades.length === 0 && batch.courses.every((course) => course.name === "Class notebook")) {
    return false;
  }
  return batch.assignments.length + batch.grades.length + batch.courses.length > 0;
}

function dueInstant(due: string | null, timeZone: string): string | null {
  if (!due) return null;
  const text = due.trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return endOfCivilDate(text, timeZone).toISOString();
  return null;
}

function toInstant(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}

export type { NormalizedAssignment, NormalizedGrade };
