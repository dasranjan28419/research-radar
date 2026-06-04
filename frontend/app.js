/* Research Radar - frontend logic
 * Talks to the Flask API, then draws two radar charts side by side.
 */

const $ = (id) => document.getElementById(id);
let paperChart = null;
let journalChart = null;
let cmpPaperChart = null;
let cmpJournalChart = null;
let authorChart = null;

const COLOR_A = "#4f9dff"; // paper / side A
const COLOR_B = "#ff7a59"; // journal / side B

// Which radar axes the user wants shown, per window. Seeded with every axis
// the backend produces (see metrics.py); the left "Radar Features" tab toggles
// these and the plots redraw to match.
const enabledFeatures = {
  paper: new Set([
    "Citation Impact", "Citation Velocity", "Field Impact (FWCI)",
    "Reference Depth", "Collaboration Reach", "Recency", "Open Access",
    "Team Size", "Topic Breadth", "Recent Momentum",
  ]),
  journal: new Set([
    "Impact Factor", "h-index", "Citation Volume", "Geography Reach",
    "Educator Reach", "Discipline Fit", "Open Access",
    "i10 Index", "Productivity", "Topic Diversity",
  ]),
};

// last rendered payloads, so a feature toggle can redraw without re-fetching
let lastSingle = null;
let lastCompare = null;

// ---- feature tab (which axes show on each radar) ----
document.querySelectorAll(".feature-toggle input").forEach((cb) => {
  cb.addEventListener("change", () => {
    const set = enabledFeatures[cb.dataset.kind];
    if (cb.checked) set.add(cb.value);
    else set.delete(cb.value);
    redraw();
  });
});

// keep only the enabled axes of a radar payload, preserving label/value order
function filterRadar(radar, kind) {
  const enabled = enabledFeatures[kind];
  const labels = [];
  const values = [];
  const raw_display = [];
  radar.labels.forEach((lab, i) => {
    if (enabled.has(lab)) {
      labels.push(lab);
      values.push(radar.values[i]);
      if (radar.raw_display) raw_display.push(radar.raw_display[i]);
    }
  });
  return { ...radar, labels, values, raw_display };
}

// redraw whichever results view is currently visible, using the stored payload
function redraw() {
  if (lastSingle && !$("results").classList.contains("hidden")) render(lastSingle);
  if (lastCompare && !$("compareResults").classList.contains("hidden")) renderCompare(lastCompare);
}

const queryInput = $("query");
const searchBtn = $("searchBtn");

searchBtn.addEventListener("click", run);
queryInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") run();
});

// ---- mode tabs (single vs compare vs journal reach) ----
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const mode = tab.dataset.mode;
    const journalReach = mode === "journalReach";
    const compare = mode === "compare";

    // search rows + result views are only used by the paper-centric modes
    $("singleSearch").classList.toggle("hidden", compare || journalReach);
    $("compareSearch").classList.toggle("hidden", !compare);
    $("results").classList.add("hidden");
    $("compareResults").classList.add("hidden");
    $("authorPanel").classList.add("hidden");
    $("candidates").classList.add("hidden");

    // the journal-reach view spans the whole width — hide the feature sidebar
    $("featurePanel").classList.toggle("hidden", journalReach);
    $("journalReachView").classList.toggle("hidden", !journalReach);
    if (journalReach) initJournalReach();

    setStatus("");
  });
});

$("compareBtn").addEventListener("click", runCompare);
["queryA", "queryB"].forEach((id) =>
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") runCompare();
  })
);

