interface AttentionItem {
  id: string;
  studentKey: string;
  studentName: string;
  courseName: string;
  title: string;
  status: string;
  dueLabel: string;
  pointsLabel: string | null;
  sourceLabel: string;
}

interface GradeRow {
  id: string;
  studentKey: string;
  studentName: string;
  courseName: string;
  teacher: string | null;
  period: string | null;
  percentLabel: string;
  letter: string | null;
  delta: number | null;
  spark: number[];
  sourceLabel: string;
}

interface StudentCard {
  key: string;
  name: string;
  school: string;
  gradeLevel: string | null;
  missingCount: number;
  lateCount: number;
  dueTonightCount: number;
  grades: GradeRow[];
}

interface ChangeItem {
  id: string;
  summary: string;
  studentName: string | null;
  courseName: string | null;
  sourceLabel: string;
  when: string;
  assignmentId: string | null;
  courseId: string | null;
}

interface Dashboard {
  timezone: string;
  clock: { weekday: string; date: string; time: string };
  schools: string;
  tonight: {
    kicker: string;
    headline: string[];
    detail: string;
    clear: boolean;
    doneTonight: number;
    items: AttentionItem[];
  };
  missing: AttentionItem[];
  week: {
    overdue: AttentionItem[];
    days: Array<{ label: string; dateLabel: string; isToday: boolean; items: AttentionItem[] }>;
  };
  grades: GradeRow[];
  students: StudentCard[];
  changes: ChangeItem[];
  sources: Array<{ source: string; state: "fresh" | "aging" | "stale" | "reauth"; text: string }>;
  counts: { students: number; assignments: number; missing: number };
}

interface Pulse {
  changeIds: string[];
  assignmentIds: string[];
  courseIds: string[];
  summaries: string[];
}

interface Highlights {
  changes: Set<string>;
  assignments: Set<string>;
  courses: Set<string>;
  tonight: boolean;
}

type Route = { name: "home" | "week" | "missing" | "grades" | "changes" | "student"; student?: string };

const app = document.querySelector<HTMLElement>("#app");
const toast = document.querySelector<HTMLElement>("#toast");
const live = document.querySelector<HTMLElement>("#live");
let data: Dashboard | null = null;
let connected = false;
let toastTimer = 0;
let highlights: Highlights = { changes: new Set(), assignments: new Set(), courses: new Set(), tonight: false };

if (app) {
  void refresh();
  connect();
  window.setInterval(() => void refresh(), 60_000);
  window.setInterval(tickClock, 30_000);
}

window.addEventListener("hashchange", () => render());

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("[data-action='theme']")) {
    event.preventDefault();
    toggleTheme();
  }
  if (target.closest("[data-action='help']")) {
    event.preventDefault();
    document.querySelector<HTMLDialogElement>("#help")?.showModal();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (target instanceof HTMLElement && target.matches("input, textarea")) return;
  const dialog = document.querySelector("dialog");
  if (dialog?.open) return;
  const key = event.key.toLowerCase();
  if (key === "?" || event.key === "/") {
    if (key === "?") {
      event.preventDefault();
      document.querySelector<HTMLDialogElement>("#help")?.showModal();
    }
    return;
  }
  if (key === "t") {
    event.preventDefault();
    toggleTheme();
    return;
  }
  if (key === "h") return go("#/");
  if (key === "w") return go("#/week");
  if (key === "m") return go("#/missing");
  if (key === "g") return go("#/grades");
  if (key === "c") return go("#/changes");
  if (key === "j" || key === "arrowdown") {
    event.preventDefault();
    move(1);
  } else if (key === "k" || key === "arrowup") {
    event.preventDefault();
    move(-1);
  } else if (key === "escape" && location.hash.startsWith("#/student/")) {
    go("#/");
  } else if (key === "enter") {
    openFocused();
  }
});

function go(hash: string): void {
  location.hash = hash;
}

