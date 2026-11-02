import type { AssignmentStatus } from "./types.js";

export function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function gradePhrase(percent: number | null, letter: string | null): string {
  if (percent != null) return formatPercent(percent);
  if (letter) return letter;
  return "ungraded";
}

export function describeGradeChange(
  courseName: string,
  beforePercent: number | null,
  beforeLetter: string | null,
  afterPercent: number | null,
  afterLetter: string | null,
): string {
  if (beforePercent != null && afterPercent != null) {
    return `${courseName} went from ${formatPercent(beforePercent)} to ${formatPercent(afterPercent)}`;
  }
  return `${courseName} went from ${gradePhrase(beforePercent, beforeLetter)} to ${gradePhrase(afterPercent, afterLetter)}`;
}

export function describeNewAssignment(title: string, duePhrase: string | null): string {
  if (!duePhrase) return `New: ${title}`;
  return `New: ${title} due ${duePhrase}`;
}

export function describeStatusChange(
  title: string,
  status: AssignmentStatus,
  pointsEarned: number | null,
  pointsPossible: number | null,
): string {
  switch (status) {
    case "turned_in":
      return `${title} turned in`;
    case "graded":
      if (pointsEarned != null && pointsPossible != null) {
        return `${title} scored ${formatPercent(pointsEarned)}/${formatPercent(pointsPossible)}`;
      }
      return `${title} graded`;
    case "missing":
      return `${title} marked missing`;
    case "late":
      return `${title} is late`;
    case "excused":
      return `${title} excused`;
    default:
      return `${title} assigned`;
  }
}

export function describeDueChange(title: string, duePhrase: string | null): string {
  if (!duePhrase) return `${title} due date cleared`;
  return `${title} moved to ${duePhrase}`;
}

export function describeMoved(title: string, courseName: string): string {
  return `${title} moved to ${courseName}`;
}

export function describeScoreChange(title: string, earned: number | null, possible: number | null): string {
  if (earned != null && possible != null) {
    return `${title} scored ${formatPercent(earned)}/${formatPercent(possible)}`;
  }
  return `${title} score updated`;
}
