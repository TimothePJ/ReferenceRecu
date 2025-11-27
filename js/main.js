/* ReferenceRecu - ultra fast version
   Goals:
   - Dropdown is populated like your other widgets (populateFirstColumnDropdown).
   - Performance: avoid decoding refs/dates, fetch only "shown" columns, compute per-project lazily with cancellation + chunking.
   - No reset button, no period selector, no extra "0 months" at ends.
*/

const els = {
  dropdown: document.getElementById('firstColumnDropdown'),
  canvas: document.getElementById('chart'),
  chartWrap: document.getElementById('chartWrap'),
  empty: document.getElementById('emptyState'),
  tooltip: document.getElementById('tooltip'),
  kpiTotal: document.getElementById('kpiTotal'),
  cardTitle: document.getElementById('cardTitle'),
};

const state = {
  // Raw columns from Grist (columns format)
  cols: null,
  nRows: 0,

  // Current selection
  selectedProject: "",

  // Cache computed per project
  cache: new Map(), // project -> {months:[], counts:[], rowIdsByMonth: Map, total:number, firstKey, lastKey}

  // Cancellation tokens
  dataToken: 0,
  computeToken: 0,

  // Render bookkeeping
  bars: [], // [{x0,x1,y0,y1, key, count}]
};

// ---------- Utils
const sleep0 = () => new Promise(r => setTimeout(r, 0));

function normStr(v) {
  if (v == null) return "";
  const s = String(v).trim();
  return (s === "-" ? "" : s);
}

