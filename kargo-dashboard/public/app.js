'use strict';

const rowsEl = document.getElementById('rows');
const legendEl = document.getElementById('legend');
const bannerEl = document.getElementById('banner');
const updatedEl = document.getElementById('updated');
const NEUTRAL = '#9e9e9e';

// Pick black or white text for readability on a #rrggbb background (WCAG relative luminance).
function textColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#000';
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#000' : '#fff';
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderLegend(thresholds) {
  legendEl.replaceChildren();
  let prev = 0;
  for (const t of thresholds) {
    const range = t.max === null ? `${prev}+` : t.max === prev ? `${prev}` : `${prev}–${t.max}`;
    const item = el('span');
    const swatch = el('i');
    swatch.style.background = t.color;
    item.append(swatch, document.createTextNode(`${t.label} (${range} behind)`));
    legendEl.append(item);
    if (t.max !== null) prev = t.max + 1;
  }
}

function tooltip(cell) {
  const lines = [];
  if (cell.alias) lines.push(`Alias: ${cell.alias}`);
  if (cell.freightName) lines.push(`Freight: ${cell.freightName}`);
  if (cell.decay.behind !== null && cell.decay.behind !== undefined) {
    lines.push(`${cell.decay.behind} version${cell.decay.behind === 1 ? '' : 's'} behind latest`);
  }
  if (cell.since) lines.push(`Deployed since: ${new Date(cell.since).toLocaleString()}`);
  if (cell.createdAt) lines.push(`Created: ${new Date(cell.createdAt).toLocaleString()}`);
  return lines.join('\n');
}

// A link when a URL is known, otherwise plain text. Opens Kargo in a new tab.
function linkOrText(tag, className, text, href) {
  const e = el(tag, className);
  if (!href) {
    e.textContent = text;
    return e;
  }
  const a = el('a', '', text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  e.append(a);
  return e;
}

function renderCell(s) {
  const color = s.decay.color || NEUTRAL;
  const c = el('div', 'cell');
  c.style.background = color;
  c.style.color = textColor(color);
  c.append(linkOrText('span', 'stage', s.name, s.stageUrl), linkOrText('span', 'version', s.version ?? '—', s.freightUrl),
    el('span', 'status', s.decay.label));
  c.title = tooltip(s);
  return c;
}

// One warehouse's pipeline: [caption?][latest][stage cells...], left-packed in pipeline order.
function renderLane(lane, showCaption) {
  const l = el('div', 'lane');
  if (showCaption) {
    l.classList.add('captioned');
    l.append(el('div', 'lane-caption', lane.warehouse));
  }
  if (lane.error) {
    l.classList.add('error');
    l.append(el('div', 'message', lane.error));
    return l;
  }
  const latest = el('div', 'cell latest');
  latest.append(el('span', 'stage', 'latest'),
    linkOrText('span', 'version', lane.latest ? lane.latest.version : '—', lane.latest?.freightUrl));
  if (lane.latest) latest.title = tooltip({ ...lane.latest, decay: {} });
  l.append(latest, ...lane.stages.map(renderCell));
  return l;
}

// A project is one row: its label once on the left, then one lane per warehouse.
function renderRow(row) {
  const r = el('section', 'row');
  const label = el('div', 'label');
  label.append(linkOrText('span', '', row.displayName, row.projectUrl));
  if (row.displayName !== row.project) label.append(el('small', '', row.project));
  r.append(label);

  if (row.error) {
    r.classList.add('error');
    r.append(el('div', 'message', row.error));
    return r;
  }
  const lanes = el('div', 'lanes');
  lanes.append(...row.lanes.map((lane) => renderLane(lane, row.showLaneCaptions)));
  r.append(lanes);
  return r;
}

function render(data) {
  renderLegend(data.thresholds);
  rowsEl.replaceChildren(...data.rows.map(renderRow));
  bannerEl.hidden = !data.refreshError;
  bannerEl.textContent = data.refreshError ? `Latest refresh failed, showing previous data: ${data.refreshError}` : '';
  updatedEl.textContent = `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`;
}

// ---- Dashboards: the title is the picker; the URL is the state (/ is the default, /d/<id> the rest) ----
const titleEl = document.getElementById('title');
let dashboards = [];
let currentId = null;
let pollTimer = null;
let pollToken = 0; // bumped on every dashboard switch so a late response can't overwrite the new view

const defaultDashboard = () => dashboards.find((d) => d.default) || dashboards[0];
const pathFor = (d) => (d.default ? '/' : `/d/${encodeURIComponent(d.id)}`);

function idFromLocation() {
  const m = /^\/d\/([^/]+)\/?$/.exec(location.pathname);
  return m ? decodeURIComponent(m[1]) : defaultDashboard().id;
}

// Built once, so keyboard focus survives switching; afterwards only its value and the page title change.
function buildTitle() {
  const current = dashboards.find((d) => d.id === currentId) || defaultDashboard();
  if (dashboards.length < 2) {
    titleEl.textContent = current.name; // a single dashboard looks like a plain heading
    return;
  }
  const picker = el('span', 'picker');
  const select = el('select');
  select.id = 'dashboard-select';
  select.setAttribute('aria-label', 'Dashboard');
  for (const d of dashboards) {
    const o = el('option', '', d.default ? `${d.name} (default)` : d.name);
    o.value = d.id;
    select.append(o);
  }
  select.addEventListener('change', () => {
    const next = dashboards.find((d) => d.id === select.value);
    history.pushState({}, '', pathFor(next));
    showDashboard(next.id);
  });
  picker.append(select);
  titleEl.replaceChildren(picker);
}

function syncTitle() {
  const current = dashboards.find((d) => d.id === currentId) || defaultDashboard();
  document.title = `${current.name} · Kargo Dashboard`;
  const select = document.getElementById('dashboard-select');
  if (select) select.value = current.id;
}

function showDashboard(id) {
  currentId = id;
  syncTitle();
  rowsEl.replaceChildren(el('p', 'muted', 'Loading…'));
  bannerEl.hidden = true;
  updatedEl.textContent = '';
  clearTimeout(pollTimer);
  pollToken += 1;
  poll(pollToken);
}

async function poll(token) {
  let delay = 3;
  try {
    const res = await fetch(`/api/summary?dashboard=${encodeURIComponent(currentId)}`);
    if (token !== pollToken) return; // superseded by a dashboard switch
    if (res.ok) {
      const data = await res.json();
      if (token !== pollToken) return;
      render(data);
      delay = data.refreshIntervalSeconds;
    } else if (res.status !== 503) {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    if (token !== pollToken) return;
    bannerEl.hidden = false;
    bannerEl.textContent = `Cannot reach the dashboard server: ${err.message}`;
    delay = 10;
  }
  pollTimer = setTimeout(() => poll(token), delay * 1000);
}

async function start() {
  try {
    dashboards = await (await fetch('/api/dashboards')).json();
  } catch (err) {
    bannerEl.hidden = false;
    bannerEl.textContent = `Cannot reach the dashboard server: ${err.message}`;
    setTimeout(start, 10000);
    return;
  }
  currentId = idFromLocation();
  buildTitle();
  window.addEventListener('popstate', () => showDashboard(idFromLocation()));
  showDashboard(currentId);
}

start();
