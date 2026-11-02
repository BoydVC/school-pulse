# School Pulse

A self-hosted live dashboard for one household. It reads grades, assignments, and homework from PowerSchool, OneNote class notebooks, Google Classroom, or a JSON/CSV drop, and keeps a single page current: due today and this week, missing and late work, grade trends, and a change feed.

All sample students in this repository are synthetic. Real data never belongs in git.

## Quick start

```bash
npm install
npm run demo
```

Open the URL it prints (http://127.0.0.1:4173 by default). You should see Student A and Student B at Pinecrest Middle, work from four sources, and an empty change feed.

In another terminal, drop the generated update into the inbox:

```bash
cp data/examples/powerschool-update.json data/inbox/powerschool/
```

The overview updates without a refresh: Math 7 moves, and the feed says what changed. Dropping that same file again does nothing.

Other commands:

```bash
npm run school-pulse -- serve --data ./data --port 4173
npm run school-pulse -- ingest ./fixtures/powerschool/portal.html --source powerschool
npm test
```

`SCHOOL_PULSE_DATA` overrides the data directory. `SCHOOL_PULSE_PORT` overrides the port. The server binds to 127.0.0.1 only.

Keyboard: `1`–`5` switch views, `j`/`k` move, Enter opens a student, `t` toggles the theme, `?` shows help. The layout works at 375px.

## Adapters

Each adapter turns a saved snapshot into the same records: students, courses, assignments, and grade snapshots. Nothing in an adapter submits work or messages a teacher.

| Source | Required input | Live read |
| --- | --- | --- |
| `powerschool` | Saved parent-portal HTML, or the JSON shape in `fixtures/powerschool/grades.json` | Snapshot import only. Save the grades and assignment pages from the browser. |
| `onenote` | Exported page HTML, or a Graph `pages` payload whose `content` is the page HTML | `school-pulse pull onenote` with a Graph token. GET only. |
| `google-classroom` | Courses, courseWork, and studentSubmissions JSON | `school-pulse pull google-classroom` with a guardian or student token. GET only. |
| `generic` | JSON or CSV matching `fixtures/generic/` | This is the drop-in for a script. |

Put files in `data/inbox/<source>/`. JSON, HTML, and CSV are picked up on their own. `POST /api/ingest` on localhost accepts `{ "source", "filename", "text" }`.

The first snapshot for a source is the baseline: it fills the board and does not flood the change feed. A later snapshot upserts on `(source, sourceId)` and records a grade change, a new assignment, a status change, or a score change. The same bytes are ignored.

Classroom and OneNote pulls read a token from `SCHOOL_PULSE_CLASSROOM_TOKEN` / `SCHOOL_PULSE_ONENOTE_TOKEN`, or from `data/secrets/google-classroom.token` and `data/secrets/onenote.token`. Copy `config/students.example.json` to `data/students.json` so the pull knows which synthetic household key to attach. Tokens stay in the data directory.

### Generic CSV

Header: `recordType,householdKey,displayName,schoolName,sourceId,course,teacher,period,courseSourceId,title,status,earned,possible,due,assigned,category,url,percent,letter,asOf`.

`recordType` is `student`, `course`, `assignment`, or `grade`. See `fixtures/generic/assignments.csv`.

### Alerts

Off by default. Rules are `grade_below`, `missing_above`, and `grade_drop`.

```bash
curl -s -X PUT http://127.0.0.1:4173/api/alerts/rules \
  -H 'content-type: application/json' \
  -d '{"rules":[{"kind":"grade_drop","enabled":true,"points":5},{"kind":"grade_below","enabled":false,"threshold":70},{"kind":"missing_above","enabled":false,"count":3}]}'

curl -s -X PUT http://127.0.0.1:4173/api/alerts/webhook \
  -H 'content-type: application/json' \
  -d '{"url":"http://127.0.0.1:9/hook","enabled":true}'
```

Fired alerts are stored and, only when a webhook URL is enabled, POSTed as `{ "alerts": [...] }`. With the defaults, ingest never calls out.

## Privacy

- The repo, fixtures, screenshots, and demo use names like Student A and Pinecrest Middle. Do not add real student names, emails, school domains, or IDs.
- Live data stays in `./data` (git-ignored) or `SCHOOL_PULSE_DATA`.
- School access is read-only. There is no path that submits an assignment, sends a message, or writes back to a source.
- Credentials are environment variables or token files under the data directory. They are not read from the repo.
- The web app listens on localhost. You choose if a webhook leaves the machine.

## Development

Node 22 or newer. `npm test` typechecks with `tsc --strict` (including `noUncheckedIndexedAccess`) and runs the fixture tests. CI is `.github/workflows/ci.yml`.
