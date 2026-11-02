# School Pulse — spec v0.1

## Goal
A generic, open-source, self-hosted live dashboard that tracks K-12 students' grades, assignments and homework across several school systems. A parent opens one page and sees, per student and for the household: due today / this week, missing and late work, current grade per class with trend, and recent changes. It replaces a once-a-day text summary.

## Hard rules
- Public repo: synthetic students and schools only (e.g. "Student A", "Pinecrest Middle"). No real names, emails, IDs or school domains anywhere in code, fixtures, screenshots or GIFs.
- Real data lives only in a local data dir (default `./data/`, git-ignored) or a path in `SCHOOL_PULSE_DATA`.
- Read-only toward schools: never submit work, message teachers, or change anything in a source system.
- No credentials in the repo. Adapters receive auth via env vars, OAuth token files in the data dir, or browser-exported snapshots.

## Architecture
1. Core model (TypeScript, strict): Student, Course, Assignment (title, course, due, assigned, status: assigned|turned_in|graded|missing|late|excused, points earned/possible, category, url, source, sourceId, lastSeen), GradeSnapshot (course, percent, letter, asOf), Change (diff between snapshots). Every record carries `source` and `fetchedAt`.
2. Adapters, each producing the core model from a snapshot:
   - powerschool: parse saved PowerSchool parent-portal HTML/JSON (grades and assignment detail pages). Live fetch is optional; snapshot import is required, because many schools only allow browser sign-in.
   - onenote: Microsoft Graph OneNote pages (class notebook homework pages) or exported page HTML -> assignments with due dates via date parsing.
   - google-classroom: official Classroom API (courses, courseWork, studentSubmissions) with a guardian or student OAuth token; also accept JSON exports.
   - generic: JSON or CSV drop-in matching the core schema (how bots/scripts push data).
3. Ingest: a watched inbox folder (`data/inbox/<source>/*.json|html|csv`) plus `POST /api/ingest` on localhost. Idempotent: same sourceId + source upserts; snapshots are diffed into Change events.
4. Store: SQLite (single file in the data dir).
5. Dashboard: a local web app that updates live (SSE or websocket) when ingest lands new data. Views: Household overview, per-student page, Due this week, Missing/late, Grades with sparkline trends, Change feed ("Math went from 91 to 84", "New: Science lab due Fri"). Freshness badge per source ("PowerSchool 2h ago"), and stale sources flagged. Keyboard-first, phone friendly (375px), dark and light modes.
6. Alerts (optional, off by default): rules like grade below X, missing count above N, or a big drop; exposed as an API and webhook so the owner can wire their own notifications.
7. CLI: `school-pulse serve`, `school-pulse ingest <file>`, `school-pulse demo` (seeds synthetic data and starts the dashboard).

## Acceptance
- `npm test` green and `tsc --strict` clean. Each adapter has fixture-based tests built from synthetic fixtures that mimic real page/API shapes.
- `school-pulse demo` shows 2 synthetic students, at least 3 sources and 12+ assignments, with live update visible when a new fixture is dropped into the inbox.
- Re-ingesting the same file changes nothing (idempotent).
- README with a 2-minute quick start, adapter docs, and a privacy section.
- `screenshots/demo.gif`, made with synthetic data only, showing the live update.
- CI on GitHub Actions.