async function runCompare() {
  const a = $("queryA").value.trim();
  const b = $("queryB").value.trim();
  if (!a || !b) {
    setStatus("Enter a paper on both sides.", true);
    return;
  }
  $("compareResults").classList.add("hidden");
  setStatus("Resolving both papers and building radars…");
  $("compareBtn").disabled = true;
  try {
    const qs = new URLSearchParams({ a, b }).toString();
    const res = await fetch(`/api/compare?${qs}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Compare failed");
    renderCompare(data);
    setStatus("");
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    $("compareBtn").disabled = false;
  }
}

function renderCompare(data) {
  lastCompare = data;
  const A = data.a, B = data.b;

  // legends
  $("cmpPaperLegend").innerHTML =
    `<span class="dot a"></span>${escapeHtml(shortTitle(A.paper))}` +
    `<br><span class="dot b"></span>${escapeHtml(shortTitle(B.paper))}`;
  $("cmpJournalLegend").innerHTML =
    `<span class="dot a"></span>${escapeHtml(jName(A.journal))}` +
    `<br><span class="dot b"></span>${escapeHtml(jName(B.journal))}`;

  // overlaid paper radar (shared axes) — filtered to the chosen features
  cmpPaperChart = drawOverlay(
    "cmpPaperChart", cmpPaperChart,
    filterRadar(A.paper.radar, "paper"), filterRadar(B.paper.radar, "paper"), "A", "B"
  );
  buildCompareTable("cmpPaperTable", A.paper.radar, B.paper.radar);

  // overlaid journal radar (only if both have a journal)
  if (A.journal.radar && B.journal.radar) {
    cmpJournalChart = drawOverlay(
      "cmpJournalChart", cmpJournalChart,
      filterRadar(A.journal.radar, "journal"), filterRadar(B.journal.radar, "journal"), "A", "B"
    );
    buildCompareTable("cmpJournalTable", A.journal.radar, B.journal.radar);
  } else {
    if (cmpJournalChart) { cmpJournalChart.destroy(); cmpJournalChart = null; }
    $("cmpJournalTable").innerHTML =
      "<tr><td>One or both works have no indexed journal source.</td></tr>";
  }

  $("compareResults").classList.remove("hidden");
}

function shortTitle(p) {
  const t = p.title || "Untitled";
  return `${t.length > 48 ? t.slice(0, 48) + "…" : t} (${p.year || "—"})`;
}
function jName(j) {
  return (j.meta && j.meta.name) || "No journal";
}

// two datasets on one radar, using the score axes from each payload
function drawOverlay(canvasId, existing, radarA, radarB, labelA, labelB) {
  if (existing) existing.destroy();
  const ctx = $(canvasId).getContext("2d");
  return new Chart(ctx, {
    type: "radar",
    data: {
      labels: radarA.labels,
      datasets: [
        dataset(labelA, radarA.values, COLOR_A, radarA.raw_display),
        dataset(labelB, radarB.values, COLOR_B, radarB.raw_display),
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: "#cfd6ff" } },
        tooltip: { callbacks: { label: pctTooltip } },
      },
      scales: { r: radarScale() },
    },
  });
}

function dataset(label, values, color, rawDisplay) {
  return {
    label,
    data: values,
    rawDisplay: rawDisplay || [],
    fill: true,
    backgroundColor: hexToRgba(color, 0.14),
    borderColor: color,
    pointBackgroundColor: color,
    borderWidth: 2,
  };
}

// Tooltip line: "<series>: 85% (3,012 citations)" — pairs the percentage shown
// on the axis with the underlying raw value so the two always reconcile.
function pctTooltip(ctx) {
  const raw = ctx.dataset.rawDisplay && ctx.dataset.rawDisplay[ctx.dataIndex];
  const base = `${ctx.dataset.label}: ${ctx.formattedValue}%`;
  return raw ? `${base} (${raw})` : base;
}

// side-by-side numeric comparison of every axis
function buildCompareTable(tableId, radarA, radarB) {
  const head =
    `<tr><th>Axis</th><th><span class="dot a"></span>A</th>` +
    `<th><span class="dot b"></span>B</th></tr>`;
  const rows = radarA.labels
    .map((lab, i) => {
      const va = radarA.values[i], vb = radarB.values[i];
      const hi = "font-weight:700;color:" + (va >= vb ? COLOR_A : COLOR_B);
      return `<tr><td>${escapeHtml(lab)}</td>` +
        `<td style="${va >= vb ? hi : ""}">${va}</td>` +
        `<td style="${vb > va ? hi : ""}">${vb}</td></tr>`;
    })
    .join("");
  $(tableId).innerHTML = head + rows;
}

function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

async function run() {
  const q = queryInput.value.trim();
  if (!q) return;
  $("candidates").classList.add("hidden");
  $("results").classList.add("hidden");
  $("authorPanel").classList.add("hidden");
  setStatus("Searching the scholarly graph…");
  searchBtn.disabled = true;

  try {
    // A DOI / OpenAlex id is unambiguous -> analyze straight away.
    // Free text -> show a few candidates so the user picks the right paper.
    if (looksLikeId(q)) {
      await analyze({ q });
    } else {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Search failed");
      if (!data.results.length) throw new Error("No papers matched that query.");
      if (data.results.length === 1) {
        await analyze({ id: data.results[0].id });
      } else {
        showCandidates(data.results);
        setStatus("Select the paper you meant:");
      }
    }
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    searchBtn.disabled = false;
  }
}

function looksLikeId(q) {
  const s = q.toLowerCase();
  return s.startsWith("10.") || s.includes("doi.org/") || /^w\d+$/.test(s);
}

function showCandidates(results) {
  const ul = $("candidates");
  ul.innerHTML = "";
  results.forEach((r) => {
    const li = document.createElement("li");
    const authors = (r.authors || []).filter(Boolean).join(", ");
    li.innerHTML = `
      <div class="c-title">${escapeHtml(r.title || "Untitled")}</div>
      <div class="c-sub">
        ${r.year || "—"} · ${r.citations ?? 0} citations
        ${r.journal ? "· " + escapeHtml(r.journal) : ""}
        ${authors ? "<br>" + escapeHtml(authors) : ""}
      </div>`;
    li.addEventListener("click", () => {
      ul.classList.add("hidden");
      analyze({ id: r.id });
    });
    ul.appendChild(li);
  });
  ul.classList.remove("hidden");
}

async function analyze(params) {
  setStatus("Building radar profiles…");
  $("candidates").classList.add("hidden");
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`/api/analyze?${qs}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Analysis failed");
  render(data);
  setStatus("");
}

function render(data) {
  lastSingle = data;
  const { paper, journal } = data;

  // ---- paper panel ----
  $("paperTitle").textContent = paper.title || "Untitled";
  const pAuthors = (paper.authors || []).filter(Boolean).slice(0, 4).join(", ");
  $("paperMeta").innerHTML =
    `${paper.year || "—"}${pAuthors ? " · " + escapeHtml(pAuthors) : ""}` +
    (paper.doi ? ` · <a href="${paper.doi}" target="_blank" rel="noopener">DOI</a>` : "");
  paperChart = drawRadar("paperChart", paperChart, filterRadar(paper.radar, "paper"), "#4f9dff");
  fillTable("paperTable", paper.radar.raw);

  // ---- journal panel ----
  if (journal.radar && journal.meta) {
    const m = journal.meta;
    $("journalTitle").textContent = m.name || "Unknown journal";
    $("journalMeta").innerHTML = [
      m.publisher && escapeHtml(m.publisher),
      m.country,
      m.issn && "ISSN " + m.issn,
      m.is_oa ? "Open Access" : null,
    ].filter(Boolean).join(" · ");
    journalChart = drawRadar("journalChart", journalChart, filterRadar(journal.radar, "journal"), "#ff7a59");
    fillTable("journalTable", journal.radar.raw);
  } else {
    $("journalTitle").textContent = "Journal data unavailable";
    $("journalMeta").textContent =
      "This work has no indexed journal source (e.g. a preprint or dataset).";
    if (journalChart) { journalChart.destroy(); journalChart = null; }
    $("journalTable").innerHTML = "";
  }

  renderAuthors(data.authors);

  $("results").classList.remove("hidden");
}

// ---- author panel: overlay the 1st author and corresponding author ----
function renderAuthors(authors) {
  const panel = $("authorPanel");
  const entries = [];
  const legend = [];

  if (authors && authors.first && authors.first.radar) {
    entries.push({ radar: authors.first.radar, color: COLOR_A, label: shortName(authors.first.name) });
    legend.push(`<span class="dot a"></span>${escapeHtml(authors.first.role)}: ${escapeHtml(authors.first.name || "—")}`);
  }
  if (authors && authors.corresponding && authors.corresponding.radar) {
    entries.push({ radar: authors.corresponding.radar, color: COLOR_B, label: shortName(authors.corresponding.name) });
    legend.push(`<span class="dot b"></span>${escapeHtml(authors.corresponding.role)}: ${escapeHtml(authors.corresponding.name || "—")}`);
  }

  if (!entries.length) {
    if (authorChart) { authorChart.destroy(); authorChart = null; }
    panel.classList.add("hidden");
    return;
  }

  $("authorLegend").innerHTML = legend.join("<br>");
  drawAuthors(entries);
  panel.classList.remove("hidden");
}

// one radar, one dataset per author (1 or 2), sharing the 5 author axes
function drawAuthors(entries) {
  if (authorChart) authorChart.destroy();
  const ctx = $("authorChart").getContext("2d");
  authorChart = new Chart(ctx, {
    type: "radar",
    data: {
      labels: entries[0].radar.labels,
      datasets: entries.map((e) => dataset(e.label, e.radar.values, e.color, e.radar.raw_display)),
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: "#cfd6ff" } },
        tooltip: { callbacks: { label: pctTooltip } },
      },
      scales: { r: radarScale() },
    },
  });
  return authorChart;
}

