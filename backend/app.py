"""
app.py
------
Flask web server for Research Radar.

Endpoints
  GET  /                -> serves the single-page frontend
  GET  /api/search?q=   -> list of candidate papers (for the picker)
  GET  /api/analyze     -> full payload: paper radar + journal radar
                           params: q=<text|doi|id>  OR  id=<openalex work id>

Run:  python app.py   (then open http://localhost:5000)
"""

from __future__ import annotations

import os

from flask import Flask, jsonify, request, send_from_directory

import metrics
import openalex

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")

app = Flask(__name__, static_folder=None)


# --------------------------------------------------------------------------
# static frontend
# --------------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(FRONTEND_DIR, filename)


# --------------------------------------------------------------------------
# api
# --------------------------------------------------------------------------
@app.route("/api/search")
def api_search():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"error": "Provide ?q=<search text>"}), 400
    try:
        return jsonify({"results": openalex.search_works(q)})
    except Exception as exc:  # noqa: BLE001 - surface upstream failures to UI
        return jsonify({"error": f"Search failed: {exc}"}), 502


def _build_payload(work: dict) -> dict:
    """Turn a resolved OpenAlex work into the paper+journal radar payload.

    Shared by /api/analyze (single) and /api/compare (two papers).
    """
    paper_payload = metrics.paper_radar(work)
    paper_concepts = {c.get("id") for c in (work.get("concepts") or []) if c.get("id")}

    source_stub = (work.get("primary_location") or {}).get("source") or {}
    source_id = source_stub.get("id")
    journal_payload = None
    journal_meta = None

    if source_id:
        try:
            source = openalex.get_source(source_id)
            sample = openalex.sample_journal(source_id)
        except Exception:  # noqa: BLE001 - journal data is best-effort
            source, sample = None, None
        if source:
            journal_payload = metrics.journal_radar(source, sample or {}, paper_concepts)
            journal_meta = {
                "name": source.get("display_name"),
                "publisher": source.get("host_organization_name"),
                "country": source.get("country_code"),
                "issn": (source.get("issn") or [None])[0],
                "homepage": source.get("homepage_url"),
                "is_oa": source.get("is_oa"),
                "sampled_articles": (sample or {}).get("sampled"),
            }

    authors = [
        a.get("author", {}).get("display_name")
        for a in (work.get("authorships") or [])
    ]

    return {
        "paper": {
            "title": work.get("display_name"),
            "year": work.get("publication_year"),
            "doi": work.get("doi"),
            "openalex_id": work.get("id", "").split("/")[-1],
            "authors": authors,
            "radar": paper_payload,
        },
        "journal": {"meta": journal_meta, "radar": journal_payload},
    }


@app.route("/api/analyze")
def api_analyze():
    work_id = request.args.get("id", "").strip()
    q = request.args.get("q", "").strip()

    try:
        work = openalex.get_work(work_id) if work_id else openalex.find_work(q)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Lookup failed: {exc}"}), 502

    if not work:
        return jsonify({"error": "No matching paper found."}), 404

    return jsonify(_build_payload(work))


@app.route("/api/compare")
def api_compare():
    """Resolve two queries and return both payloads for side-by-side overlay.

    Accepts a/b as free text, DOI, or OpenAlex id (aid/bid for explicit ids).
    Each side is resolved to its single best match.
    """
    sides = {}
    for key in ("a", "b"):
        wid = request.args.get(f"{key}id", "").strip()
        q = request.args.get(key, "").strip()
        if not wid and not q:
            return jsonify({"error": f"Missing query for side '{key}'."}), 400
        try:
            work = openalex.get_work(wid) if wid else openalex.find_work(q)
        except Exception as exc:  # noqa: BLE001
            return jsonify({"error": f"Lookup failed for '{key}': {exc}"}), 502
        if not work:
            return jsonify({"error": f"No paper matched side '{key}': {q or wid}"}), 404
        sides[key] = _build_payload(work)

    return jsonify(sides)


if __name__ == "__main__":
    # Note: default is 5057, NOT 5000 — on macOS port 5000 is taken by the
    # AirPlay Receiver, which silently answers with "Not Found".
    port = int(os.environ.get("PORT", 5057))
    app.run(host="0.0.0.0", port=port, debug=True)
