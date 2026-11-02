const views = [
  { id: "household", hash: "#/", label: "Overview", key: "1" },
  { id: "due", hash: "#/due", label: "Due this week", key: "2" },
  { id: "missing", hash: "#/missing", label: "Missing / late", key: "3" },
  { id: "grades", hash: "#/grades", label: "Grades", key: "4" },
  { id: "feed", hash: "#/feed", label: "Changes", key: "5" },
];

const state = { data: null, freshIds: new Set() };

const nav = document.querySelector("#nav");
const studentLinks = document.querySelector("#student-links");
const main = document.querySelector("#main");
const title = document.querySelector("#title");
const eyebrow = document.querySelector("#eyebrow");
const freshness = document.querySelector("#freshness");
const toast = document.querySelector("#toast");
const help = document.querySelector("#help");
const themeButton = document.querySelector("#theme");
const mark = document.querySelector("#mark");

for (const view of views) {
  const link = document.createElement("a");
  link.href = view.hash;
  link.textContent = view.label;
  link.dataset.view = view.id;
  nav.append(link);
}

themeButton.addEventListener("click", toggleTheme);
themeButton.textContent = document.documentElement.dataset.theme === "dark" ? "Light" : "Dark";
window.addEventListener("hashchange", () => render());
window.addEventListener("keydown", onKey);

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("school-pulse-theme", next);
  themeButton.textContent = next === "dark" ? "Light" : "Dark";
}

