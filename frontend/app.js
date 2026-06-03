/* Research Radar - frontend logic
 * Talks to the Flask API, then draws two radar charts side by side.
 */

const $ = (id) => document.getElementById(id);
let paperChart = null;
let journalChart = null;
let cmpPaperChart = null;
let cmpJournalChart = null;

const COLOR_A = "#4f9dff"; // paper / side A
const COLOR_B = "#ff7a59"; // journal / side B

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
  const A = data.a, B = data.b;

  // legends
  $("cmpPaperLegend").innerHTML =
    `<span class="dot a"></span>${escapeHtml(shortTitle(A.paper))}` +
    `<br><span class="dot b"></span>${escapeHtml(shortTitle(B.paper))}`;
  $("cmpJournalLegend").innerHTML =
    `<span class="dot a"></span>${escapeHtml(jName(A.journal))}` +
    `<br><span class="dot b"></span>${escapeHtml(jName(B.journal))}`;

  // overlaid paper radar (shared axes)
  cmpPaperChart = drawOverlay(
    "cmpPaperChart", cmpPaperChart,
    A.paper.radar, B.paper.radar, "A", "B"
  );
  buildCompareTable("cmpPaperTable", A.paper.radar, B.paper.radar);

  // overlaid journal radar (only if both have a journal)
  if (A.journal.radar && B.journal.radar) {
    cmpJournalChart = drawOverlay(
      "cmpJournalChart", cmpJournalChart,
      A.journal.radar, B.journal.radar, "A", "B"
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
        dataset(labelA, radarA.values, COLOR_A),
        dataset(labelB, radarB.values, COLOR_B),
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#cfd6ff" } } },
      scales: { r: radarScale() },
    },
  });
}

function dataset(label, values, color) {
  return {
    label,
    data: values,
    fill: true,
    backgroundColor: hexToRgba(color, 0.14),
    borderColor: color,
    pointBackgroundColor: color,
    borderWidth: 2,
  };
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
  const { paper, journal } = data;

  // ---- paper panel ----
  $("paperTitle").textContent = paper.title || "Untitled";
  const pAuthors = (paper.authors || []).filter(Boolean).slice(0, 4).join(", ");
  $("paperMeta").innerHTML =
    `${paper.year || "—"}${pAuthors ? " · " + escapeHtml(pAuthors) : ""}` +
    (paper.doi ? ` · <a href="${paper.doi}" target="_blank" rel="noopener">DOI</a>` : "");
  paperChart = drawRadar("paperChart", paperChart, paper.radar, "#4f9dff");
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
    journalChart = drawRadar("journalChart", journalChart, journal.radar, "#ff7a59");
    fillTable("journalTable", journal.radar.raw);
  } else {
    $("journalTitle").textContent = "Journal data unavailable";
    $("journalMeta").textContent =
      "This work has no indexed journal source (e.g. a preprint or dataset).";
    if (journalChart) { journalChart.destroy(); journalChart = null; }
    $("journalTable").innerHTML = "";
  }

  $("results").classList.remove("hidden");
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
          label: "Score (0-100)",
          data: radar.values,
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
      plugins: { legend: { display: false } },
      scales: { r: radarScale() },
    },
  });
}

function radarScale() {
  return {
    min: 0,
    max: 100,
    ticks: { stepSize: 25, color: "#7e87b3", backdropColor: "transparent" },
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
