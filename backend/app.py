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

    authorships = work.get("authorships") or []
    authors = [a.get("author", {}).get("display_name") for a in authorships]

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
        "authors": _author_payload(authorships),
    }


def _author_payload(authorships: list[dict]) -> dict:
    """Profile the first author and the corresponding author of a work.

    Each is resolved to its OpenAlex author record and turned into a 5-axis
    radar so the frontend can overlay the two. If the work flags no
    corresponding author, the last (senior) author stands in by convention.
    Author lookups are best-effort: a failure just yields a null radar.
    """
    if not authorships:
        return {"first": None, "corresponding": None}

    first_au = next(
        (a for a in authorships if a.get("author_position") == "first"),
        authorships[0],
    )
    corr_au = next((a for a in authorships if a.get("is_corresponding")), None)
    corr_role = "Corresponding author"
    if corr_au is None:
        corr_au = next(
            (a for a in authorships if a.get("author_position") == "last"),
            authorships[-1],
        )
        corr_role = "Senior author (last)"

    cache: dict[str, dict | None] = {}

    def build(authorship: dict | None, role: str) -> dict | None:
        if not authorship:
            return None
        a = authorship.get("author") or {}
        aid = a.get("id")
        record = None
        if aid:
            if aid not in cache:
                try:
                    cache[aid] = openalex.get_author(aid)
                except Exception:  # noqa: BLE001 - author data is best-effort
                    cache[aid] = None
            record = cache[aid]
        return {
            "name": a.get("display_name"),
            "role": role,
            "openalex_id": aid.split("/")[-1] if aid else None,
            "radar": metrics.author_radar(record) if record else None,
        }

    return {
        "first": build(first_au, "First author"),
        "corresponding": build(corr_au, corr_role),
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


# --------------------------------------------------------------------------
# citation network
# --------------------------------------------------------------------------
# Caps that keep the graph fast (≈3 API calls) and legible on screen.
_NET_REF_CAP = 18      # references (works the seed cites) to include
_NET_REL_CAP = 10      # OpenAlex "related_works" to include
_NET_CITE_CAP = 15     # most-cited papers that cite the seed
_NET_TOTAL_CAP = 40    # hard cap on neighbour nodes
_NET_COUPLING_MIN = 3  # shared references needed for a neighbour↔neighbour link


def _net_node(rec: dict, relation: str) -> dict:
    """Shape one OpenAlex work into a graph node the frontend can draw."""
    authorships = rec.get("authorships") or []
    first = None
    if authorships:
        first = (authorships[0].get("author") or {}).get("display_name")
    return {
        "id": rec.get("id", "").split("/")[-1],
        "title": rec.get("display_name") or "Untitled",
        "year": rec.get("publication_year"),
        "citations": rec.get("cited_by_count") or 0,
        "author": first,
        "doi": rec.get("doi"),
        "relation": relation,
        "category": openalex.work_category(rec),
        "seed": relation == "seed",
    }


def _build_network(work: dict) -> dict:
    """Build a citation web around `work`.

    Nodes: the seed paper plus its references, related works, and the papers
    that cite it. Links: the seed → each neighbour (the highlighted spokes),
    and neighbour ↔ neighbour where they cite one another or share enough
    references (bibliographic coupling) to read as a cluster.
    """
    seed_id = work.get("id", "").split("/")[-1]
    referenced = [r.split("/")[-1] for r in (work.get("referenced_works") or [])]
    related = [r.split("/")[-1] for r in (work.get("related_works") or [])]
    citing = openalex.get_citing_works(seed_id, n=_NET_CITE_CAP)

    # Decide a neighbour's relation once; first source to claim an id wins.
    relation: dict[str, str] = {}
    fetch_ids: list[str] = []
    for rid in referenced[:_NET_REF_CAP]:
        if rid and rid not in relation:
            relation[rid] = "reference"
            fetch_ids.append(rid)
    for rid in related[:_NET_REL_CAP]:
        if rid and rid not in relation:
            relation[rid] = "related"
            fetch_ids.append(rid)

    # References + related need a metadata round-trip; citing arrives complete.
    records: dict[str, dict] = {}
    for rec in openalex.get_works_by_ids(fetch_ids):
        records[rec.get("id", "").split("/")[-1]] = rec
    for rec in citing:
        cid = rec.get("id", "").split("/")[-1]
        relation.setdefault(cid, "citing")
        records.setdefault(cid, rec)

    # Keep only neighbours we actually have records for, the seed aside, capped.
    neighbour_ids = [
        nid for nid in relation if nid != seed_id and nid in records
    ][:_NET_TOTAL_CAP]

    nodes = [_net_node(work, "seed")]
    nodes.extend(_net_node(records[nid], relation[nid]) for nid in neighbour_ids)

    # Highlighted spokes: seed → every neighbour.
    links = [{"source": seed_id, "target": nid, "primary": True} for nid in neighbour_ids]

    # Web strands: neighbour ↔ neighbour via direct citation or shared refs.
    full_id = {nid: records[nid].get("id") for nid in neighbour_ids}
    refsets = {nid: set(records[nid].get("referenced_works") or []) for nid in neighbour_ids}
    for i, a in enumerate(neighbour_ids):
        for b in neighbour_ids[i + 1:]:
            if full_id[b] in refsets[a] or full_id[a] in refsets[b]:
                links.append({"source": a, "target": b, "primary": False})
            elif len(refsets[a] & refsets[b]) >= _NET_COUPLING_MIN:
                links.append({"source": a, "target": b, "primary": False})

    return {
        "seed": seed_id,
        "title": work.get("display_name"),
        "nodes": nodes,
        "links": links,
    }


@app.route("/api/network")
def api_network():
    work_id = request.args.get("id", "").strip()
    q = request.args.get("q", "").strip()
    if not work_id and not q:
        return jsonify({"error": "Provide ?q=<search text> or ?id=<work id>"}), 400
    try:
        work = openalex.get_work(work_id) if work_id else openalex.find_work(q)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Lookup failed: {exc}"}), 502
    if not work:
        return jsonify({"error": "No matching paper found."}), 404
    try:
        return jsonify(_build_network(work))
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Network build failed: {exc}"}), 502


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
