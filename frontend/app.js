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
    const single = mode === "single";
    const compare = mode === "compare";
    const journalReach = mode === "journalReach";
    const network = mode === "network";

    // search rows + result views are only used by the paper-centric modes
    $("singleSearch").classList.toggle("hidden", !single);
    $("compareSearch").classList.toggle("hidden", !compare);
    $("results").classList.add("hidden");
    $("compareResults").classList.add("hidden");
    $("authorPanel").classList.add("hidden");
    hideCandidates();

    // journal-reach and network views span the whole width — hide the sidebar
    $("featurePanel").classList.toggle("hidden", journalReach || network);
    $("journalReachView").classList.toggle("hidden", !journalReach);
    $("networkView").classList.toggle("hidden", !network);
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
  hideCandidates();
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

// candidate picker state: the fetched matches and the chosen view (default
// "latest" — newest first; other views filter by category or sort by citations)
let candidateResults = [];
let candidateView = "latest";
const CAT_NAMES = { review: "Review", conference: "Conference", journal: "Journal", other: "Other" };

function hideCandidates() {
  $("candidates").classList.add("hidden");
  $("candidateControls").classList.add("hidden");
}

function showCandidates(results) {
  candidateResults = results;
  candidateView = "latest";
  renderCandidateControls();
  renderCandidateList();
  $("candidateControls").classList.remove("hidden");
  $("candidates").classList.remove("hidden");
}

function renderCandidateControls() {
  const bar = $("candidateControls");
  const nRev = candidateResults.filter((r) => r.category === "review").length;
  const nConf = candidateResults.filter((r) => r.category === "conference").length;
  const views = [
    { key: "latest", label: "Latest first", enabled: true },
    { key: "cited", label: "Most cited", enabled: true },
    { key: "reviews", label: `Reviews (${nRev})`, enabled: nRev > 0 },
    { key: "conference", label: `Conference (${nConf})`, enabled: nConf > 0 },
  ];
  bar.innerHTML = "";
  views.forEach((v) => {
    const btn = document.createElement("button");
    btn.className = "cand-chip" + (candidateView === v.key ? " active" : "");
    btn.textContent = v.label;
    btn.disabled = !v.enabled;
    btn.onclick = () => { candidateView = v.key; renderCandidateControls(); renderCandidateList(); };
    bar.appendChild(btn);
  });
}

function renderCandidateList() {
  const ul = $("candidates");
  ul.innerHTML = "";
  let list = candidateResults.slice();
  if (candidateView === "reviews") list = list.filter((r) => r.category === "review");
  else if (candidateView === "conference") list = list.filter((r) => r.category === "conference");
  if (candidateView === "cited") list.sort((a, b) => (b.citations || 0) - (a.citations || 0));
  else list.sort((a, b) => (b.year || 0) - (a.year || 0)); // latest first

  if (!list.length) {
    const li = document.createElement("li");
    li.className = "c-empty";
    li.textContent = "No papers in this category among the matches.";
    ul.appendChild(li);
    return;
  }

  list.forEach((r) => {
    const li = document.createElement("li");
    const authors = (r.authors || []).filter(Boolean).join(", ");
    const cat = CAT_NAMES[r.category] || "Other";
    li.innerHTML = `
      <div class="c-title">${escapeHtml(r.title || "Untitled")}</div>
      <div class="c-sub">
        ${r.year || "—"} · ${r.citations ?? 0} citations
        · <span class="c-cat ${r.category}">${cat}</span>
        ${r.journal ? "· " + escapeHtml(r.journal) : ""}
        ${authors ? "<br>" + escapeHtml(authors) : ""}
      </div>`;
    li.addEventListener("click", () => { hideCandidates(); analyze({ id: r.id }); });
    ul.appendChild(li);
  });
}

