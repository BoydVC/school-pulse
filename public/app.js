const views = [
  ['overview', 'Overview', '1'],
  ['due', 'Due', '2'],
  ['missing', 'Missing', '3'],
  ['grades', 'Grades', '4'],
  ['changes', 'Changes', '5'],
];

const state = { data: null, view: 'overview', student: null };

const main = document.querySelector('#main');
const tabs = document.querySelector('#tabs');
const fresh = document.querySelector('#fresh');
const toast = document.querySelector('#toast');
const live = document.querySelector('#live');
const themeButton = document.querySelector('#theme');
const help = document.querySelector('#help');

function gradeClass(percent) {
  if (percent === null || percent === undefined) return '';
  if (percent >= 90) return 'good';
  if (percent >= 80) return 'mid';
  return 'low';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function spark(values) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('width', '84');
  svg.setAttribute('height', '28');
  svg.setAttribute('viewBox', '0 0 84 28');
  svg.setAttribute('aria-hidden', 'true');
  if (!values.length) return svg;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const coords = values.map((value, index) => {
    const x = values.length === 1 ? 42 : (index / (values.length - 1)) * 80 + 2;
    const y = max === min ? 14 : (1 - (value - min) / (max - min)) * 22 + 3;
    return [x, y];
  });
  if (coords.length === 1) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', String(coords[0][0]));
    circle.setAttribute('cy', String(coords[0][1]));
    circle.setAttribute('r', '3');
    circle.setAttribute('fill', 'currentColor');
    svg.append(circle);
    return svg;
  }
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', '2');
  line.setAttribute('points', coords.map((pair) => pair.join(',')).join(' '));
  svg.append(line);
  return svg;
}

function fmtPoints(item) {
  if (item.pointsEarned === null && item.pointsPossible === null) return '';
  if (item.pointsEarned === null) return `—/${item.pointsPossible}`;
  return `${item.pointsEarned}/${item.pointsPossible}`;
}

function fmtGrade(course) {
  if (course.percent === null && !course.letter) return '—';
  if (course.percent === null) return course.letter;
  const num = Number.isInteger(course.percent) ? String(course.percent) : String(course.percent);
  return course.letter ? `${course.letter} ${num}` : num;
}

function visibleAssignments() {
  const all = state.data?.assignments ?? [];
  return state.student ? all.filter((item) => item.studentId === state.student) : all;
}

function students() {
  const all = state.data?.students ?? [];
  return state.student ? all.filter((student) => student.id === state.student) : all;
}

function renderFresh() {
  fresh.replaceChildren();
  for (const source of state.data?.freshness ?? []) {
    const chip = el('span', source.fetchedAt ? (source.stale ? 'chip stale' : 'chip') : 'chip off', source.label);
    fresh.append(chip);
  }
  const anyStale = (state.data?.freshness ?? []).some((source) => source.stale);
  live.classList.toggle('stale-dot', anyStale);
}

function renderTabs() {
  tabs.replaceChildren();
  for (const [id, label] of views) {
    const button = el('button', 'tab', label);
    button.type = 'button';
    button.setAttribute('aria-selected', state.view === id && !state.student ? 'true' : 'false');
    button.addEventListener('click', () => {
      state.view = id;
      state.student = null;
      location.hash = `#/${id}`;
      render();
    });
    tabs.append(button);
  }
  for (const student of state.data?.students ?? []) {
    const button = el('button', 'tab', student.name);
    button.type = 'button';
    button.setAttribute('aria-selected', state.student === student.id ? 'true' : 'false');
    button.addEventListener('click', () => {
      state.student = student.id;
      state.view = 'student';
      location.hash = `#/student/${encodeURIComponent(student.id)}`;
      render();
    });
    tabs.append(button);
  }
}

function courseLine(course) {
  const row = el('div', 'course-row');
  const left = el('div');
  left.append(el('div', 'name', course.name));
  const bits = [course.source, course.teacher, course.period, course.term].filter(Boolean).join(' · ');
  left.append(el('div', 'meta', bits));
  row.append(left);
  const right = el('div', `grade ${gradeClass(course.percent)}`);
  right.append(el('div', '', fmtGrade(course)));
  right.append(spark(course.trend));
  row.append(right);
  return row;
}

