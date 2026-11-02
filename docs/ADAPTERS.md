# Connecting a source

School Pulse reads snapshots. A parent saves or exports what they can already see, drops the file in `data/inbox/<source>/`, and the watcher upserts it. Live HTTP is optional, GET-only, and only for Classroom and OneNote. Nothing in this repo calls a school with a write method.

Auth lives in the environment or in `data/tokens/`. Do not commit either.

## PowerSchool (snapshot export)

Many parent portals only allow a browser session, so v1 does not log in. Save the pages you already use.

1. Sign in to the guardian portal in your browser.
2. Open **Grades and Attendance** (`/guardian/home.html`). Save the page.
3. Open each class **Class Score Detail** (`/guardian/scores.html?frn=…&fg=Q1`). Change the term selector and save Q2, S1, and so on as separate files. A later term does not delete the earlier term.
4. Put the HTML in `data/inbox/powerschool/`.

You can also wrap several saved pages:

```json
{
  "format": "powerschool-scores-html",
  "exportedAt": "2026-11-02T15:05:00Z",
  "student": { "name": "Student A", "school": "Pinecrest Middle", "sourceId": "10001" },
  "pages": [
    { "path": "/guardian/home.html", "html": "<!DOCTYPE html>…" },
    { "path": "/guardian/scores.html?frn=03110001&fg=Q2", "html": "<!DOCTYPE html>…" }
  ]
}
```

### What the parser expects

The fixtures follow the guardian portal's rendered tables, not a private API.

- Home quick lookup (`table.grid#quickLookup`): Exp, Course, Teacher, Absences, Tardies, then each store code (`Q1`, `Q2`, `S1`) as a pair of `%` and `Grade` columns. A `th.current` marks the term the portal is showing. Semester columns stay on file and do not replace the current quarter.
- Class Score Detail: `table.linkDescList` with Course, Teacher, Expression, Final Grade, then the assignment grid. The Codes header is `colspan="5"` (Collected, Late, Missing, Exempt, Excluded), then Score, `%`, Grd. Icons are the stock `/images/icon_*.gif` alts.
- The final grade on that page is authoritative. School Pulse does not recompute it from the rows.
- Category totals are the separate table whose headers are Category and Weight (`20%`, or relative weights such as `1, 1, 2`).
- A purple score (`<font color="purple">`) is Exempt, matching the parent-portal legend: purple means the score is out of the final grade.
- Excluded (or a whole assignment left out of the grade) is stored as dropped, which is not the same as excused.
- Missing wins when both the missing and late icons are set. A blank due date stays blank. A past due date without a missing icon stays assigned, because PowerSchool shows missing only when the gradebook flags it.
- `select[name=fg]` is the term. The section id is the hidden `frn`.
- Student and school come from `#account-name` and `#school-name`, or from the bundle. A `school-pulse-exported-at` meta tag is the save time School Pulse uses for freshness. It is not a PowerSchool field.

There is no live PowerSchool fetch. Do not put a portal password in the repo or the environment for this app.

## Google Classroom

The official read surface is three list methods:

- `GET https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE`
- `GET https://classroom.googleapis.com/v1/courses/{courseId}/courseWork?courseWorkStates=PUBLISHED`
- `GET https://classroom.googleapis.com/v1/courses/{courseId}/courseWork/-/studentSubmissions`

Optional, and often 403 or 404 for a student token: `courses.getGradingPeriodSettings` and `userProfiles.guardians`.

Save the JSON list responses, or let `school-pulse sync` do the GETs. A snapshot looks like `fixtures/classroom/student-b.json`: real list wrappers (`courses`, `courseWork`, `studentSubmissions`, `nextPageToken`), plus a `schoolPulse` block for the school name. Classroom does not return a school.

### OAuth scopes