async function analyze(params) {
  setStatus("Building radar profiles…");
  hideCandidates();
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

/* =====================================================================
 * Citation network (fourth tab)
 * Fetches /api/network for a searched paper and draws a force-directed
 * "spider web": the seed paper sits at the centre, spokes out to its
 * references / citing papers / related work (highlighted), with fainter
 * strands between neighbours that cite or share references.
 * ===================================================================== */
const NET_COLORS = {
  seed: "#7b6bff",
  reference: "#4f9dff",
  citing: "#ff7a59",
  related: "#1d9e75",
};
let networkSim = null;

const networkBtn = $("networkBtn");
const networkQuery = $("networkQuery");
networkBtn.addEventListener("click", runNetwork);
networkQuery.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runNetwork();
});

function setNetStatus(msg, isError = false) {
  const el = $("networkStatus");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

async function runNetwork() {
  const q = networkQuery.value.trim();
  if (!q) return;
  setNetStatus("Weaving the citation web…");
  networkBtn.disabled = true;
  try {
    const res = await fetch(`/api/network?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Network build failed");
    renderNetwork(data);
    const n = data.nodes.length - 1;
    setNetStatus(n
      ? `${escapeHtml(data.title || "Paper")} — ${n} connected papers, ${data.links.length} links`
      : "No connected papers found for that work.");
  } catch (err) {
    setNetStatus(err.message, true);
  } finally {
    networkBtn.disabled = false;
  }
}

// adjacency map (string id -> Set of string ids) for hover highlighting
function netAdjacency(links) {
  const adj = {};
  links.forEach((l) => {
    const s = l.source.id || l.source;
    const t = l.target.id || l.target;
    (adj[s] = adj[s] || new Set()).add(t);
    (adj[t] = adj[t] || new Set()).add(s);
  });
  return adj;
}

function netLabel(d) {
  const surname = d.author ? d.author.split(" ").slice(-1)[0] : "";
  const base = [surname, d.year].filter(Boolean).join(" ");
  return d.seed ? "★ " + (base || "This paper") : base;
}

function netTip(d) {
  return `<strong>${escapeHtml(d.title)}</strong><br>` +
    `${escapeHtml(d.author || "—")} · ${d.year || "—"} · ${d.citations} citations` +
    `<br><span class="net-rel">${d.relation === "seed" ? "searched paper" : d.relation}</span>`;
}

// Citation web as a pie. The searched paper sits pinned at the centre; the
// surrounding disc is sliced into wedges by publication type, and each wedge's
// angle is proportional to that category's share of the connected papers (the
// share is shown in the wedge label). Every paper is held inside its category's
// wedge. Circle size ∝ citations, colour ∝ relation to the searched paper, and
// hovering any paper lights up its connections in place.
const NET_CAT_ORDER = ["review", "conference", "journal", "other"];
const NET_CAT_LABEL = {
  review: "Review papers",
  conference: "Conference papers",
  journal: "Journal · peer-reviewed",
  other: "Others",
};
// distinct wedge hues (Tailwind-400 family) so each sector reads clearly; used
// translucent for the fill, stronger for the edge + label
const NET_CAT_COLOR = {
  review: "#a78bfa",     // violet
  conference: "#fbbf24", // amber
  journal: "#34d399",    // emerald
  other: "#f472b6",      // pink
};

function renderNetwork(data) {
  const svgEl = $("networkSvg");
  const wrap = svgEl.parentElement;
  const width = wrap.clientWidth || 900;
  const height = wrap.clientHeight || 620;
  const cx = width / 2, cy = height / 2;
  const innerR = 64; // clear ring around the centred parent paper
  const outerR = Math.min(width, height) / 2 - 30;

  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();
  if (networkSim) { networkSim.stop(); networkSim = null; }
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const nodes = data.nodes.map((n) => ({ ...n }));
  const links = data.links.map((l) => ({ ...l }));
  const adj = netAdjacency(links);

  // circle radius ∝ citations (sqrt tames the spread); the seed gets a floor
  const maxCit = d3.max(nodes, (n) => n.citations) || 1;
  const rScale = d3.scaleSqrt().domain([0, maxCit]).range([5, 24]);
  const radiusOf = (d) => (d.seed ? Math.max(rScale(d.citations), 15) : rScale(d.citations));

  // wedge per category, angle ∝ its share of the connected (non-seed) papers
  const neighbours = nodes.filter((n) => !n.seed);
  const total = neighbours.length || 1;
  const counts = {};
  neighbours.forEach((n) => { counts[n.category] = (counts[n.category] || 0) + 1; });
  const BASE = -Math.PI / 2; // first wedge starts at 12 o'clock
  const sectors = {};
  let acc = BASE;
  NET_CAT_ORDER.forEach((cat) => {
    const cnt = counts[cat] || 0;
    if (!cnt) return;
    const span = (cnt / total) * 2 * Math.PI;
    sectors[cat] = {
      cat, start: acc, end: acc + span, mid: acc + span / 2,
      count: cnt, pct: Math.round((cnt / total) * 100),
      pad: Math.min(0.07, span * 0.18),
    };
    acc += span;
  });

  const gSector = svg.append("g");
  const gLink = svg.append("g");
  const gNode = svg.append("g");
  const tip = $("networkTip");

  const polar = (a, r) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  // normalise an angle into the [BASE, BASE+2π) band the wedges live in
  const normAngle = (a) => { while (a < BASE) a += 2 * Math.PI; while (a >= BASE + 2 * Math.PI) a -= 2 * Math.PI; return a; };

  // wedge fills + boundary spokes + "Name · NN%" labels
  const sectorList = Object.values(sectors);
  const catColor = (s) => NET_CAT_COLOR[s.cat] || "#8aa6ff";
  gSector.selectAll("path.net-wedge").data(sectorList).join("path")
    .attr("class", "net-wedge")
    .attr("fill", (s) => hexToRgba(catColor(s), 0.2))
    .attr("stroke", (s) => hexToRgba(catColor(s), 0.6))
    .attr("d", (s) => {
      const [x0, y0] = polar(s.start, outerR);
      const [x1, y1] = polar(s.end, outerR);
      const large = s.end - s.start > Math.PI ? 1 : 0;
      return `M${cx},${cy} L${x0},${y0} A${outerR},${outerR} 0 ${large} 1 ${x1},${y1} Z`;
    });
  gSector.selectAll("text.net-quad-label").data(sectorList).join("text")
    .attr("class", "net-quad-label")
    .style("fill", (s) => catColor(s))
    .attr("x", (s) => polar(s.mid, outerR + 16)[0])
    .attr("y", (s) => polar(s.mid, outerR + 16)[1])
    .attr("text-anchor", (s) => {
      const c = Math.cos(s.mid);
      return Math.abs(c) < 0.3 ? "middle" : c > 0 ? "start" : "end";
    })
    .attr("dominant-baseline", "middle")
    .text((s) => `${NET_CAT_LABEL[s.cat]} · ${s.pct}%`);

  // hold a node inside its wedge: clamp its polar angle + radius
  function clampToSector(d, x, y) {
    const s = sectors[d.category];
    if (!s) return { x, y };
    const dx = x - cx, dy = y - cy;
    let r = Math.hypot(dx, dy) || 0.001;
    let a = normAngle(Math.atan2(dy, dx));
    const nr = radiusOf(d);
    r = Math.max(innerR + nr, Math.min(outerR - nr, r));
    a = Math.max(s.start + s.pad, Math.min(s.end - s.pad, a));
    const [nx, ny] = polar(a, r);
    return { x: nx, y: ny };
  }

  // seed pinned dead centre; others scattered inside their wedge
  nodes.forEach((n) => {
    if (n.seed) { n.x = n.fx = cx; n.y = n.fy = cy; return; }
    const s = sectors[n.category];
    const a = s ? s.start + s.pad + Math.random() * (s.end - s.start - 2 * s.pad) : Math.random() * 2 * Math.PI;
    const r = innerR + 20 + Math.random() * (outerR - innerR - 40);
    [n.x, n.y] = polar(a, r);
  });

  const link = gLink.selectAll("line").data(links).join("line").attr("class", "net-thread");

  const node = gNode.selectAll("g").data(nodes).join("g")
    .attr("class", (d) => "net-node" + (d.seed ? " net-node-seed" : ""))
    .style("cursor", "pointer")
    .call(d3.drag().on("start", dragStart).on("drag", dragged).on("end", dragEnd));

  node.append("circle")
    .attr("r", radiusOf)
    .attr("fill", (d) => NET_COLORS[d.relation] || "#888")
    .attr("stroke", (d) => (d.seed ? "#ffffff" : "rgba(255,255,255,0.3)"))
    .attr("stroke-width", (d) => (d.seed ? 2.5 : 1));

  node.append("text")
    .attr("class", "net-label")
    .attr("text-anchor", "middle")
    .attr("dy", (d) => radiusOf(d) + 11)
    .text(netLabel);

  node
    .on("mouseenter", (e, d) => { tip.classList.remove("hidden"); tip.innerHTML = netTip(d); setFocus(d.id); })
    .on("mousemove", (e) => moveTip(e))
    .on("click", (e, d) => { if (d.doi) window.open(d.doi, "_blank", "noopener"); });

  // leaving the canvas returns the focus to the searched paper
  d3.select(wrap).on("mouseleave", () => { tip.classList.add("hidden"); setFocus(data.seed); });

  function incident(l, id) {
    const s = l.source.id || l.source, t = l.target.id || l.target;
    return s === id || t === id;
  }

  // shift the focus to `id` without moving anything: light up its spokes and
  // fade everything not connected to it
  function setFocus(id) {
    const near = adj[id] || new Set();
    link
      .style("stroke", (l) => (incident(l, id) ? "#8aa6ff" : "rgba(138,166,255,0.16)"))
      .style("stroke-opacity", (l) => (incident(l, id) ? 0.95 : 0.5))
      .style("stroke-width", (l) => (incident(l, id) ? 1.7 : 0.7));
    link.filter((l) => incident(l, id)).raise();
    node.classed("net-center", (n) => n.id === id)
      .style("opacity", (n) => (n.id === id || near.has(n.id) ? 1 : 0.4));
  }

  function moveTip(e) {
    const r = wrap.getBoundingClientRect();
    tip.style.left = (e.clientX - r.left + 14) + "px";
    tip.style.top = (e.clientY - r.top + 14) + "px";
  }

  networkSim = d3.forceSimulation(nodes)
    // link force at strength 0: resolves source/target to node refs for drawing
    // but exerts no pull — category, not connection, drives placement
    .force("link", d3.forceLink(links).id((d) => d.id).strength(0))
    .force("charge", d3.forceManyBody().strength((d) => (d.seed ? 0 : -55)))
    .force("collide", d3.forceCollide().radius((d) => radiusOf(d) + 3))
    .force("radial", d3.forceRadial((d) => (d.seed ? 0 : (innerR + outerR) / 2), cx, cy)
      .strength((d) => (d.seed ? 0 : 0.04)))
    .on("tick", () => {
      nodes.forEach((n) => {
        if (n.seed) { n.x = cx; n.y = cy; return; }
        const p = clampToSector(n, n.x, n.y);
        n.x = p.x; n.y = p.y;
      });
      link
        .attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x).attr("y2", (d) => d.target.y);
      node.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });

  setFocus(data.seed);

  function dragStart(e, d) { if (d.seed) return; if (!e.active) networkSim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; }
  function dragged(e, d) { if (d.seed) return; const p = clampToSector(d, e.x, e.y); d.fx = p.x; d.fy = p.y; }
  function dragEnd(e, d) { if (d.seed) return; if (!e.active) networkSim.alphaTarget(0); d.fx = null; d.fy = null; }
}
