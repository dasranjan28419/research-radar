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

// ---- mode tabs (single vs compare) ----
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const compare = tab.dataset.mode === "compare";
    $("singleSearch").classList.toggle("hidden", compare);
    $("compareSearch").classList.toggle("hidden", !compare);
    $("results").classList.add("hidden");
    $("compareResults").classList.add("hidden");
    $("authorPanel").classList.add("hidden");
    $("candidates").classList.add("hidden");
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