function assignmentLine(item) {
  const row = el('div', 'item');
  const left = el('div');
  const title = el('div', 'title', item.title);
  left.append(title);
  const badge = el('span', `badge ${item.status}`, item.dropped ? 'dropped' : item.status.replace('_', ' '));
  const meta = el('div', 'meta');
  meta.append(badge);
  meta.append(document.createTextNode(`${item.studentName} · ${item.courseName}${item.due ? ` · due ${item.due}` : ' · no due date'}${item.category ? ` · ${item.category}` : ''}`));
  left.append(meta);
  row.append(left);
  row.append(el('div', 'meta', fmtPoints(item)));
  return row;
}

function renderOverview() {
  const grid = el('div', 'grid students');
  for (const student of students()) {
    const card = el('article', 'card');
    card.append(el('h2', '', student.name));
    card.append(el('p', 'school', student.school || 'School not on this feed'));
    const stats = el('div', 'stats');
    for (const [value, label] of [
      [student.dueToday, 'Due today'],
      [student.dueThisWeek, 'This week'],
      [student.missing, 'Missing'],
      [student.late, 'Late'],
    ]) {
      const stat = el('div', 'stat');
      stat.append(el('b', '', String(value)));
      stat.append(el('span', '', label));
      stats.append(stat);
    }
    card.append(stats);
    for (const course of student.courses) card.append(courseLine(course));
    grid.append(card);
  }
  const changes = el('section', 'card');
  changes.append(el('h2', '', 'Recent changes'));
  const list = (state.data?.changes ?? []).slice(0, 6);
  if (!list.length) changes.append(el('p', 'empty', 'No changes yet.'));
  for (const change of list) {
    const row = el('div', 'change');
    row.append(el('div', '', change.summary));
    row.append(el('div', 'meta', change.source));
    changes.append(row);
  }
  main.replaceChildren(grid, changes);
}

function renderDue() {
  const items = visibleAssignments().filter((item) => !item.dropped && item.status !== 'excused' && item.due);
  const today = (state.data?.now ?? '').slice(0, 10);
  const week = items.filter((item) => {
    if (!item.due || !today) return false;
    const start = monday(today);
    const end = shift(start, 6);
    return item.due >= start && item.due <= end;
  }).sort((a, b) => a.due.localeCompare(b.due) || a.title.localeCompare(b.title));
  const wrap = el('section', 'card');
  wrap.append(el('h2', '', 'Due this week'));
  if (!week.length) wrap.append(el('p', 'empty', 'Nothing due this week.'));
  let last = '';
  for (const item of week) {
    if (item.due !== last) {
      wrap.append(el('h3', 'day-label', item.due === today ? `Today · ${item.due}` : item.due));
      last = item.due;
    }
    wrap.append(assignmentLine(item));
  }
  main.replaceChildren(wrap);
}

function renderMissing() {
  const items = visibleAssignments().filter((item) => !item.dropped && (item.status === 'missing' || item.status === 'late'));
  const excused = visibleAssignments().filter((item) => item.status === 'excused');
  const wrap = el('section', 'card');
  wrap.append(el('h2', '', 'Missing and late'));
  if (!items.length) wrap.append(el('p', 'empty', 'No missing or late work.'));
  for (const item of items) wrap.append(assignmentLine(item));
  if (excused.length) {
    wrap.append(el('h3', 'day-label', 'Excused'));
    for (const item of excused) wrap.append(assignmentLine(item));
  }
  main.replaceChildren(wrap);
}

function renderGrades() {
  const grid = el('div', 'grid');
  for (const student of students()) {
    for (const course of student.courses) {
      const card = el('article', 'card');
      card.append(el('h2', '', course.name));
      card.append(el('p', 'school', `${student.name} · ${course.source}`));
      const grade = el('div', `grade ${gradeClass(course.percent)}`, fmtGrade(course));
      card.append(grade);
      card.append(spark(course.trend));
      if (course.categories?.length) {
        const cats = el('p', 'meta', course.categories.map((category) => `${category.name} ${category.weight}%`).join(' · '));
        card.append(cats);
      }
      if (course.terms?.length) {
        const row = el('div', 'terms');
        for (const term of course.terms) {
          const chip = el('span', term.term === course.term ? 'term current' : 'term', `${term.term ?? ''} ${term.letter ?? ''} ${term.percent ?? ''}`.trim());
          row.append(chip);
        }
        card.append(row);
      }
      grid.append(card);
    }
  }
  main.replaceChildren(grid);
}