function shortName(name) {
  const n = name || "Unknown";
  return n.length > 22 ? n.slice(0, 22) + "…" : n;
}

function drawRadar(canvasId, existing, radar, color) {
  if (existing) existing.destroy();
  const ctx = $(canvasId).getContext("2d");
  return new Chart(ctx, {
    type: "radar",
    data: {
      labels: radar.labels,
      datasets: [
        {
          label: "% of max",
          data: radar.values,
          rawDisplay: radar.raw_display || [],
          fill: true,
          backgroundColor: hexToRgba(color, 0.18),
          borderColor: color,
          pointBackgroundColor: color,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: pctTooltip } },
      },
      scales: { r: radarScale() },
    },
  });
}

function radarScale() {
  return {
    min: 0,
    max: 100,
    ticks: {
      stepSize: 25,
      color: "#7e87b3",
      backdropColor: "transparent",
      callback: (v) => v + "%",
    },
    grid: { color: "#2c3257" },
    angleLines: { color: "#2c3257" },
    pointLabels: { color: "#cfd6ff", font: { size: 11 } },
  };
}

function fillTable(tableId, raw) {
  const rows = Object.entries(raw)
    .map(([k, v]) => {
      const label = k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      let val = v;
      if (Array.isArray(v)) val = v.join(", ") || "—";
      else if (typeof v === "boolean") val = v ? "Yes" : "No";
      else if (v === null || v === undefined) val = "—";
      return `<tr><td>${label}</td><td>${escapeHtml(String(val))}</td></tr>`;
    })
    .join("");
  $(tableId).innerHTML = rows;
}

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

