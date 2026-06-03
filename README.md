# 📡 Research Radar

A web platform that takes a research **field, identifier, title, or author**,
finds the matching paper across the scholarly literature, and renders **two
side-by-side radar (spider) plots**:

- **Paper radar** — how the individual paper performs.
- **Journal radar** — how the journal it was published in performs.

![side by side radar plots](docs/preview.png)

---

## Where the data comes from

Rather than scraping individual journal websites (fragile, slow, and quick to
get IP-blocked), Research Radar queries **[OpenAlex](https://openalex.org)** —
a free, open index of ~250M scholarly works and every journal. One API gives
us citation counts, field-weighted impact, journal metrics, author
institutions/countries, and subject concepts.

> Easy to extend: `backend/openalex.py` is isolated, so you can add **Crossref**
> or **Semantic Scholar** as a second source with minimal changes.

> **Note on Impact Factor:** the proprietary Clarivate Journal Impact Factor
> (JIF) isn't openly licensed. We show OpenAlex's **2-year mean citedness**,
> which is computed the same way (citations in year *N* to items from *N-1*
> and *N-2*) and is the standard open analogue.

---

## The radar features (and why each was chosen)

### Paper
| Axis | What it measures | Why it matters |
|------|------------------|----------------|
| **Citation Impact** | Total citations (log-scaled) | Raw scholarly attention |
| **Citation Velocity** | Citations per year | Rewards fast uptake, not just age |
| **Field Impact (FWCI)** | Field-weighted citation impact | Fair cross-discipline comparison; 1.0 = world average |
| **Reference Depth** | Number of references | How well-grounded in prior work |
| **Collaboration Reach** | Distinct author countries | Team breadth / international reach |
| **Recency** | How current the work is | Freshness of contribution |
| **Open Access** | Freely readable? | Reach & equity |

### Journal
| Axis | What it measures | Why it matters |
|------|------------------|----------------|
| **Impact Factor** | 2-yr mean citedness | Headline journal influence |
| **h-index** | Journal h-index | Long-run prestige / consistency |
| **Citation Volume** | Total citations (log-scaled) | Overall scholarly footprint |
| **Geography Reach** | Distinct author countries (sampled) | Global vs regional reach |
| **Educator Reach** | Distinct contributing institutions (sampled) | Academic/teaching-institution spread |
| **Discipline Fit** | Concept overlap of paper ↔ journal | Is the paper a topical match for this venue? |
| **Open Access** | Share of OA articles (sampled) | Accessibility of the venue |

> **Other features you could add** (the scoring layer in `backend/metrics.py`
> is pure functions, so adding an axis is a few lines): SJR / SNIP, CiteScore,
> retraction rate, time-to-publication, gender/geographic diversity index,
> altmetric/social attention, self-citation ratio, peer-review transparency.

All axes are normalized to **0–100** (log curves for heavy-tailed counts,
capped linear maps for ratios) so the radar polygon is meaningful.

---

## Run it

```bash
cd research-radar/backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open <http://localhost:5057> and try:

> **macOS:** don't use port 5000 — it's grabbed by the AirPlay Receiver and
> returns "Not Found". This app defaults to **5057**. (Disable it under
> System Settings → General → AirDrop & Handoff → AirPlay Receiver if you
> ever need 5000.)


- `Attention is all you need`
- `10.1038/nature14539`
- `CRISPR gene editing`
- an author name

---

## Project layout

```
research-radar/
├── backend/
│   ├── app.py            # Flask server + JSON API
│   ├── openalex.py       # OpenAlex client (search, work, source, sampling)
│   ├── metrics.py        # pure scoring functions -> 0-100 radar axes
│   └── requirements.txt
├── frontend/
│   ├── index.html        # single-page UI
│   ├── style.css
│   └── app.js            # fetch + Chart.js radar rendering
└── README.md
```

## API

| Endpoint | Params | Returns |
|----------|--------|---------|
| `GET /api/search` | `q` = text | candidate papers for the picker |
| `GET /api/analyze` | `q` = text/DOI/id **or** `id` = OpenAlex work id | paper + journal radar payloads |
