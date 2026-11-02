# School Pulse

A local, read-only board of a household's grades, assignments, and homework. One page shows what is due, what is missing or late, the current grade in each class with its trend, and a feed of what just changed.

PowerSchool, OneNote class notebooks, Google Classroom, and a generic JSON or CSV feed all land in the same model. The copy in this repository is synthetic: Student A, Student B, Pinecrest Middle, Northwind High. Real names, emails, and school domains do not belong here.

## Two-minute quick start

```bash
npm install
npm test
npx school-pulse demo
```

Open http://127.0.0.1:4317 . The demo seeds two students, four sources, and more than a dozen assignments for the week of 2 November 2026. OneNote starts stale on purpose.

Drop another snapshot into the inbox. The board updates live:

```bash
cp fixtures/demo/science-lab.json data/inbox/onenote/
```

The change feed should read **New: Science lab due Fri**.

Other commands:

```bash
npx school-pulse serve          # same board, your own data directory
npx school-pulse ingest <file>  # one snapshot, no server
npx school-pulse sync           # optional live GET, if a token file exists
```

`SCHOOL_PULSE_DATA` overrides the data directory (default `./data`). `SCHOOL_PULSE_PORT` is not read; pass `--port`. Stale badges use `SCHOOL_PULSE_STALE_HOURS` (default 36).

Keyboard: `1`–`5` switch views, `[` and `]` switch students, `t` toggles theme, `?` lists shortcuts. The layout fits a 375px screen. Alerts are off until you put a rule in `PUT /api/alerts/rules`.

## Adapters

See [docs/ADAPTERS.md](docs/ADAPTERS.md) for how a parent connects each source: Classroom OAuth scopes, Graph scopes, and a PowerSchool snapshot export. Parsers are fixture-tested against those public shapes.

| Source | What you give School Pulse | Live fetch |
| --- | --- | --- |
| PowerSchool | Saved guardian home and scores HTML | Not in v1. Many districts only allow a browser sign-in. |
| OneNote | Graph page JSON with inlined HTML, or an exported page | Optional `Notes.Read` GET |
| Google Classroom | `courses.list`, `courseWork.list`, `studentSubmissions.list` JSON | Optional student or teacher read-only token |
| Generic | JSON or CSV in the core shape | Inbox drop or `POST /api/ingest` |

Re-ingesting the same file is a no-op. The same `source` + `sourceId` updates in place, and a grade change becomes a sentence like "Math went from 91 to 84".

## Privacy

School Pulse is self-hosted and read-only. It does not submit work, message teachers, or write back to a school system.

- Synthetic fixtures, screenshots, and the demo GIF are the only student data in git.
- Real exports, tokens, and the SQLite file stay in `./data` (gitignored) or `SCHOOL_PULSE_DATA`.
- The web server binds to `127.0.0.1`.
- Tokens are read from the environment or `data/tokens/` and are never printed.
- Classroom sync strips email fields before writing a snapshot.
- Alert webhooks are off by default. Nothing is sent unless you enable a rule and set a URL.

## Develop

```bash
npm test          # tsc --strict and the fixture suite
npm run build
```

Node 22 or newer. CI is `.github/workflows/ci.yml`.
