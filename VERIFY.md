# Arena verification — School Pulse v1

Three draft PRs were checked and none were merged. The winner is a graft, not a vote.

| Seat | PR | Branch | Tests | `tsc --strict` |
| --- | --- | --- | --- | --- |
| types-first | #1 | `arena/types-first` | 27/27 | clean |
| experience-first | #2 | `arena/experience-first` | 38/38 | clean (server and dashboard) |
| adapters-first | #3 | `arena/adapters-first` | 17/17 | clean |

Host clock for the probes was UTC. "Today" was checked at `2026-11-02T22:30:00Z` (5:30pm Eastern Standard Time).

## Scorecard

| Check | types-first | experience-first | adapters-first |
| --- | --- | --- | --- |
| Spec demo (2 students, 3+ sources, 12+ assignments, live inbox) | pass (2 students, 4 sources) | pass (2 students, 3 sources, 17 assignments) | pass (2 students, 4 sources, 33 active) |
| Idempotent re-ingest | pass | pass | pass |
| Each adapter has fixture tests | pass, on invented shapes | pass, on simplified shapes | pass, on portal and API shapes |
| README quick start, adapters, privacy | pass | pass, but `npm run ingest` was not a script | pass |
| `screenshots/demo.gif` synthetic | pass | pass | pass |
| GitHub Actions | pass | pass | pass |
| Real PowerSchool / Graph / Classroom shapes | fail | partial (scores HTML only) | pass |
| `docs/ADAPTERS.md` | missing | missing | pass |
| Today / this week in America/New_York, not UTC | fail (hard-coded UTC) | fail (process local timezone) | fail (UTC calendar date) |
| 375px without horizontal scroll | fail (534px scroll width) | pass | pass |
| Keyboard-only | partial (1–5, j/k, t, ?; Enter is documented and not wired) | pass (H W M G C, J/K, Enter, T, ?) | partial (1–5, t, ?; no j/k) |
| Dark and light | pass | pass | pass |
| Tonight view | missing | pass | missing |
| Cross-seat fixtures | fail closed (clear errors, almost no parses) | fail open (parses garbage names) | fail closed on foreign shapes |
| Malformed HTML/JSON | rejected | empty success for a fragment and a non-array | TypeError on a non-array `assignments` |
| Older snapshot after a newer grade | displayed 91, no rewind | displayed 91, no rewind | displayed 91, no rewind |
| OAuth loopback | missing (bring your own bearer) | missing | documented only |
| `POST /api/ingest` | pass | pass | pass |
| Domain brands and SQLite CHECKs | pass | missing | missing |
| Privacy OCR of GIFs and PNGs | synthetic only | synthetic only | synthetic only (see below) |

## What broke

### Timezone

types-first and adapters-first compute "today" and the Monday week with `getUTCDay` / `toISOString().slice(0, 10)`. At 22:30Z on 2 November, an assignment due `2026-11-03T03:30:00Z` (10:30pm Eastern) was not today, and `2026-11-02T04:30:00Z` (11:30pm Eastern on 1 November) was today. adapters-first stored the ISO instant as the civil date `2026-11-03`.

experience-first uses `Date#setHours` and `getDay`, so it follows the machine. With `TZ=America/New_York` the same pair landed on the right days. With `TZ=UTC` it matched the other two seats. The running demo on this UTC host showed **Monday Nov 2 · 6:17 PM**, which is the host clock, not Eastern.

### Cross-fixtures

types-first parsed its own seven fixtures and rejected the other seats' portal HTML and API JSON (`missing student header`, empty household key, and similar). adapters `club.csv` parsed as zero assignments.

experience-first returned success for adapters-first PowerSchool HTML with the student name **Class Score Detail** or **Grades and Attendance**, and for the OneNote class notebook with the student name **Science**. Those are page titles, not children.

adapters-first rejected foreign shapes with `AdapterError` instead of inventing a student. It did not understand the other seats' simplified PowerSchool JSON or Classroom export.

### Malformed input

types-first returned a parse error for empty input, truncated JSON, prose, a fragment, a bad status, and a NUL. experience-first threw on bad JSON and a bad status, and returned an empty snapshot for `<table>…` and for `{ "assignments": "nope" }`. adapters-first rejected most of those, then threw `(file.assignments ?? []).map is not a function` on the non-array.

### Layout and keyboard

At 375×812, experience-first and adapters-first stayed within the viewport (`scrollWidth` 375). types-first overflowed (`scrollWidth` 534): the nav ran off into Grades and Changes. Keyboard probes drove each running demo. experience-first switched Tonight / Week / Missing / Grades / Changes, moved focus with J, opened help with ?, and toggled dark. types-first and adapters-first did the same with 1–5, T, and ?. types-first's help lists Enter to open a student; the handler never does.

### Privacy

Tesseract on every PNG and on one frame per second of each GIF found Student A, Student B, Pinecrest Middle, Riverbend Elementary, Northwind-style class names, and Teacher labels. No email addresses, phone numbers, or long numeric IDs. The adapters GIF OCR emitted "Gianna" and "Renee"; the frame itself is the Changes list for Student A and Student B, and the extra words are the desktop and browser chrome around a full-screen capture. Nothing in that frame is a real student.

## Base

**experience-first is the base.** It is the only seat whose dashboard already answers "what needs attention tonight", works at 375px, and can be driven from the keyboard, including focus and Enter. The other two seats render the data. They do not lead with it.

types-first would have been the stricter core, and adapters-first the better parser, but both would have meant rebuilding the evening view. The graft keeps that view and replaces the parts the probes showed were wrong.

## Graft

- **From experience-first:** household UI, tonight strip, sparklines, plain-language changes, SSE, dark and light, 375px layout, keyboard map, demo story, alert rules off by default.
- **From adapters-first:** PowerSchool, OneNote, and Classroom parsers, `src/faithful/`, `fixtures/portal/`, and `docs/ADAPTERS.md`. Real portal HTML and list payloads take this path. The demo's normalized JSON still has a fallback parser so the evening story keeps seeding.
- **From types-first:** `src/domain` constructors (status, points, percent, letter) and the same rules as SQLite `CHECK`s. Missing work is stored with earned 0. A graded row without points, or a grade with neither percent nor letter, cannot be inserted.
- **Added on top:** `SCHOOL_PULSE_TZ` defaulting to `America/New_York` for every day and week boundary, including the demo seed and the on-screen clock. `school-pulse auth classroom` and `school-pulse auth onenote` run a loopback PKCE flow with read-only scopes and write `data/tokens/`. `school-pulse sync` only GETs. `POST /api/ingest` is documented in `docs/ADAPTERS.md` and returns 400 on a bad body.

## Bugs left open

OAuth still needs a desktop client id in the environment. This repo does not ship one.

The six ingest bugs from the first verification are fixed on this branch, each with a regression test in `tests/regressions.test.ts`:

- A later OneNote page marks missing homework `Removed:` in the change feed and keeps the row.
- A PowerSchool scores page with no section `frn` fails closed.
- An HTML fragment is rejected.
- `RETURNED` with `assignedGrade: null` is excused. A returned row with the field omitted is turned in, and the note says the excused state is unknown.
- `missing_above` prints the threshold as a count.
- The first import of any size writes one `baseline loaded` feed item.