/* =====================================================================
 * Journal reach comparison (third tab)
 * A static, curated comparison of candidate target journals across five
 * reach dimensions (scored 1–10). Pick a journal to see its profile.
 * ===================================================================== */
const jrDims = ["Open access", "Discipline fit", "Educator reach", "Geographic reach", "Academic citations"];
const jrJournals = [
  {
    name: "CAEE", full: "Computer Applications in Engineering Education",
    publisher: "Wiley", if: "2.2", access: "paid", quartile: "Q1",
    scores: [3, 9, 7, 9, 7], color: "#4f9dff",
    notes: [
      "Paywalled — limits casual readership",
      "Exact scope match: GUI tools, simulation, visualization",
      "Read by educators adopting software tools",
      "Global engineering education audience",
      "Q1 Scopus, SCIE indexed — strong citation potential",
    ],
  },
  {
    name: "JEE", full: "Journal of Engineering Education",
    publisher: "ASEE", if: "6.06", access: "paid", quartile: "Q1",
    scores: [3, 5, 6, 10, 10], color: "#7b6bff",
    notes: [
      "Paywalled — but many institutions subscribe",
      "Broader scope; needs strong pedagogy framing",
      "8,500+ subscribers across ~100 countries",
      "Widest international reach of all options",
      "Highest IF (6.06) — maximum citation impact",
    ],
  },
  {
    name: "EJEE", full: "European Journal of Engineering Education",
    publisher: "SEFI / Taylor & Francis", if: "2.8", access: "paid", quartile: "Q1",
    scores: [3, 6, 7, 8, 8], color: "#1d9e75",
    notes: [
      "Paywalled but widely institutional access in Europe",
      "Good fit for pedagogy + tool effectiveness evidence",
      "Strong readership among European engineering faculty",
      "International but Europe-centric audience",
      "IF 2.8, CiteScore 8.1 — rising fast",
    ],
  },
  {
    name: "iJEP", full: "International Journal of Engineering Pedagogy",
    publisher: "Online Journals", if: "1.7", access: "open", quartile: "Q3",
    scores: [10, 8, 8, 7, 4], color: "#d85a30",
    notes: [
      "Fully open access — anyone can read for free",
      "Name directly matches: engineering pedagogy",
      "Free access means higher downloads from educators",
      "International readership, growing community",
      "Lower IF (1.7) — fewer academic citations",
    ],
  },
  {
    name: "JCEE", full: "Journal of Civil Engineering Education",
    publisher: "ASCE", if: "1.8", access: "paid", quartile: "Q2",
    scores: [3, 10, 9, 6, 5], color: "#ba7517",
    notes: [
      "Paywalled — ASCE membership helps access",
      "Perfect discipline fit: beams, SFD, BMD, Mohr's circle",
      "Read by the exact educators who teach these topics",
      "Primarily US/international civil engineering community",
      "Smaller journal (28 papers/yr) — niche but targeted",
    ],
  },
  {
    name: "IEEE Trans.", full: "IEEE Transactions on Education",
    publisher: "IEEE", if: "2.1", access: "paid", quartile: "Q2",
    scores: [3, 5, 6, 8, 7], color: "#ff7a59",
    notes: [
      "Paywalled — IEEE membership widely held",
      "Better fit if paper is software/code-heavy",
      "Reaches electrical, CS, and technical educators",
      "Strong global IEEE membership base",
      "Respected indexing — good citation profile",
    ],
  },
  {
    name: "IJEE", full: "International Journal of Engineering Education",
    publisher: "Tempus Publications", if: "1.0", access: "paid", quartile: "Q3",
    scores: [3, 7, 6, 9, 5], color: "#e0b34a",
    notes: [
      "Paywalled — moderate institutional access",
      "Broad engineering-education scope, accepts tool papers",
      "Established readership among engineering faculty",
      "Long-running journal with wide international spread",
      "Lower IF but extensive back-catalogue and indexing",
    ],
  },
  {
    name: "SEE", full: "Studies in Engineering Education",
    publisher: "VT Publishing", if: "n/a", access: "open", quartile: "—",
    scores: [10, 6, 7, 7, 3], color: "#3fc8c0",
    notes: [
      "Diamond open access — no fees to read or publish",
      "Focus on engineering-education research methods",
      "Read by the engineering-education research community",
      "Growing international author and reader base",
      "Young journal — citation track record still building",
    ],
  },
  {
    name: "AJEE", full: "Australasian Journal of Engineering Education",
    publisher: "Taylor & Francis", if: "1.5", access: "paid", quartile: "Q3",
    scores: [3, 7, 6, 5, 4], color: "#c77dff",
    notes: [
      "Paywalled — strongest access within Australasia",
      "Welcomes teaching-practice and tool-adoption papers",
      "Read by educators across Australia and New Zealand",
      "Regionally focused but internationally indexed",
      "Modest IF — solid for a regional society journal",
    ],
  },
  {
    name: "CEE", full: "Chemical Engineering Education",
    publisher: "ASEE ChE Division", if: "n/a", access: "open", quartile: "—",
    scores: [9, 8, 8, 6, 4], color: "#ff9bb3",
    notes: [
      "Open access — freely downloadable issues",
      "Tightly scoped to chemical-engineering teaching",
      "Read by ChE educators who adopt classroom tools",
      "Primarily US/international ChE community",
      "Niche but loyal readership; limited IF data",
    ],
  },
];

