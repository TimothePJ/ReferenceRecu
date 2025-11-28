const els = {
  dropdown: document.getElementById('firstColumnDropdown'),
  granularity: document.getElementById('granularityDropdown'),

  canvas: document.getElementById('chart'),
  chartWrap: document.getElementById('chartWrap'),
  empty: document.getElementById('emptyState'),
  tooltip: document.getElementById('tooltip'),

  kpiTotal: document.getElementById('kpiTotal'),
  cardTitle: document.getElementById('cardTitle'),

  details: document.getElementById('details'),
  detailsTitle: document.getElementById('detailsTitle'),
  detailsList: document.getElementById('detailsList'),
};

const state = {
  cols: null,
  nRows: 0,

  // project -> [rowIndex]
  projectIndex: new Map(),

  // rowId -> rowIndex
  rowIdToIndex: new Map(),

  selectedProject: "",
  selectedGranularity: "month",

  cache: new Map(),

  dataToken: 0,
  computeToken: 0,

  bars: [],
};

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[c]));
}

// Encoded dates parsing
function parseMaybeDate(v) {
  if (!v) return null;

  if (v instanceof Date && !isNaN(v.getTime())) return v;

  if (typeof v === "object" && v && typeof v.toDate === "function") {
    const d = v.toDate();
    return (d instanceof Date && !isNaN(d.getTime())) ? d : null;
  }

  // Encoded date/datetime: ["D", seconds] / ["d", seconds]
  if (Array.isArray(v)) {
    const code = v[0];
    if ((code === "D" || code === "d") && typeof v[1] === "number") {
      const seconds = v[1];
      const d = new Date(seconds * 1000);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  if (typeof v === "string") {
    const s = v.trim();
    if (!s || s === "-" || s.startsWith("1900-01-01")) return null;

    // dd/mm/yyyy
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
    if (m) {
      const dd = Number(m[1]);
      const mm = Number(m[2]);
      const yyyy = Number(m[3]);
      const d = new Date(Date.UTC(yyyy, mm - 1, dd));
      return isNaN(d.getTime()) ? null : d;
    }

    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}

function startOfMonthUTC(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function startOfYearUTC(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
}

function startOfWeekUTC(d) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7;
  x.setUTCDate(x.getUTCDate() - dow); 
  return x;
}

function addMonthsUTC(dateUTC, delta) {
  const y = dateUTC.getUTCFullYear();
  const m = dateUTC.getUTCMonth();
  const total = y * 12 + m + delta;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  return new Date(Date.UTC(ny, nm, 1));
}

function addYearsUTC(dateUTC, delta) {
  return new Date(Date.UTC(dateUTC.getUTCFullYear() + delta, 0, 1));
}

function addWeeksUTC(dateUTC, delta) {
  const x = new Date(dateUTC);
  x.setUTCDate(x.getUTCDate() + delta * 7);
  return x;
}

function bucketStartUTC(d, gran) {
  if (gran === "year") return startOfYearUTC(d);
  if (gran === "week") return startOfWeekUTC(d);
  return startOfMonthUTC(d);
}

function isoWeekKeyFromWeekStart(weekStartUTC) {
  const th = new Date(weekStartUTC);
  th.setUTCDate(th.getUTCDate() + 3);
  const isoYear = th.getUTCFullYear();

  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const week1Mon = new Date(jan4);
  week1Mon.setUTCDate(jan4.getUTCDate() - jan4Dow);

  const diff = Math.round((weekStartUTC - week1Mon) / (7 * 24 * 3600 * 1000));
  const weekNo = diff + 1;

  return `${isoYear}-W${String(weekNo).padStart(2, "0")}`;
}

function bucketKeyFromStart(startUTC, gran) {
  if (gran === "year") return String(startUTC.getUTCFullYear());
  if (gran === "week") return isoWeekKeyFromWeekStart(startUTC);
  return `${startUTC.getUTCFullYear()}-${pad2(startUTC.getUTCMonth() + 1)}`;
}

function bucketLabelFromStart(startUTC, gran) {
  if (gran === "year") return String(startUTC.getUTCFullYear());

  if (gran === "week") {
    // libellé lisible au lieu de S01/S02...
    const nowY = new Date().getFullYear();
    const y = startUTC.getUTCFullYear();
    return startUTC.toLocaleDateString("fr-FR", {
      day: "2-digit",
      month: "long",
      ...(y !== nowY ? { year: "numeric" } : {})
    });
  }

  // month
  return startUTC.toLocaleDateString("fr-FR", { month: "short", year: "numeric" });
}

function nextBucketUTC(startUTC, gran, delta) {
  if (gran === "year") return addYearsUTC(startUTC, delta);
  if (gran === "week") return addWeeksUTC(startUTC, delta);
  return addMonthsUTC(startUTC, delta);
}

function granularityLabel(g) {
  if (g === "week") return "semaine";
  if (g === "year") return "année";
  return "mois";
}

function getCol(nameCandidates) {
  if (!state.cols) return null;
  for (const n of nameCandidates) {
    if (state.cols[n]) return state.cols[n];
  }
  return null;
}

function normalizeColumnsData(data) {
  if (!data) return null;

  // rows format => convert
  if (Array.isArray(data)) {
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

  if (typeof data === "object") return data;
  return null;
}

async function buildProjectsListAndIndex(token) {
  const colProj = getCol(["NomProjetString", "NomProjet"]);
  if (!colProj) return;

  const uniq = new Set();
  const index = new Map();
  const n = colProj.length || 0;

  for (let i = 0; i < n; i++) {
    if (token !== state.dataToken) return;
    const p = normStr(colProj[i]);
    if (p) {
      uniq.add(p);
      let arr = index.get(p);
      if (!arr) {
        arr = [];
        index.set(p, arr);
      }
      arr.push(i);
    }
    if (i % 12000 === 0) await sleep0();
  }

  state.projectIndex = index;

  const values = Array.from(uniq);
  if (typeof window.populateFirstColumnDropdown === "function") {
    window.populateFirstColumnDropdown(values);
  } else {
    els.dropdown.innerHTML = '<option value="">Selectionner un projet</option>';
    values.sort((a, b) => a.localeCompare(b));
    for (const v of values) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      els.dropdown.appendChild(opt);
    }
  }

  if (state.selectedProject && values.includes(state.selectedProject)) {
    els.dropdown.value = state.selectedProject;
  }
}

function clearDetails() {
  if (els.details) els.details.hidden = true;
  if (els.detailsTitle) els.detailsTitle.textContent = "";
  if (els.detailsList) els.detailsList.innerHTML = "";
}

function clearSelectionInGrist() {
  try {
    return grist.viewApi.setSelectedRows(null);
  } catch {
    return Promise.resolve();
  }
}

function cacheKey(project, gran) {
  return `${project}|||${gran}`;
}

async function computeAndRender(project, gran) {
  gran = gran || state.selectedGranularity || "month";

  if (!project) {
    state.selectedProject = "";
    els.kpiTotal.textContent = "—";
    els.cardTitle.textContent = `Réception par ${granularityLabel(gran)}`;
    els.empty.textContent = "Selectionne un projet.";
    els.empty.hidden = false;
    drawEmpty();
    clearDetails();
    await clearSelectionInGrist();
    return;
  }

  state.selectedProject = project;

  const cKey = cacheKey(project, gran);
  if (state.cache.has(cKey)) {
    renderModel(state.cache.get(cKey), gran);
    clearDetails();
    return;
  }

  const token = ++state.computeToken;
  els.empty.textContent = "";
  els.empty.hidden = true;
  drawEmpty();
  hideTooltip();
  clearDetails();

  const colArchive = getCol(["Archive"]);
  const colRecu = getCol(["Recu", "RecuString"]);
  const colRowId = getCol(["id", "ID", "Id"]);

  if (!colRecu || !colRowId) {
    els.empty.textContent = "Colonnes manquantes. Affiche au minimum : NomProjetString, Recu (ou RecuString), Archive.";
    els.empty.hidden = false;
    return;
  }

  const idxs = state.projectIndex.get(project) || [];
  const counts = new Map();        // bucketKey -> count
  const rowIdsByKey = new Map();   // bucketKey -> [rowIds]
  let minStart = null;
  let maxStart = null;
  let total = 0;

  for (let j = 0; j < idxs.length; j++) {
    if (token !== state.computeToken) return;
    const i = idxs[j];

    if (colArchive && safeBool(colArchive[i])) {
      if (j % 12000 === 0) await sleep0();
      continue;
    }

    const d = parseMaybeDate(colRecu[i]);
    if (!d || d.getUTCFullYear() === 1900) {
      if (j % 12000 === 0) await sleep0();
      continue;
    }

    const start = bucketStartUTC(d, gran);
    const key = bucketKeyFromStart(start, gran);

    total++;
    counts.set(key, (counts.get(key) || 0) + 1);

    let arr = rowIdsByKey.get(key);
    if (!arr) {
      arr = [];
      rowIdsByKey.set(key, arr);
    }
    arr.push(colRowId[i]);

    if (!minStart || start.getTime() < minStart.getTime()) minStart = start;
    if (!maxStart || start.getTime() > maxStart.getTime()) maxStart = start;

    if (j % 12000 === 0) await sleep0();
  }

  if (token !== state.computeToken) return;

  if (!minStart || !maxStart || total === 0) {
    const model = { project, keys: [], labels: [], counts: [], rowIdsByKey, total: 0 };
    state.cache.set(cKey, model);
    renderModel(model, gran);
    return;
  }

  // Expand -2 .. +2 then hide first 2 + last 2 (pour enlever les 0 inutiles)
  const startRange = nextBucketUTC(minStart, gran, -2);
  const endRange = nextBucketUTC(maxStart, gran, +2);

  const allKeys = [];
  const allLabels = [];
  const allCounts = [];

  let cur = startRange;
  let safety = 0;
  while (cur.getTime() <= endRange.getTime() && safety++ < 5000) {
    const k = bucketKeyFromStart(cur, gran);
    allKeys.push(k);
    allLabels.push(bucketLabelFromStart(cur, gran));
    allCounts.push(counts.get(k) || 0);
    cur = nextBucketUTC(cur, gran, +1);
    if (safety % 400 === 0) await sleep0();
  }

  let keys = allKeys, labels = allLabels, countsArr = allCounts;
  if (allKeys.length > 4) {
    keys = allKeys.slice(2, -2);
    labels = allLabels.slice(2, -2);
    countsArr = allCounts.slice(2, -2);
  }

  const model = { project, keys, labels, counts: countsArr, rowIdsByKey, total };
  state.cache.set(cKey, model);
  renderModel(model, gran);
}

function onGristRecords(data) {
  state.dataToken++;
  const token = state.dataToken;

  const cols = normalizeColumnsData(data);
  if (!cols) return;

  state.cols = cols;

  // rowId->index map (fast details rendering)
  state.rowIdToIndex = new Map();
  const colRowId = getCol(["id", "ID", "Id"]) || [];
  for (let i = 0; i < colRowId.length; i++) state.rowIdToIndex.set(colRowId[i], i);

  state.nRows = colRowId.length || 0;

  state.cache.clear();
  state.projectIndex.clear();
  clearDetails();

  buildProjectsListAndIndex(token);

  if (state.selectedProject) {
    computeAndRender(state.selectedProject, state.selectedGranularity);
  } else {
    drawEmpty();
    els.empty.textContent = "Selectionne un projet.";
    els.empty.hidden = false;
  }
}

function initGrist() {
  grist.ready({ requiredAccess: "read table" });

  grist.onRecords(onGristRecords, {
    format: "columns",
    includeColumns: "shown",
    keepEncoded: true,
    expandRefs: false,
  });
}

function renderDetailsForBucket(model, bucketKey, bucketLabel) {
  if (!els.details || !els.detailsList || !els.detailsTitle) return;

  const ids = model.rowIdsByKey.get(bucketKey) || [];
  if (!ids.length) {
    clearDetails();
    return;
  }

  const colDoc = getCol(["NomDocument"]);
  const colEm = getCol(["Emetteur"]);
  const colRef = getCol(["Reference"]);
  const colInd = getCol(["Indice"]);
  const colRecu = getCol(["Recu", "RecuString"]);
  const colObs = getCol(["DescriptionObservations"]);

  const formatDateFR = (d) => d
    ? d.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" })
    : "-";

  // Group by NomDocument
  const groups = new Map(); // docName -> rows[]
  const MAX = 600; // sécurité perf si énorme
  const slice = ids.slice(0, MAX);

  for (const rowId of slice) {
    const i = state.rowIdToIndex.get(rowId);
    if (i == null) continue;

    const doc = normStr(colDoc?.[i]) || "Sans document";
    const em = normStr(colEm?.[i]) || "-";
    const ref = normStr(colRef?.[i]) || "-";
    const ind = normStr(colInd?.[i]) || "-";
    const d = parseMaybeDate(colRecu?.[i]);
    const recuTxt = formatDateFR(d);
    const obs = normStr(colObs?.[i]) || "-";

    if (!groups.has(doc)) groups.set(doc, []);
    groups.get(doc).push({
      rowId,
      em, ref, ind,
      recuMs: d ? d.getTime() : 0,
      recuTxt,
      obs
    });
  }

  // Sort docs alphabetically, rows by date desc then emetteur
  const docNames = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b, "fr"));
  for (const doc of docNames) {
    groups.get(doc).sort((a, b) => (b.recuMs - a.recuMs) || a.em.localeCompare(b.em, "fr"));
  }

  els.detailsTitle.textContent = `${bucketLabel} — ${ids.length} reçu(s)`;
  els.details.hidden = false;

  // Render grouped tables
  els.detailsList.innerHTML = docNames.map(doc => {
    const rows = groups.get(doc);
    return `
      <div class="docGroup">
        <div class="docTitle">
          <span class="docName">${escapeHtml(doc)}</span>
        </div>

        <div class="tableWrap">
          <table class="miniTable">
            <colgroup>
              <col class="cEm">
              <col class="cRef">
              <col class="cInd">
              <col class="cRecu">
              <col class="cObs">
            </colgroup>
            <thead>
              <tr>
                <th>Émetteur</th>
                <th>Référence</th>
                <th>Indice</th>
                <th>Reçu</th>
                <th>Observation</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(r => `
                <tr>
                  <td>${escapeHtml(r.em)}</td>
                  <td class="tdRef">${escapeHtml(r.ref)}</td>
                  <td>${escapeHtml(r.ind)}</td>
                  <td>${escapeHtml(r.recuTxt)}</td>
                  <td class="tdObs">${escapeHtml(r.obs)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }).join("");

  if (ids.length > MAX) {
    els.detailsList.insertAdjacentHTML(
      "beforeend",
      `<div class="detailsSub">… ${ids.length - MAX} lignes non affichées (limite ${MAX})</div>`
    );
  }
}

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

function renderModel(model, gran) {
  const gLabel = granularityLabel(gran);
  els.cardTitle.textContent = model.project
    ? `Réception par ${gLabel} — ${model.project}`
    : `Réception par ${gLabel}`;

  if (!model.keys || model.keys.length === 0) {
    els.kpiTotal.textContent = "0";
    els.empty.textContent = "Aucun reçu (hors archives) pour ce projet.";
    els.empty.hidden = false;
    drawEmpty();
    clearDetails();
    return;
  }

  els.kpiTotal.textContent = String(model.total);
  els.empty.hidden = true;
  drawBars(model.labels, model.counts, model.keys);
}

function drawBars(labels, counts, keys) {
  const ctx = els.canvas.getContext("2d");
  if (!ctx) return;

  const dpr = resizeCanvasToDisplaySize();
  const W = els.canvas.width;
  const H = els.canvas.height;

  ctx.clearRect(0, 0, W, H);

  const padL = Math.floor(54 * dpr);
  const padR = Math.floor(16 * dpr);
  const padT = Math.floor(18 * dpr);
  const padB = Math.floor(60 * dpr);

  const plotW = Math.max(10, W - padL - padR);
  const plotH = Math.max(10, H - padT - padB);

  const maxVal = Math.max(1, ...counts);
  const yTicks = Math.min(5, maxVal);
  const tickStep = Math.max(1, Math.ceil(maxVal / yTicks));

  const css = getComputedStyle(document.documentElement);
  const grid = css.getPropertyValue("--border").trim() || "#4a4a4a";
  const text = css.getPropertyValue("--muted").trim() || "#bdbdbd";
  const bar = css.getPropertyValue("--accent").trim() || "#4cc3ff";

  ctx.font = `${Math.floor(12 * dpr)}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
  ctx.textBaseline = "middle";
  ctx.fillStyle = text;
  ctx.strokeStyle = grid;
  ctx.lineWidth = Math.max(1, Math.floor(1 * dpr));

  // grid + y labels
  for (let v = 0; v <= maxVal; v += tickStep) {
    const t = v / maxVal;
    const y = padT + (1 - t) * plotH;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.textAlign = "right";
    ctx.fillText(String(v), padL - Math.floor(10 * dpr), y);
  }

  // bars
  const n = labels.length;
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

    ctx.fillStyle = bar;
    const r = Math.min(6 * dpr, barW / 2, h);
    roundRect(ctx, x0, y0, barW, h, r);
    ctx.fill();

    state.bars.push({ x0, x1, y0, y1, key: keys[i], count: c, label: labels[i] });
  }

  // x labels (auto skip)
  ctx.fillStyle = text;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  const maxLabels = Math.floor(plotW / (78 * dpr));
  const step = Math.max(1, Math.ceil(n / Math.max(1, maxLabels)));

  for (let i = 0; i < n; i += step) {
    const x = padL + i * (barW + gap) + barW / 2;
    const y = padT + plotH + Math.floor(10 * dpr);
    ctx.save();
    ctx.translate(x, y);
    if (step > 1) ctx.rotate(-0.35);
    ctx.fillText(labels[i], 0, 0);
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
  els.tooltip.textContent = `${bar.label} : ${bar.count}`;
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

async function selectBucketInGrist(bucketKey) {
  const project = state.selectedProject;
  const gran = state.selectedGranularity;
  const model = state.cache.get(cacheKey(project, gran));
  if (!model) return;

  const rowIds = model.rowIdsByKey.get(bucketKey) || [];
  try {
    await grist.viewApi.setSelectedRows(rowIds.length ? rowIds : null);
  } catch {
    // ignore
  }
}

function attachEvents() {
  // Default granularity
  if (els.granularity) {
    const v = normStr(els.granularity.value) || "month";
    state.selectedGranularity = (v === "week" || v === "year" || v === "month") ? v : "month";
    els.granularity.value = state.selectedGranularity;

    els.granularity.addEventListener("change", () => {
      const g = normStr(els.granularity.value) || "month";
      state.selectedGranularity = (g === "week" || g === "year" || g === "month") ? g : "month";
      state.computeToken++;
      hideTooltip();
      clearDetails();
      clearSelectionInGrist();
      if (state.selectedProject) computeAndRender(state.selectedProject, state.selectedGranularity);
      else renderModel({ project: "", keys: [], labels: [], counts: [], rowIdsByKey: new Map(), total: 0 }, state.selectedGranularity);
    });
  }

  // Project change
  els.dropdown.addEventListener("change", () => {
    const p = normStr(els.dropdown.value);
    state.computeToken++;
    hideTooltip();
    clearDetails();
    clearSelectionInGrist();
    computeAndRender(p, state.selectedGranularity);
  });

  // Hover tooltip
  els.canvas.addEventListener("mousemove", (e) => {
    const b = getBarAtClientPos(e.clientX, e.clientY);
    if (!b || b.count <= 0) return hideTooltip();
    showTooltip(b, e.clientX, e.clientY);
  });
  els.canvas.addEventListener("mouseleave", hideTooltip);

  // Click: select rows + show details
  els.canvas.addEventListener("click", async (e) => {
    const b = getBarAtClientPos(e.clientX, e.clientY);
    if (!b || b.count <= 0) return;

    await selectBucketInGrist(b.key);

    const model = state.cache.get(cacheKey(state.selectedProject, state.selectedGranularity));
    if (model) renderDetailsForBucket(model, b.key, b.label);
  });

  // Responsive redraw
  window.addEventListener("resize", () => {
    const model = state.cache.get(cacheKey(state.selectedProject, state.selectedGranularity));
    if (model) drawBars(model.labels, model.counts, model.keys);
    else drawEmpty();
  });
}

(function boot() {
  attachEvents();
  drawEmpty();
  initGrist();
})();
