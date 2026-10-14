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

function renderRow(row) {
  const r = el('section', 'row');
  const label = el('div', 'label', row.displayName);
  if (row.displayName !== row.project) label.append(el('small', '', row.project));
  r.append(label);

  if (row.error) {
    r.classList.add('error');
    r.append(el('div', 'message', row.error));
    return r;
  }

  const latest = el('div', 'cell latest');
  latest.append(el('span', 'stage', 'latest'), el('span', 'version', row.latest ? row.latest.version : '—'));
  if (row.latest) latest.title = tooltip({ ...row.latest, decay: {} });
  r.append(latest);

  for (const s of row.stages) {
    const color = s.decay.color || NEUTRAL;
    const c = el('div', 'cell');
    c.style.background = color;
    c.style.color = textColor(color);
    c.append(el('span', 'stage', s.name), el('span', 'version', s.version ?? '—'), el('span', 'status', s.decay.label));
    c.title = tooltip(s);
    r.append(c);
  }
  return r;
}

function render(data) {
  renderLegend(data.thresholds);
  rowsEl.replaceChildren(...data.rows.map(renderRow));
  bannerEl.hidden = !data.refreshError;
  bannerEl.textContent = data.refreshError ? `Latest refresh failed, showing previous data: ${data.refreshError}` : '';
  updatedEl.textContent = `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`;
}

async function poll() {
  let delay = 3;
  try {
    const res = await fetch('api/summary');
    if (res.ok) {
      const data = await res.json();
      render(data);
      delay = data.refreshIntervalSeconds;
    } else if (res.status !== 503) {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    bannerEl.hidden = false;
    bannerEl.textContent = `Cannot reach the dashboard server: ${err.message}`;
    delay = 10;
  }
  setTimeout(poll, delay * 1000);
}

poll();