let jrActive = 0;
let jrChart = null;
let jrInitialised = false;

function initJournalReach() {
  if (jrInitialised) return;
  jrInitialised = true;
  jrRenderTabs();
  jrRenderDetail();
  jrUpdateChart();
}

function jrRenderTabs() {
  const container = $("journal-tabs");
  container.innerHTML = "";
  jrJournals.forEach((j, i) => {
    const btn = document.createElement("button");
    btn.className = "jr-tab" + (i === jrActive ? " active" : "");
    btn.textContent = j.name;
    if (i === jrActive) btn.style.borderColor = j.color;
    btn.onclick = () => {
      jrActive = i;
      jrRenderTabs();
      jrRenderDetail();
      jrUpdateChart();
    };
    container.appendChild(btn);
  });
}

function jrRenderDetail() {
  const j = jrJournals[jrActive];
  $("detail-panel").innerHTML =
    `<div class="jr-detail-head">
      <div>
        <p class="jr-name">${escapeHtml(j.full)}</p>
        <p class="jr-pub">${escapeHtml(j.publisher)} · IF ${escapeHtml(j.if)} · ${escapeHtml(j.quartile)} Scopus</p>
      </div>
      <span class="jr-access ${j.access === "open" ? "open" : "paid"}">${j.access === "open" ? "Open access" : "Paywalled"}</span>
    </div>
    <div>` +
    jrDims.map((d, i) =>
      `<div class="jr-dim-row">
        <span class="jr-dim-label">${d}</span>
        <div class="jr-bar-track"><div class="jr-bar-fill" style="width:${j.scores[i] * 10}%;background:${j.color};"></div></div>
        <span class="jr-dim-val">${j.scores[i]}/10</span>
      </div>
      <p class="jr-note">${escapeHtml(j.notes[i])}</p>`
    ).join("") +
    `</div>`;
}

function jrUpdateChart() {
  const j = jrJournals[jrActive];
  if (jrChart) {
    const ds = jrChart.data.datasets[0];
    ds.data = j.scores;
    ds.label = j.name;
    ds.borderColor = j.color;
    ds.backgroundColor = hexToRgba(j.color, 0.14);
    ds.pointBackgroundColor = j.color;
    jrChart.update();
    return;
  }
  jrChart = new Chart($("radarChart").getContext("2d"), {
    type: "radar",
    data: {
      labels: jrDims,
      datasets: [{
        label: j.name,
        data: j.scores,
        fill: true,
        borderColor: j.color,
        backgroundColor: hexToRgba(j.color, 0.14),
        pointBackgroundColor: j.color,
        pointRadius: 3,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        r: {
          min: 0, max: 10,
          ticks: { stepSize: 2, color: "#7e87b3", backdropColor: "transparent" },
          grid: { color: "#2c3257" },
          angleLines: { color: "#2c3257" },
          pointLabels: { color: "#cfd6ff", font: { size: 11 } },
        },
      },
    },
  });
}