function renderChanges() {
  const wrap = el('section', 'card');
  wrap.append(el('h2', '', 'Change feed'));
  const list = state.data?.changes ?? [];
  if (!list.length) wrap.append(el('p', 'empty', 'The feed is quiet.'));
  for (const change of list) {
    if (state.student && change.studentId !== state.student) continue;
    const row = el('div', 'change');
    const left = el('div');
    left.append(el('div', '', change.summary));
    left.append(el('div', 'meta', [change.studentName, change.source].filter(Boolean).join(' · ')));
    row.append(left);
    wrap.append(row);
  }
  const note = el('p', 'meta', state.data?.alertsEnabled ? 'Alert rules are on.' : 'Alerts are off.');
  wrap.append(note);
  main.replaceChildren(wrap);
}

function renderStudent() {
  renderOverview();
  const list = el('section', 'card');
  list.append(el('h2', '', 'Assignments'));
  const items = visibleAssignments().filter((item) => !item.dropped);
  if (!items.length) list.append(el('p', 'empty', 'No assignments yet.'));
  for (const item of items) list.append(assignmentLine(item));
  main.append(list);
}

function render() {
  if (!state.data) {
    main.replaceChildren(el('p', 'empty', 'Loading the household…'));
    return;
  }
  renderFresh();
  renderTabs();
  if (state.view === 'due') renderDue();
  else if (state.view === 'missing') renderMissing();
  else if (state.view === 'grades') renderGrades();
  else if (state.view === 'changes') renderChanges();
  else if (state.view === 'student') renderStudent();
  else renderOverview();
}

function monday(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  const day = date.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  return shift(iso, offset);
}

function shift(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function load() {
  const response = await fetch('/api/state');
  state.data = await response.json();
  readHash();
  render();
}

function readHash() {
  const hash = location.hash.replace(/^#\//, '');
  if (hash.startsWith('student/')) {
    state.view = 'student';
    state.student = decodeURIComponent(hash.slice('student/'.length));
    return;
  }
  if (views.some(([id]) => id === hash)) {
    state.view = hash;
    state.student = null;
  }
}

function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 4200);
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const dark = document.documentElement.dataset.theme === 'dark'
    || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  themeButton.textContent = dark ? 'Dark' : 'Light';
  themeButton.setAttribute('aria-pressed', String(dark));
}

themeButton.addEventListener('click', () => {
  const dark = themeButton.getAttribute('aria-pressed') === 'true';
  const next = dark ? 'light' : 'dark';
  localStorage.setItem('school-pulse-theme', next);
  applyTheme(next);
});

applyTheme(localStorage.getItem('school-pulse-theme'));

window.addEventListener('hashchange', () => {
  readHash();
  render();
});

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  const key = event.key;
  const view = views.find(([, , shortcut]) => shortcut === key);
  if (view) {
    state.view = view[0];
    state.student = null;
    location.hash = `#/${view[0]}`;
    render();
  } else if (key === 't') themeButton.click();
  else if (key === '?') help.showModal();
  else if (key === '[' || key === ']') {
    const list = state.data?.students ?? [];
    if (!list.length) return;
    const index = Math.max(0, list.findIndex((student) => student.id === state.student));
    const next = key === ']' ? (index + 1) % list.length : (index - 1 + list.length) % list.length;
    state.student = list[next].id;
    state.view = 'student';
    location.hash = `#/student/${encodeURIComponent(state.student)}`;
    render();
  }
});

const events = new EventSource('/api/events');
events.addEventListener('pulse', (event) => {
  const payload = JSON.parse(event.data);
  if (payload.type === 'update') {
    const summary = payload.changes?.[0]?.summary;
    if (summary) showToast(summary);
    load();
  }
});

load();