function route() {
  const hash = location.hash || "#/";
  if (hash.startsWith("#/student/")) {
    return { view: "student", studentId: decodeURIComponent(hash.slice("#/student/".length)) };
  }
  const match = views.find((view) => view.hash === hash);
  return { view: match ? match.id : "household", studentId: null };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function formatScore(value) {
  if (value === null || value === undefined) return "";
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function weekday(iso) {
  if (!iso) return "No date";
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(iso));
}

function spark(values) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const falling = values.length >= 2 && values[values.length - 1] < values[values.length - 2];
  svg.setAttribute("viewBox", "0 0 88 28");
  svg.setAttribute("class", falling ? "spark down" : "spark");
  svg.setAttribute("aria-hidden", "true");
  if (values.length === 0) return svg;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((value, index) => {
    const x = values.length === 1 ? 44 : 2 + (index / (values.length - 1)) * 84;
    const y = 2 + (1 - (value - min) / span) * 24;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute("points", points.join(" "));
  svg.append(line);
  return svg;
}

function courseLine(course) {
  const row = el("div", "course");
  const name = el("div");
  name.append(el("div", "name", course.name));
  const meta = [course.teacher, course.period ? `Period ${course.period}` : ""].filter(Boolean).join(" · ");
  if (meta) name.append(el("div", "meta", meta));
  const score = el("div", "score");
  score.append(el("b", "", course.percent === null ? course.letter || "—" : formatScore(course.percent)));
  if (course.letter && course.percent !== null) score.append(document.createTextNode(` ${course.letter}`));
  if (course.delta !== null && course.delta !== 0) {
    score.append(el("div", course.delta < 0 ? "delta down" : "delta up", `${course.delta > 0 ? "+" : ""}${formatScore(course.delta)}`));
  }
  row.append(name, spark(course.trend), score);
  return row;
}

function assignmentRow(item, fresh) {
  const row = el("article", fresh ? "row fresh" : "row");
  row.dataset.item = "true";
  row.tabIndex = -1;
  const title = el("div");
  title.append(el("strong", "", item.title));
  title.append(el("div", "muted", `${item.studentName} · ${item.courseName}`));
  row.append(title, el("div", "", weekday(item.dueAt)), el("div", `pill ${item.status}`, item.status.replaceAll("_", " ")));
  const points = item.possible === null ? "" : `${item.earned ?? "—"}/${item.possible}`;
  row.append(el("div", "muted", points));
  return row;
}

function render() {
  const data = state.data;
  const current = route();
  for (const link of nav.querySelectorAll("a")) {
    link.setAttribute("aria-current", link.dataset.view === current.view ? "page" : "false");
    if (link.getAttribute("aria-current") === "false") link.removeAttribute("aria-current");
  }
  clear(freshness);
  clear(main);
  if (!data) {
    main.append(el("p", "empty", "Loading the household…"));
    return;
  }
  for (const source of data.sources) {
    const chip = el("span", source.stale ? "chip stale" : "chip", `${source.label} ${source.ageLabel}`);
    if (source.stale) chip.append(document.createTextNode(" · stale"));
    freshness.append(chip);
  }
  clear(studentLinks);
  for (const student of data.students) {
    const link = document.createElement("a");
    link.href = `#/student/${encodeURIComponent(student.id)}`;
    link.textContent = student.displayName;
    if (current.studentId === student.id) link.setAttribute("aria-current", "page");
    studentLinks.append(link);
  }
  if (current.view === "due") renderList("Due this week", "Work due before next Monday.", data.assignments.filter((item) => item.dueThisWeek));
  else if (current.view === "missing") renderList("Missing and late", "Work that still needs a hand.", data.assignments.filter((item) => item.status === "missing" || item.status === "late"));
  else if (current.view === "grades") renderGrades(data);
  else if (current.view === "feed") renderFeed(data.changes, "Changes");
  else if (current.view === "student") renderStudent(data, current.studentId);
  else renderHousehold(data);
  const active = views.find((view) => view.id === current.view);
  if (current.view !== "student" && active) document.title = `${active.label} · School Pulse`;
}

function renderHousehold(data) {
  title.textContent = "Overview";
  eyebrow.textContent = data.students[0]?.schoolName || "Household";
  const cards = el("div", "cards");
  for (const student of data.students) cards.append(studentCard(student, data.courses.filter((course) => course.studentId === student.id)));
  main.append(cards);
  const recent = data.changes.slice(-5).reverse();
  const section = el("section", "section");
  section.append(el("h2", "", "Recent changes"));
  if (recent.length === 0) section.append(el("p", "empty", "No changes yet. New grades and assignments show up here."));
  for (const change of recent) section.append(changeRow(change));
  main.append(section);
}

function studentCard(student, courses) {
  const card = document.createElement("a");
  card.className = "card";
  card.href = `#/student/${encodeURIComponent(student.id)}`;
  card.dataset.item = "true";
  card.tabIndex = -1;
  const head = el("div", "card-head");
  head.append(el("h2", "", student.displayName));
  head.append(el("span", "school", student.schoolName || ""));
  const stats = el("div", "stats");
  for (const [label, value, warn] of [
    ["Due today", student.dueToday, false],
    ["This week", student.dueThisWeek, false],
    ["Missing", student.missing, student.missing > 0],
    ["Late", student.late, student.late > 0],
  ]) {
    const stat = el("div", warn ? "stat warn" : "stat");
    stat.append(el("b", "", value), el("span", "", label));
    stats.append(stat);
  }
  card.append(head, stats);
  for (const course of courses) card.append(courseLine(course));
  return card;
}

function renderStudent(data, studentId) {
  const student = data.students.find((item) => item.id === studentId);
  if (!student) {
    title.textContent = "Student";
    main.append(el("p", "empty", "That student is not in the household."));
    return;
  }
  title.textContent = student.displayName;
  eyebrow.textContent = student.schoolName || "Student";
  document.title = `${student.displayName} · School Pulse`;
  main.append(studentCard(student, data.courses.filter((course) => course.studentId === student.id)));
  const section = el("section", "section");
  section.append(el("h2", "", "Assignments"));
  const rows = data.assignments.filter((item) => item.studentId === student.id);
  if (rows.length === 0) section.append(el("p", "empty", "No assignments yet."));
  for (const item of rows) section.append(assignmentRow(item, false));
  main.append(section);
}

function renderList(heading, copy, rows) {
  title.textContent = heading;
  eyebrow.textContent = "Household";
  main.append(el("p", "muted", copy));
  if (rows.length === 0) main.append(el("p", "empty", "Nothing in this list."));
  for (const item of rows) main.append(assignmentRow(item, false));
}

function renderGrades(data) {
  title.textContent = "Grades";
  eyebrow.textContent = "Household";
  if (data.courses.length === 0) main.append(el("p", "empty", "No courses yet."));
  for (const course of data.courses) {
    const row = el("article", "grade");
    row.dataset.item = "true";
    row.tabIndex = -1;
    row.append(el("div", "", course.name), el("div", "muted", `${course.studentName}${course.teacher ? ` · ${course.teacher}` : ""}`));
    row.append(spark(course.trend));
    const score = el("div", "score");
    score.append(el("b", "", course.percent === null ? "—" : formatScore(course.percent)));
    if (course.letter) score.append(document.createTextNode(` ${course.letter}`));
    row.append(score);
    main.append(row);
  }
}

function renderFeed(changes, heading) {
  title.textContent = heading;
  eyebrow.textContent = "Household";
  if (changes.length === 0) main.append(el("p", "empty", "No changes yet. New grades and assignments show up here."));
  for (const change of [...changes].reverse()) main.append(changeRow(change));
}

function changeRow(change) {
  const row = el("article", state.freshIds.has(change.id) ? "change fresh" : "change");
  row.dataset.item = "true";
  row.tabIndex = -1;
  const when = document.createElement("time");
  when.dateTime = change.at;
  when.textContent = weekday(change.at);
  row.append(el("div", "", change.text), when);
  return row;
}

function items() {
  return [...main.querySelectorAll("[data-item]")];
}

function onKey(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === "?" || (event.shiftKey && event.key === "/")) {
    if (help.open) help.close();
    else help.showModal();
    event.preventDefault();
    return;
  }
  if (event.key === "t") {
    toggleTheme();
    return;
  }
  const view = views.find((item) => item.key === event.key);
  if (view) {
    location.hash = view.hash;
    return;
  }
  if (event.key !== "j" && event.key !== "k") return;
  const list = items();
  if (list.length === 0) return;
  const current = list.indexOf(document.activeElement);
  const next = event.key === "j" ? Math.min(list.length - 1, current + 1) : Math.max(0, current - 1);
  const target = list[next];
  if (target) target.focus();
  event.preventDefault();
}

async function load(messages) {
  const response = await fetch("/api/household");
  state.data = await response.json();
  const weekStart = startOfWeek(state.data.generatedAt);
  const weekEnd = new Date(Date.parse(weekStart) + 7 * 86400000).toISOString();
  const today = state.data.generatedAt.slice(0, 10);
  state.data.assignments = state.data.assignments.map((item) => ({
    ...item,
    dueThisWeek: Boolean(item.dueAt && item.dueAt >= weekStart && item.dueAt < weekEnd && item.status !== "graded" && item.status !== "excused"),
    dueToday: Boolean(item.dueAt && item.dueAt.slice(0, 10) === today),
  }));
  render();
  if (messages && messages.length) showToast(messages.join(" · "));
}

function startOfWeek(iso) {
  const date = new Date(iso);
  const monday = (date.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - monday)).toISOString();
}

let toastTimer = 0;
function showToast(text) {
  toast.textContent = text;
  toast.classList.add("show");
  mark.classList.add("pulse");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
    mark.classList.remove("pulse");
  }, 4500);
}

function connect() {
  const source = new EventSource("/api/events");
  source.addEventListener("ingest", (event) => {
    const payload = JSON.parse(event.data);
    state.freshIds = new Set(payload.changeIds || []);
    void load(payload.messages || []);
  });
  source.onerror = () => {
    source.close();
    setTimeout(connect, 2000);
  };
}

void load().then(connect);