function route(): Route {
  const hash = location.hash || "#/";
  const student = hash.match(/^#\/student\/([^/?#]+)/);
  if (student?.[1]) return { name: "student", student: decodeURIComponent(student[1]) };
  if (hash.startsWith("#/week")) return { name: "week" };
  if (hash.startsWith("#/missing")) return { name: "missing" };
  if (hash.startsWith("#/grades")) return { name: "grades" };
  if (hash.startsWith("#/changes")) return { name: "changes" };
  return { name: "home" };
}

async function refresh(pulse?: Pulse): Promise<void> {
  const response = await fetch("/api/dashboard", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not load the household");
  data = (await response.json()) as Dashboard;
  const focus = document.activeElement?.getAttribute("data-kbd");
  if (pulse) {
    highlights = {
      changes: new Set(pulse.changeIds),
      assignments: new Set(pulse.assignmentIds.filter(Boolean)),
      courses: new Set(pulse.courseIds.filter(Boolean)),
      tonight: true,
    };
  } else {
    highlights = { changes: new Set(), assignments: new Set(), courses: new Set(), tonight: false };
  }
  render();
  if (focus) document.querySelector<HTMLElement>(`[data-kbd="${CSS.escape(focus)}"]`)?.focus();
  if (pulse && pulse.summaries.length > 0) showToast(pulse.summaries.slice(0, 2).join(" · "));
}

function render(): void {
  if (!app || !data) return;
  const current = route();
  document.title = current.name === "student"
    ? `${studentName(current.student)} · School Pulse`
    : `${current.name === "home" ? "Tonight" : labelFor(current.name)} · School Pulse`;
  const body = data.counts.students === 0 ? renderEmpty() : renderView(current, data);
  app.innerHTML = `<div class="wrap">${renderHeader(data, current)}${current.name === "home" ? "" : renderThin(data)}${body}</div>${renderTabbar(data, current)}`;
}

function renderView(current: Route, board: Dashboard): string {
  if (current.name === "week") return renderWeek(board);
  if (current.name === "missing") return renderMissing(board);
  if (current.name === "grades") return renderGrades(board);
  if (current.name === "changes") return renderChanges(board.changes, "What changed");
  if (current.name === "student") return renderStudent(board, current.student ?? "");
  return renderHome(board);
}

function renderHeader(board: Dashboard, current: Route): string {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  return `<header class="top">
    <div class="brand">
      <svg class="mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><circle cx="16" cy="16" r="5.5" fill="currentColor"></circle><circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" stroke-width="2" opacity="0.45"></circle></svg>
      <div>
        <h1 class="word">School Pulse</h1>
        <div class="clock"><span>${esc(board.clock.weekday)} ${esc(board.clock.date)}</span> · <span data-clock data-timezone="${esc(board.timezone)}">${esc(board.clock.time)}</span></div>
        ${board.schools ? `<div class="schools">${esc(board.schools)}</div>` : ""}
      </div>
    </div>
    <div class="sources">
      <span class="live-pill ${highlights.tonight ? "ping" : ""}" data-state="${connected ? "on" : "off"}"><span class="dot"></span>${connected ? "Live" : "Connecting"}</span>
      ${board.sources.map((source) => `<span class="badge ${esc(source.state)}">${esc(source.text)}</span>`).join("")}
    </div>
    <div class="tools">
      <button type="button" class="theme" data-action="theme" aria-label="Switch to ${theme} mode">${theme === "dark" ? "Dark" : "Light"}</button>
      <button type="button" class="help" data-action="help" aria-label="Keyboard help">?</button>
    </div>
    <nav class="views" aria-label="Views">
      ${navLinks(board, current, "views")}
    </nav>
  </header>`;
}

function navLinks(board: Dashboard, current: Route, kind: string): string {
  const items: Array<[Route["name"], string, string]> = [
    ["home", "#/", "Tonight"],
    ["week", "#/week", "Week"],
    ["missing", "#/missing", "Missing"],
    ["grades", "#/grades", "Grades"],
    ["changes", "#/changes", "Changes"],
  ];
  return items
    .map(([name, href, label]) => {
      const currentAttr = current.name === name ? ' aria-current="page"' : "";
      const badge = name === "missing" && board.counts.missing > 0 ? `<span class="count">${board.counts.missing}</span>` : "";
      return `<a href="${href}"${currentAttr} data-nav="${kind}">${label}${badge}</a>`;
    })
    .join("");
}

function renderTabbar(board: Dashboard, current: Route): string {
  return `<nav class="tabbar" aria-label="Sections">${navLinks(board, current, "tab")}</nav>`;
}

function renderThin(board: Dashboard): string {
  return `<a class="thin" href="#/"><span class="kicker ${board.tonight.clear ? "calm" : "alert"}">${esc(board.tonight.kicker)}</span><strong>${esc(board.tonight.headline.join(" · "))}</strong></a>`;
}

function renderHome(board: Dashboard): string {
  const cards = board.tonight.items.slice(0, 4);
  const rest = board.tonight.items.slice(4);
  const tonightClass = highlights.tonight ? " tonight is-new" : " tonight";
  return `<section class="${tonightClass.trim()}" id="tonight">
    <p class="kicker ${board.tonight.clear ? "calm" : "alert"}">${esc(board.tonight.kicker)}</p>
    <h2 class="headline">${headlineHtml(board.tonight.headline)}</h2>
    <p class="detail">${esc(board.tonight.detail)}</p>
    ${board.tonight.doneTonight ? `<p class="done">${board.tonight.doneTonight} already turned in</p>` : ""}
    ${cards.length ? `<div class="tonight-cards">${cards.map((item) => attentionCard(item)).join("")}</div>` : ""}
    ${rest.length ? `<p class="also">Also due tonight: ${rest.map((item) => `<a href="#/student/${esc(item.studentKey)}">${esc(item.title)}</a>`).join(" · ")}</p>` : ""}
  </section>
  <div class="board">
    <section class="panel" aria-labelledby="missing-title">
      <h3 id="missing-title">Missing and late</h3>
      ${board.missing.length ? board.missing.map((item) => row(item)).join("") : `<p class="calm-line">Nothing missing or late.</p>`}
    </section>
    <section class="panel" aria-labelledby="students-title">
      <h3 id="students-title">Household</h3>
      ${board.students.map((student) => studentBlock(student)).join("")}
    </section>
    <section class="panel panel-changes" aria-labelledby="changes-title">
      <h3 id="changes-title">Just changed</h3>
      ${board.changes.length ? board.changes.slice(0, 6).map((change) => changeRow(change)).join("") : `<p class="quiet">No changes since the last import.</p>`}
    </section>
  </div>
  <p class="footnote">${esc(board.schools || "Local only")} · ${board.counts.assignments} assignments · read-only, on this computer · ? for keys</p>`;
}

function renderWeek(board: Dashboard): string {
  const overdue = board.week.overdue.length
    ? `<section class="day"><h3>Overdue</h3>${board.week.overdue.map((item) => row(item)).join("")}</section>`
    : "";
  const days = board.week.days
    .map((day) => `<section class="day ${day.isToday ? "is-today" : ""}"><h3><span>${esc(day.label)}</span><span>${esc(day.dateLabel)}</span></h3>${day.items.length ? day.items.map((item) => row(item)).join("") : `<p class="quiet">Clear</p>`}</section>`)
    .join("");
  return `<div class="page-head"><h2>This week</h2></div><div class="stack">${overdue}${days}</div>`;
}

function renderMissing(board: Dashboard): string {
  return `<div class="page-head"><h2>Missing and late</h2><p class="detail">${board.missing.length ? `${board.missing.length} still open` : "All caught up"}</p></div>
    <section class="panel">${board.missing.length ? board.missing.map((item) => row(item)).join("") : `<p class="calm-line">Nothing missing or late.</p>`}</section>`;
}

function renderGrades(board: Dashboard): string {
  const groups = new Map<string, GradeRow[]>();
  for (const grade of board.grades) {
    groups.set(grade.studentName, [...(groups.get(grade.studentName) ?? []), grade]);
  }
  const blocks = [...groups.entries()]
    .map(([name, grades]) => `<section class="grade-block"><h3>${esc(name)}</h3>${grades.map((grade) => gradeHero(grade)).join("")}</section>`)
    .join("");
  return `<div class="page-head"><h2>Grades</h2></div><div class="stack">${blocks || `<section class="empty"><h2>No grades yet</h2></section>`}</div>`;
}

function renderChanges(changes: ChangeItem[], title: string): string {
  return `<div class="page-head"><h2>${esc(title)}</h2></div><section class="panel">${changes.length ? changes.map((change) => changeRow(change)).join("") : `<p class="quiet">No changes since the last import.</p>`}</section>`;
}

function renderStudent(board: Dashboard, key: string): string {
  const student = board.students.find((item) => item.key === key);
  if (!student) return `<section class="empty"><h2>No student here</h2><p><a href="#/">Back to tonight</a></p></section>`;
  const tonight = board.tonight.items.filter((item) => item.studentKey === key);
  const missing = board.missing.filter((item) => item.studentKey === key);
  const changes = board.changes.filter((item) => item.studentName === student.name);
  const who = [student.gradeLevel ? ordinal(student.gradeLevel) : "", student.school].filter(Boolean).join(" · ");
  return `<div class="page-head">
      <div>
        <a class="back" href="#/">Household</a>
        <h2>${esc(student.name)}</h2>
        <p class="detail">${esc(who)}</p>
      </div>
      <span class="signal ${student.missingCount ? "" : "clear"}">${esc(signal(student))}</span>
    </div>
    <div class="stack">
      <section class="panel"><h3>Tonight</h3>${tonight.length ? tonight.map((item) => row(item)).join("") : `<p class="calm-line">Nothing tonight.</p>`}</section>
      <section class="panel"><h3>Missing and late</h3>${missing.length ? missing.map((item) => row(item)).join("") : `<p class="calm-line">Nothing missing or late.</p>`}</section>
      <section class="grade-block"><h3>Grades</h3>${student.grades.map((grade) => gradeHero(grade)).join("") || `<p class="quiet">No grades yet.</p>`}</section>
      <section class="panel"><h3>Changes</h3>${changes.length ? changes.map((change) => changeRow(change)).join("") : `<p class="quiet">No changes yet.</p>`}</section>
    </div>`;
}

function renderEmpty(): string {
  return `<section class="empty" id="tonight"><p class="kicker calm">Tonight</p><h2>Nothing imported yet</h2><p>Run <strong>school-pulse demo</strong>, or drop a JSON, HTML, or CSV file into the inbox.</p></section>`;
}

function attentionCard(item: AttentionItem): string {
  const marked = highlights.assignments.has(item.id) ? " is-new" : "";
  return `<a class="attention${marked}" data-status="${esc(item.status)}" data-kbd="${esc(item.id)}" data-kbd-item href="#/student/${esc(item.studentKey)}">
    <span class="pill ${esc(item.status)}">${esc(statusWord(item))}</span>
    <span class="who">${esc(item.studentName)} · ${esc(item.courseName)}</span>
    <span class="title">${esc(item.title)}</span>
    <span class="course">${esc(item.dueLabel)}${item.pointsLabel ? ` · ${esc(item.pointsLabel)}` : ""} · ${esc(item.sourceLabel)}</span>
  </a>`;
}

function row(item: AttentionItem): string {
  const marked = highlights.assignments.has(item.id) ? " is-new" : "";
  return `<a class="row${marked}" data-kbd="${esc(item.id)}" data-kbd-item href="#/student/${esc(item.studentKey)}">
    <span><span class="title">${esc(item.title)}</span><span class="meta">${esc(item.studentName)} · ${esc(item.courseName)} · ${esc(item.sourceLabel)}</span></span>
    <span class="flag ${esc(item.status)}">${esc(item.dueLabel)}</span>
  </a>`;
}

function studentBlock(student: StudentCard): string {
  return `<article class="student-block">
    <a class="student-jump" data-kbd="student-${esc(student.key)}" data-kbd-item href="#/student/${esc(student.key)}">
      <span><span class="sname">${esc(student.name)}</span><span class="smeta">${esc([student.gradeLevel ? ordinal(student.gradeLevel) : "", student.school].filter(Boolean).join(" · "))}</span></span>
      <span class="signal ${student.missingCount || student.lateCount ? "" : "clear"}">${esc(signal(student))}</span>
    </a>
    ${student.grades.map((grade) => miniGrade(grade)).join("")}
  </article>`;
}

function miniGrade(grade: GradeRow): string {
  const trend = trendClass(grade.delta);
  const marked = highlights.courses.has(grade.id) ? " is-new" : "";
  return `<div class="mini ${trend}${marked}" data-kbd="grade-${esc(grade.id)}" data-kbd-item tabindex="0" data-href="#/student/${esc(grade.studentKey)}" aria-label="${esc(`${grade.courseName} ${grade.percentLabel} ${grade.letter ?? ""} ${deltaText(grade.delta)}`)}">
    <span class="cname">${esc(grade.courseName)}</span>
    <span class="pct">${esc(grade.percentLabel)}</span>
    <span class="letter">${esc(grade.letter ?? "")}</span>
    ${sparkline(grade.spark, 72, 26)}
    <span class="delta ${trend}">${esc(deltaText(grade.delta))}</span>
  </div>`;
}

function gradeHero(grade: GradeRow): string {
  const trend = trendClass(grade.delta);
  const marked = highlights.courses.has(grade.id) ? " is-new" : "";
  const teacher = [grade.teacher, grade.period, grade.sourceLabel].filter(Boolean).join(" · ");
  return `<div class="grade-hero ${trend}${marked}" data-kbd="hero-${esc(grade.id)}" data-kbd-item tabindex="0" data-href="#/student/${esc(grade.studentKey)}">
    <span><span class="title">${esc(grade.courseName)}</span><span class="meta">${esc(teacher)}</span></span>
    <span class="pct">${esc(grade.percentLabel)}</span>
    <span class="letter">${esc(grade.letter ?? "")}</span>
    <span class="delta ${trend}">${esc(deltaText(grade.delta))}</span>
    ${sparkline(grade.spark, 140, 36)}
  </div>`;
}

function changeRow(change: ChangeItem): string {
  const marked = highlights.changes.has(change.id) ? " is-new" : "";
  const meta = [change.studentName, change.courseName, change.when, change.sourceLabel].filter(Boolean).join(" · ");
  return `<article class="change${marked}" data-kbd="change-${esc(change.id)}" data-kbd-item tabindex="0" data-href="${change.studentName ? `#/student/${esc(slug(change.studentName))}` : "#/changes"}">
    <p class="summary">${esc(change.summary)}</p>
    <p class="meta">${esc(meta)}</p>
  </article>`;
}

function headlineHtml(parts: string[]): string {
  return parts.map((part, index) => `${index ? '<span class="sep" aria-hidden="true">·</span>' : ""}<span>${esc(part)}</span>`).join("");
}

function signal(student: StudentCard): string {
  if (student.missingCount) return `${student.missingCount} missing`;
  if (student.lateCount) return `${student.lateCount} late`;
  if (student.dueTonightCount) return `${student.dueTonightCount} due tonight`;
  return "Clear tonight";
}

function statusWord(item: AttentionItem): string {
  if (item.status === "assigned") return "Due tonight";
  if (item.status === "turned_in") return "Turned in";
  if (item.status === "missing") return "Missing";
  if (item.status === "late") return "Late";
  if (item.status === "graded") return "Graded";
  if (item.status === "excused") return "Excused";
  return item.status;
}

function deltaText(delta: number | null): string {
  if (delta == null || delta === 0) return "";
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta)}`;
}

function trendClass(delta: number | null): string {
  if (delta == null || delta === 0) return "trend-flat";
  return delta < 0 ? "trend-down" : "trend-up";
}

function sparkline(values: number[], width: number, height: number): string {
  if (values.length === 0) return `<span class="spark"></span>`;
  const series = values.length === 1 ? [values[0]!, values[0]!] : values;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const coords = series.map((value, index) => {
    const x = (index / (series.length - 1)) * (width - 6) + 3;
    const y = height - 4 - ((value - min) / span) * (height - 8);
    return [x, y] as const;
  });
  const points = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = coords[coords.length - 1]!;
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></polyline><circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.3" fill="currentColor"></circle></svg>`;
}

function showToast(text: string): void {
  if (!toast || !live) return;
  toast.hidden = false;
  toast.textContent = text;
  live.textContent = text;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 6500);
}

function connect(): void {
  const events = new EventSource("/api/events");
  events.addEventListener("pulse", (event) => {
    const pulse = JSON.parse((event as MessageEvent).data) as Pulse;
    void refresh(pulse);
  });
  events.onopen = () => {
    connected = true;
    document.querySelector(".live-pill")?.setAttribute("data-state", "on");
  };
  events.onerror = () => {
    connected = false;
    document.querySelector(".live-pill")?.setAttribute("data-state", "off");
  };
}

function toggleTheme(): void {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("school-pulse-theme", next);
  const button = document.querySelector("[data-action='theme']");
  if (button) {
    button.textContent = next === "dark" ? "Light" : "Dark";
    button.setAttribute("aria-label", `Switch to ${next === "dark" ? "light" : "dark"} mode`);
  }
}

function tickClock(): void {
  const node = document.querySelector("[data-clock]");
  if (!node) return;
  const timeZone = node.getAttribute("data-timezone") || "America/New_York";
  node.textContent = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
}

function move(delta: number): void {
  const items = Array.from(document.querySelectorAll<HTMLElement>("[data-kbd-item]"));
  if (items.length === 0) return;
  const index = items.findIndex((item) => item === document.activeElement);
  const start = index === -1 ? (delta > 0 ? -1 : 0) : index;
  const next = items[Math.max(0, Math.min(items.length - 1, start + delta))];
  next?.focus();
}

function openFocused(): void {
  const current = document.activeElement;
  if (!(current instanceof HTMLElement)) return;
  if (current instanceof HTMLAnchorElement) return;
  const href = current.getAttribute("data-href");
  if (href) location.hash = href;
}

function studentName(key: string | undefined): string {
  return data?.students.find((student) => student.key === key)?.name ?? "Student";
}

function labelFor(name: Route["name"]): string {
  if (name === "week") return "This week";
  if (name === "missing") return "Missing";
  if (name === "grades") return "Grades";
  if (name === "changes") return "Changes";
  return "Tonight";
}

function ordinal(value: string): string {
  const number = Number(value);
  if (!Number.isInteger(number)) return value;
  const mod = number % 100;
  if (mod >= 11 && mod <= 13) return `${number}th`;
  const last = number % 10;
  if (last === 1) return `${number}st`;
  if (last === 2) return `${number}nd`;
  if (last === 3) return `${number}rd`;
  return `${number}th`;
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "student";
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}