Create a desktop OAuth client in Google Cloud. The steps are in [Google Cloud desktop OAuth client](#google-cloud-desktop-oauth-client) below. `school-pulse auth classroom --student <id>` writes `data/tokens/google-classroom.json`. That file holds one account per signed-in student. A single `{ "access_token": "…" }` file from an older install still syncs as student `legacy`. `SCHOOL_PULSE_CLASSROOM_TOKEN` is used only when the file has no accounts, and it cannot be refreshed.

Use read-only scopes. School Pulse never calls `turnIn`, `return`, `patch`, or `modifyAttachments`.

Student, reading their own classes:

- `https://www.googleapis.com/auth/classroom.courses.readonly`
- `https://www.googleapis.com/auth/classroom.coursework.me.readonly`
- `https://www.googleapis.com/auth/classroom.student-submissions.me.readonly` if your client still lists the submissions-specific scope; `coursework.me.readonly` is what `studentSubmissions.list` documents
- `https://www.googleapis.com/auth/classroom.guardianlinks.me.readonly` only if you want the guardian link list

Teacher or domain admin, reading one student:

- `https://www.googleapis.com/auth/classroom.courses.readonly`
- `https://www.googleapis.com/auth/classroom.coursework.students.readonly`
- `https://www.googleapis.com/auth/classroom.student-submissions.students.readonly` when the client distinguishes it
- `https://www.googleapis.com/auth/classroom.guardianlinks.students.readonly` for `userProfiles.guardians.list`

### Guardian access is not a grade scope

`userProfiles.guardians` and `guardianInvitations` say who is linked to a student. They do not return coursework or grades. A guardian Google account that only receives the guardian email summary cannot call `courses.list` or `studentSubmissions.list`. The working parent paths are:

1. The student signs in once with the read-only scopes above and you keep that token locally, or
2. You export the three list responses from a session that can already see the classes.

School Pulse ignores guardian profile names so "Guardian A" never becomes a student. It also drops `emailAddress` fields before writing a synced snapshot.

### How rows become assignments

Documented Classroom behavior that the fixtures lock in:

- `dueDate` is a calendar date (`month` is 1–12, not 0). `dueTime` is UTC time of day; missing hours mean 0. The board groups by the calendar date.
- No `dueDate` means no due date. That row is not inferred as missing.
- `StudentSubmission.state`: `NEW` (described in the prose for never-opened work; creation time may be absent) and `CREATED` are not turned in. `TURNED_IN`, `RETURNED`, and `STUDENT_EDITED_AFTER_TURN_IN` are turned in. `RECLAIMED_BY_STUDENT` is unsubmitted again.
- `late: true` on turned-in work is status `late`. Past due and still `NEW` / `CREATED` / reclaimed is status `missing`. Missing counts as `draftGrade`, which Classroom defaults to 0.
- `RETURNED` with a numeric `assignedGrade` is graded.
- **Excused is not a Classroom field.** The grades guide says complete, missing, and excused are not distinct `StudentSubmission` values. Heuristic: `RETURNED` with `"assignedGrade": null` (the key is present and the value is null) is excused, and those points stay out of the overall percent. `RETURNED` with the `assignedGrade` key omitted stays `turned_in`, and the snapshot note says the excused state is unknown. A numeric grade is never called excused.
- `DRAFT` and `DELETED` coursework are skipped.
- `assigneeMode: INDIVIDUAL_STUDENTS` whose `studentIds` omit this student is dropped (not assigned), not missing.
- `ARCHIVED` courses are skipped.
- `gradeCategory.weight` is basis points: 20% is `200000`, 100% is `1000000` (`weight / 10000`). Overall percent is computed locally. The API does not return it. Categories with no graded work are left out and the remaining weights are renormalized, which is what Classroom does.
- `displaySetting: HIDE_OVERALL_GRADE` stores the assignments and hides the percent.
- `gradingPeriodId` is the term. The current period is the one whose `startDate`/`endDate` contain the snapshot time. Older periods stay on the assignments and do not move the current percent.
- `maxPoints` of 0 or omitted is ungraded and stays out of the average.

## Microsoft Graph OneNote (class notebooks)

Class notebooks are ordinary OneNote notebooks. Homework lives in a section, usually named Homework or Quizzes, inside the student's section group. Graph does not give those pages an assignment resource. School Pulse reads page HTML from `GET /me/onenote/pages/{id}/content`.

A realistic export is a page list with each page's HTML inlined as `content`, because the content endpoint returns HTML rather than JSON. See `fixtures/onenote/science-homework.json`. A single saved page (`.html`) also works.

### Scopes

Delegated, read-only:

- `Notes.Read`

That is enough for notebooks shared with the signed-in student, including the student section group of a class notebook. Do not request `Notes.ReadWrite` or `Notes.Create`. School Pulse only GETs.

Token file: `data/tokens/microsoft-graph.json`, one account per signed-in student, written by `school-pulse auth onenote --student <id>`. A single `{ "access_token": "…" }` file still syncs as student `legacy`. `SCHOOL_PULSE_GRAPH_TOKEN` is used only when the file has no accounts.

`school-pulse sync` lists notebooks, keeps sections named Homework or Quizzes (the class-notebook defaults that actually hold work), and downloads each page's `contentUrl`.

### What the HTML parser reads

Graph output HTML uses `data-id`, `data-tag`, and often a table whose header cells are `<td>`, not `<th>`.

- `data-tag="to-do"` is open work. `data-tag="to-do:completed"` is turned in. Several tags can share one attribute (`important, to-do`).
- Dates are parsed from the cell or the sentence: `2026-11-06`, `11/06/2026`, `Friday, November 6, 2026`, or `Due Fri` relative to the page `createdDateTime`.
- No date means no due date.
- An open to-do whose date is before the page date is missing. The words missing, late, excused / exempt, and dropped / excluded in a status cell win over that guess.
- Points look like `18/20` or `(15 points)`.
- `Lab (40%)` is a category weight.
- The course is the notebook `displayName`. The student is the section group that is not `_Content Library`, `_Collaboration Space`, or `_Teacher Only`. `Q2` or `Term 2` on a parent section group is the term.
- The school is not on the page. Set `schoolPulse.school` in the export.
- Re-saving a page replaces that page's rows. A line that disappeared is marked dropped. Other pages are left alone.

## Generic JSON or CSV

For a script that already normalized some other system. Drop the file in `data/inbox/generic/` or `POST /api/ingest` on localhost.

JSON:

```json
{
  "source": "generic",
  "fetchedAt": "2026-11-02T16:50:00Z",
  "students": [{ "sourceId": "stu-a", "name": "Student A", "school": "Pinecrest Middle" }],
  "courses": [{
    "sourceId": "math",
    "student": "Student A",
    "name": "Math",
    "teacher": "Teacher A",
    "period": "1(A)",
    "term": "Q2",
    "percent": 84,
    "letter": "B",
    "categories": [{ "name": "Homework", "weight": 20 }]
  }],
  "assignments": [{
    "sourceId": "a1",
    "student": "Student A",
    "course": "Math",
    "title": "Problem set",
    "due": "2026-11-06",
    "assigned": "2026-11-01",
    "status": "assigned",
    "pointsEarned": null,
    "pointsPossible": 10,
    "category": "Homework"
  }]
}
```

`status` is one of `assigned`, `turned_in`, `graded`, `missing`, `late`, `excused`. Anything else is an error. CSV uses the same column names. A title that contains a comma belongs in quotes.

## Idempotency and terms

Records upsert on `(source, sourceId)`. The same bytes do not write again. A newer export of the same rows only moves freshness. An older export does not roll a newer grade backward; it can still add a historical snapshot.

A grade whose current percent changes becomes `Math went from 91 to 84`. A new row becomes `New: Science lab due Fri`, or `Missing: …` / `Late: …` when that is how it first appears. Same-term sparks are the current-grade series. A new quarter appends a point instead of erasing the previous term's assignments.

## Alerts

Off by default. `PUT /api/alerts/rules` with `enabled: true` and a `webhook`. Kinds:

- `grade_below` — a grade change landed under `threshold`
- `grade_drop` — the drop in points is at least `threshold`
- `missing_above` — a newly missing assignment pushed the student's missing count above `threshold`

The webhook receives JSON. A failed POST is recorded and does not fail the ingest.

## Household timezone

Every "today", "tonight", and "this week" calculation uses `SCHOOL_PULSE_TZ`, default `America/New_York`. The host clock being UTC does not move the school day. A due instant of `2026-11-03T03:30:00Z` is still Monday night in New York. A date with no time, such as Classroom `dueDate` or `2026-11-06`, ends at 23:59 in that zone. Week starts Monday.

DST follows the IANA zone. On the 2026 fall-back morning both 1:30am instants are 1 November. After the spring-forward, 07:30Z is 3:30am Eastern on 8 March.

## Sign in (`school-pulse auth`)

Read-only installed-app flow. The CLI binds `127.0.0.1` to a free port, prints an authorize URL, and waits for the browser to redirect to `http://127.0.0.1:<port>/callback`. PKCE S256. No client secret is required. If a secret is set it is sent only to the token endpoint, never written to the repo.

Sign in once per student. The id you pass is your household label (`stu-a`, `stu-b`). It is stored on that account. The file key is the signed-in email when the provider returns one, otherwise `id:<account id>`.

```bash
export SCHOOL_PULSE_GOOGLE_CLIENT_ID="your-desktop-client-id"
school-pulse auth classroom --student stu-a
school-pulse auth classroom --student stu-b

export SCHOOL_PULSE_GRAPH_CLIENT_ID="your-public-client-id"
school-pulse auth onenote --student stu-a
school-pulse auth onenote --student stu-b

school-pulse auth status
school-pulse sync
```

`school-pulse auth status` prints each account, the student id, whether a refresh token is saved, and the expiry. It does not print access tokens or refresh tokens. An account whose refresh failed is listed as `re-auth needed`.

Optional: `SCHOOL_PULSE_GOOGLE_CLIENT_SECRET`, `SCHOOL_PULSE_GRAPH_CLIENT_SECRET`, `SCHOOL_PULSE_GRAPH_TENANT` (default `common`). The same client id is set in the environment for `sync`, because a refresh call needs it.

Tokens land in `data/tokens/google-classroom.json` and `data/tokens/microsoft-graph.json` (mode 0600). Both files are version 2 stores:

```json
{
  "version": 2,
  "accounts": {
    "student.a@example.com": {
      "accountKey": "student.a@example.com",
      "email": "student.a@example.com",
      "accountId": "10001",
      "studentId": "stu-a",
      "access_token": "…",
      "refresh_token": "…",
      "token_type": "Bearer",
      "scope": "…",
      "expires_at": "2026-11-02T20:00:00.000Z",
      "reauth_needed": false,
      "reauth_reason": null,
      "updated_at": "2026-11-02T19:00:00.000Z"
    }
  }
}
```

A second student's sign-in adds another key. It does not remove the first. Signing the same account in again updates that key and leaves the others. The directory is git-ignored with the rest of `data/`. The browser page does not display the token. An older file that is only `{ "access_token": "…" }` is read as one account with student id `legacy`.

Classroom authorize requests `access_type=offline` and `prompt=consent`, so Google returns a refresh token. Scopes:

- `openid`
- `email`
- `https://www.googleapis.com/auth/classroom.courses.readonly`
- `https://www.googleapis.com/auth/classroom.coursework.me.readonly`
- `https://www.googleapis.com/auth/classroom.student-submissions.me.readonly`

Graph scopes: `offline_access`, `openid`, `email`, `User.Read`, and `https://graph.microsoft.com/Notes.Read`. `offline_access` is what makes Microsoft return a refresh token. `User.Read` and `email` are how the two students are told apart. There is no `Notes.ReadWrite`.

`school-pulse sync` GETs Classroom and OneNote once per saved account and writes each snapshot into the inbox. A token that expires within 60 seconds is refreshed first. A 401 refreshes once and the GET is retried. The new access token is written back. If the provider omits a new refresh token, the previous one stays. If the refresh is rejected, that account is marked and the dashboard freshness badge for the source reads `Classroom · stu-a · re-auth needed` (or `OneNote · … · re-auth needed`). Other students in the file keep syncing. Sync does not call turn-in, return, or page-update methods. PowerSchool has no auth command. Save the guardian pages into `data/inbox/powerschool/`.

Register the loopback redirect as an installed / desktop client. Google and Microsoft both allow `http://127.0.0.1` with a port chosen at runtime for native apps.

### Google Cloud desktop OAuth client

Do this once per household. The same desktop client signs in every student.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a project named `School Pulse`.
2. Enable the Classroom API. **APIs & Services → Library**, search **Google Classroom API**, click **Enable**. Direct link: `https://console.cloud.google.com/apis/library/classroom.googleapis.com`.
3. Open the consent screen. The current console calls this **Google Auth Platform → Branding**. The older label is **APIs & Services → OAuth consent screen**.
   - App name: `School Pulse`
   - User support email: your own email
   - Audience: **External**
   - Leave publishing status at **Testing**. You do not need Google to verify the app to use it for your own children.
4. Add scopes under **Google Auth Platform → Data Access** (older label: **Scopes**):
   - `openid`
   - `email`
   - `https://www.googleapis.com/auth/classroom.courses.readonly`
   - `https://www.googleapis.com/auth/classroom.coursework.me.readonly`
   - `https://www.googleapis.com/auth/classroom.student-submissions.me.readonly`
   Do not add `.students` scopes or any scope that can submit or grade work.
5. Add test users under **Google Auth Platform → Audience**. Add each student's Google account. While the app stays in Testing, only those accounts can sign in.
6. Create the client. **Google Auth Platform → Clients → Create client** (older path: **APIs & Services → Credentials → Create credentials → OAuth client ID**).
   - Application type: **Desktop app**
   - Name: `School Pulse`
7. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`). School Pulse uses PKCE and does not need the client secret. If a secret is required by the token endpoint, set `SCHOOL_PULSE_GOOGLE_CLIENT_SECRET` in the environment. It is not written into the repo or the token file.
8. Do not register a web redirect URI. Desktop clients may use `http://127.0.0.1` with a port chosen at sign-in.
9. Export the client id and sign each student in from a browser session that is that student (sign out, or use a private window):

```bash
export SCHOOL_PULSE_GOOGLE_CLIENT_ID="YOUR_CLIENT_ID.apps.googleusercontent.com"
school-pulse auth classroom --student stu-a
school-pulse auth classroom --student stu-b
school-pulse auth status
```

Google expires refresh tokens for apps that remain in Testing after 7 days. The badge then says `re-auth needed`. Run auth again for that student. The other accounts stay in the file.

### Microsoft Graph app registration

1. In the Microsoft Entra admin center, open **App registrations → New registration**.
2. Name: `School Pulse`. Supported accounts: personal Microsoft accounts and any organizational directory (the `common` tenant).
3. Redirect URI: **Public client/native (mobile & desktop)**, `http://127.0.0.1`.
4. After it is created, open **Authentication** and set **Allow public client flows** to Yes.
5. **API permissions → Microsoft Graph → Delegated**: `Notes.Read`, `User.Read`, `offline_access`, `openid`, `email`. Do not add `Notes.ReadWrite`. The student consents at sign-in. Personal accounts do not need an admin consent click for these.
6. Copy the Application (client) ID into `SCHOOL_PULSE_GRAPH_CLIENT_ID`.

```bash
export SCHOOL_PULSE_GRAPH_CLIENT_ID="your-application-id"
school-pulse auth onenote --student stu-a
school-pulse auth onenote --student stu-b
```

## `POST /api/ingest`

Any local script can push a snapshot. The server listens on `127.0.0.1` only.

```http
POST /api/ingest?source=powerschool&filename=scores.html
Content-Type: text/html

<!DOCTYPE html>…
```

`source` is `powerschool`, `onenote`, `google-classroom`, or `generic`. Omit it and the body is sniffed. `filename` helps pick HTML, JSON, or CSV.

JSON envelope, when the body itself is not the snapshot:

```http
POST /api/ingest
Content-Type: application/json

{ "source": "generic", "filename": "bot.json", "body": "{ …snapshot… }" }
```

Success `200`:

```json
{ "ok": true, "unchanged": false, "assignmentsInserted": 1, "assignmentsUpdated": 0, "gradesInserted": 0, "changes": [], "alerts": [] }
```

`unchanged: true` means the same rows were already stored. Parse errors are `400` `{ "ok": false, "error": "…" }`. Bodies over 5 MB are `413`. A successful change is also pushed to `GET /api/events` as a server-sent `pulse`, so the open dashboard updates without a reload.

The same contract is what `school-pulse ingest <file>` runs in-process. Dropping a file in `data/inbox/<source>/` does too.