function safeBool(v) {
  return v === true || v === "true" || v === 1;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function monthKeyFromUTCDate(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

function parseMaybeDate(v) {
  // We mostly get raw encoded cell values (keepEncoded: true).
  // DateTimes are ["D", timestampSeconds, "UTC"] ; dates are ["d", timestampSeconds].
  // See GristData.CellValue docs.
  if (!v) return null;

  // Already a Date (if keepEncoded was false somewhere)
  if (v instanceof Date && !isNaN(v.getTime())) return v;

  // Moment-like
  if (typeof v === "object" && v && typeof v.toDate === "function") {
    const d = v.toDate();
    return (d instanceof Date && !isNaN(d.getTime())) ? d : null;
  }

  // Encoded date/datetime
  if (Array.isArray(v)) {
    const code = v[0];
    if ((code === "D" || code === "d") && typeof v[1] === "number") {
      const seconds = v[1];
      const d = new Date(seconds * 1000);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  // String (ISO or FR dd/mm/yyyy)
  if (typeof v === "string") {
    const s = v.trim();
    if (!s || s === "-" || s.startsWith("1900-01-01")) return null;

    // dd/mm/yyyy (RecuString)
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
    if (m) {
      const dd = Number(m[1]);
      const mm = Number(m[2]);
      const yyyy = Number(m[3]);
      const d = new Date(Date.UTC(yyyy, mm - 1, dd));
      return isNaN(d.getTime()) ? null : d;
    }

    // ISO-ish
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}

function parseMonthKey(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return {y: 1970, m: 1};
  return { y: Number(m[1]), m: Number(m[2]) };
}

function monthKeyAdd(key, deltaMonths) {
  const {y, m} = parseMonthKey(key);
  let total = y * 12 + (m - 1) + deltaMonths;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${pad2(nm)}`;
}

function monthKeyCompare(a, b) {
  return a === b ? 0 : (a < b ? -1 : 1);
}

function makeMonthRange(firstKey, lastKey) {
  if (!firstKey || !lastKey) return [];
  if (monthKeyCompare(firstKey, lastKey) > 0) return [];
  const out = [];
  let k = firstKey;
  out.push(k);
  while (k !== lastKey && out.length < 2400) { // safety
    k = monthKeyAdd(k, 1);
    out.push(k);
  }
  return out;
}

function formatMonthFR(yyyyMM) {
  const {y, m} = parseMonthKey(yyyyMM);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleDateString("fr-FR", { month: "short", year: "numeric" });
}

// ---------- Grist integration

function getCol(nameCandidates) {
  if (!state.cols) return null;
  for (const n of nameCandidates) {
    if (state.cols[n]) return state.cols[n];
  }
  return null;
}

function normalizeColumnsData(data) {
  // Expected: format:"columns" => object with keys -> arrays
  // Also accept rows format and convert if needed.
  if (!data) return null;

  if (Array.isArray(data)) {
    // rows format: [{id: 1, ColA: ...}, ...]
    const cols = {};
    for (let i = 0; i < data.length; i++) {
      const row = data[i] || {};
      for (const [k, v] of Object.entries(row)) {
        if (!cols[k]) cols[k] = new Array(data.length);
        cols[k][i] = v;
      }
    }
    return cols;
  }

  // columns format
  if (typeof data === "object") return data;

  return null;
}

async function buildProjectsList(token) {
  const colProj = getCol(["NomProjetString", "NomProjet"]);
  if (!colProj) return;

  const uniq = new Set();
  const n = colProj.length || 0;

  // Chunk to keep UI responsive.
  for (let i = 0; i < n; i++) {
    if (token !== state.dataToken) return;
    const p = normStr(colProj[i]);
    if (p) uniq.add(p);
    if (i % 8000 === 0) await sleep0();
  }

  const values = Array.from(uniq);
  if (typeof window.populateFirstColumnDropdown === "function") {
    window.populateFirstColumnDropdown(values);
  } else {
    // Fallback
    els.dropdown.innerHTML = '<option value="">Selectionner un projet</option>';
    values.sort((a, b) => a.localeCompare(b));
    for (const v of values) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      els.dropdown.appendChild(opt);
    }
  }

  // Restore selection (if any)
  if (state.selectedProject && values.includes(state.selectedProject)) {
    els.dropdown.value = state.selectedProject;
  }
}

function clearSelectionInGrist() {
  try {
    return grist.viewApi.setSelectedRows(null);
  } catch {
    return Promise.resolve();
  }
}

async function computeAndRender(project) {
  if (!project) {
    state.selectedProject = "";
    els.empty.hidden = false;
    els.kpiTotal.textContent = "—";
    els.cardTitle.textContent = "Réception par mois";
    drawEmpty();
    await clearSelectionInGrist();
    return;
  }

  state.selectedProject = project;

  // Cache hit
  if (state.cache.has(project)) {
    const model = state.cache.get(project);
    renderModel(model);
    return;
  }

  // Compute
  const token = ++state.computeToken;
  els.empty.textContent = "";
  els.empty.hidden = true;
  drawEmpty();

  const colProj = getCol(["NomProjetString", "NomProjet"]);
  const colArchive = getCol(["Archive"]);
  const colRecu = getCol(["Recu", "RecuString"]);
  const colRowId = getCol(["id", "ID", "Id"]); // usually 'id'

  if (!colProj || !colRecu || !colRowId) {
    els.empty.textContent = "Colonnes manquantes. Dans le panneau de droite, affiche au minimum : NomProjetString, Recu, Archive.";
    return;
  }

  const n = colRowId.length || 0;
  const counts = new Map();       // yyyy-MM -> count
  const rowIdsByMonth = new Map(); // yyyy-MM -> [rowIds]
  let firstKey = null;
  let lastKey = null;
  let total = 0;

  for (let i = 0; i < n; i++) {
    if (token !== state.computeToken) return;

    const p = normStr(colProj[i]);
    if (p !== project) {
      if (i % 12000 === 0) await sleep0();
      continue;
    }

    if (colArchive && safeBool(colArchive[i])) {
      if (i % 12000 === 0) await sleep0();
      continue;
    }

    const d = parseMaybeDate(colRecu[i]);
    if (!d) {
      if (i % 12000 === 0) await sleep0();
      continue;
    }

    // Ignore "fake" 1900 dates, if they come through
    if (d.getUTCFullYear() === 1900) {
      if (i % 12000 === 0) await sleep0();
      continue;
    }

    const key = monthKeyFromUTCDate(d);
    total++;

    counts.set(key, (counts.get(key) || 0) + 1);
    let arr = rowIdsByMonth.get(key);
    if (!arr) {
      arr = [];
      rowIdsByMonth.set(key, arr);
    }
    arr.push(colRowId[i]);

    if (!firstKey || monthKeyCompare(key, firstKey) < 0) firstKey = key;
    if (!lastKey || monthKeyCompare(key, lastKey) > 0) lastKey = key;

    if (i % 12000 === 0) await sleep0();
  }

  if (token !== state.computeToken) return;

  if (!firstKey || !lastKey || total === 0) {
    const model = { project, months: [], counts: [], rowIdsByMonth, total: 0, firstKey: null, lastKey: null };
    state.cache.set(project, model);
    renderModel(model);
    return;
  }

  const months = makeMonthRange(firstKey, lastKey);
  const countsArr = months.map(k => counts.get(k) || 0);

  const model = { project, months, counts: countsArr, rowIdsByMonth, total, firstKey, lastKey };
  state.cache.set(project, model);
  renderModel(model);
}

function onGristRecords(data) {
  state.dataToken++;
  const token = state.dataToken;

  const cols = normalizeColumnsData(data);
  if (!cols) return;

  state.cols = cols;
  state.nRows = (getCol(["id", "ID", "Id"]) || []).length || 0;
  state.cache.clear();

  // Build dropdown like your other widgets
  buildProjectsList(token);

  // Keep current selection rendered if possible
  const selected = state.selectedProject;
  if (selected) {
    // Recompute (cache cleared)
    computeAndRender(selected);
  } else {
    drawEmpty();
  }
}

function initGrist() {
  grist.ready({
    requiredAccess: "read table",
  });

  // Important performance knobs:
  // - format:"columns" avoids building row objects.
  // - includeColumns:"shown" lets you aggressively hide columns in the creator panel.
  // - keepEncoded:true avoids moment conversions for dates.
  // - expandRefs:false avoids expanding reference columns into objects.
  grist.onRecords(onGristRecords, {
    format: "columns",
    includeColumns: "shown",
    keepEncoded: true,
    expandRefs: false,
  });
}

// ---------- Chart rendering (lightweight canvas)

function drawEmpty() {
  const ctx = els.canvas.getContext("2d");
  if (!ctx) return;
  resizeCanvasToDisplaySize();
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  state.bars = [];
}

function resizeCanvasToDisplaySize() {
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const rect = els.canvas.getBoundingClientRect();
  const w = Math.max(10, Math.floor(rect.width * dpr));
  const h = Math.max(10, Math.floor(rect.height * dpr));
  if (els.canvas.width !== w || els.canvas.height !== h) {
    els.canvas.width = w;
    els.canvas.height = h;
  }
  return dpr;
}

function renderModel(model) {
  els.cardTitle.textContent = model.project ? `Réception par mois — ${model.project}` : "Réception par mois";

  if (!model.months || model.months.length === 0) {
    els.kpiTotal.textContent = "0";
    els.empty.textContent = "Aucun reçu (hors archives) pour ce projet.";
    els.empty.hidden = false;
    drawEmpty();
    return;
  }

  els.kpiTotal.textContent = String(model.total);
  els.empty.hidden = true;
  drawBars(model.months, model.counts);
}

function drawBars(monthKeys, counts) {
  const ctx = els.canvas.getContext("2d");
  if (!ctx) return;

  const dpr = resizeCanvasToDisplaySize();
  const W = els.canvas.width;
  const H = els.canvas.height;

  ctx.clearRect(0, 0, W, H);

  // Layout
  const padL = Math.floor(54 * dpr);
  const padR = Math.floor(16 * dpr);
  const padT = Math.floor(18 * dpr);
  const padB = Math.floor(52 * dpr);

  const plotW = Math.max(10, W - padL - padR);
  const plotH = Math.max(10, H - padT - padB);

  const maxVal = Math.max(1, ...counts);
  const yTicks = Math.min(5, maxVal);
  const tickStep = Math.max(1, Math.ceil(maxVal / yTicks));

  // Colors (derived from CSS vars, but canvas needs actual values)
  const css = getComputedStyle(document.documentElement);
  const grid = css.getPropertyValue("--border").trim() || "#4a4a4a";
  const text = css.getPropertyValue("--muted").trim() || "#bdbdbd";
  const bar = css.getPropertyValue("--accent").trim() || "#4cc3ff";

  ctx.font = `${Math.floor(12 * dpr)}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
  ctx.textBaseline = "middle";
  ctx.fillStyle = text;
  ctx.strokeStyle = grid;
  ctx.lineWidth = Math.max(1, Math.floor(1 * dpr));

  // Grid + y labels
  for (let v = 0; v <= maxVal; v += tickStep) {
    const t = v / maxVal;
    const y = padT + (1 - t) * plotH;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const label = String(v);
    ctx.textAlign = "right";
    ctx.fillText(label, padL - Math.floor(10 * dpr), y);
  }

  // Bars
  const n = monthKeys.length;
  const gap = Math.max(2 * dpr, Math.min(10 * dpr, plotW / (n * 6)));
  const barW = Math.max(3 * dpr, (plotW - gap * (n - 1)) / n);

  state.bars = [];
  for (let i = 0; i < n; i++) {
    const c = counts[i];
    const x0 = padL + i * (barW + gap);
    const x1 = x0 + barW;
    const h = (c / maxVal) * plotH;
    const y1 = padT + plotH;
    const y0 = y1 - h;

    // bar
    ctx.fillStyle = bar;
    const r = Math.min(6 * dpr, barW / 2, h);
    roundRect(ctx, x0, y0, barW, h, r);
    ctx.fill();

    state.bars.push({ x0, x1, y0, y1, key: monthKeys[i], count: c });
  }

  // X labels (auto skip)
  ctx.fillStyle = text;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const maxLabels = Math.floor(plotW / (70 * dpr));
  const step = Math.max(1, Math.ceil(n / Math.max(1, maxLabels)));

  for (let i = 0; i < n; i += step) {
    const label = formatMonthFR(monthKeys[i]);
    const x = padL + i * (barW + gap) + barW / 2;
    const y = padT + plotH + Math.floor(10 * dpr);
    ctx.save();
    ctx.translate(x, y);
    // Slight tilt if crowded
    if (step > 1) ctx.rotate(-0.35);
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  if (h <= 0 || w <= 0) return;
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// ---------- Interactions

function getBarAtClientPos(clientX, clientY) {
  const rect = els.canvas.getBoundingClientRect();
  const dpr = els.canvas.width / rect.width;
  const x = (clientX - rect.left) * dpr;
  const y = (clientY - rect.top) * dpr;
  for (const b of state.bars) {
    if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return b;
  }
  return null;
}

function showTooltip(bar, clientX, clientY) {
  if (!bar || !els.tooltip) return;
  const label = formatMonthFR(bar.key);
  els.tooltip.textContent = `${label} : ${bar.count}`;
  els.tooltip.hidden = false;

  const wrapRect = els.chartWrap.getBoundingClientRect();
  const x = clientX - wrapRect.left;
  const y = clientY - wrapRect.top;
  els.tooltip.style.left = `${Math.max(6, Math.min(wrapRect.width - 6, x))}px`;
  els.tooltip.style.top = `${Math.max(6, Math.min(wrapRect.height - 6, y))}px`;
}

function hideTooltip() {
  if (!els.tooltip) return;
  els.tooltip.hidden = true;
}

async function selectMonthInGrist(monthKey) {
  const model = state.cache.get(state.selectedProject);
  if (!model) return;
  const rowIds = model.rowIdsByMonth.get(monthKey) || [];
  try {
    await grist.viewApi.setSelectedRows(rowIds.length ? rowIds : null);
  } catch {
    // ignore
  }
}

// ---------- Boot

function attachEvents() {
  // Dropdown change
  els.dropdown.addEventListener("change", () => {
    const p = normStr(els.dropdown.value);
    // Cancel current compute immediately and clear tooltip
    state.computeToken++;
    hideTooltip();
    computeAndRender(p);
  });

  // Canvas interactions
  els.canvas.addEventListener("mousemove", (e) => {
    const b = getBarAtClientPos(e.clientX, e.clientY);
    if (!b || b.count <= 0) return hideTooltip();
    showTooltip(b, e.clientX, e.clientY);
  });
  els.canvas.addEventListener("mouseleave", hideTooltip);
  els.canvas.addEventListener("click", async (e) => {
    const b = getBarAtClientPos(e.clientX, e.clientY);
    if (!b || b.count <= 0) return;
    await selectMonthInGrist(b.key);
  });

  // Responsive
  window.addEventListener("resize", () => {
    const model = state.cache.get(state.selectedProject);
    if (model) drawBars(model.months, model.counts);
    else drawEmpty();
  });
}

(function boot() {
  attachEvents();
  drawEmpty();
  initGrist();
})();
