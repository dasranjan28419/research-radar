"""
openalex.py
-----------
Thin client over the OpenAlex API (https://docs.openalex.org).

Why OpenAlex instead of scraping journal websites directly?
  * One open API covers ~250M works and every indexed journal, so we don't
    need a brittle, per-publisher HTML scraper that breaks on every redesign
    and gets IP-blocked.
  * It exposes exactly the fields this app's radar needs: citation counts,
    field-weighted impact (FWCI), journal 2-yr mean citedness / h-index,
    author institutions + countries, and subject concepts.
  * It's free and needs no API key. Sending a `mailto` just puts you in the
    faster "polite pool".

Drop-in alternatives if you ever want a second source: Crossref
(api.crossref.org) for metadata/DOIs and Semantic Scholar (api.semantic
scholar.org) for citations. The fields map closely to what's used here.
"""

from __future__ import annotations

import requests

BASE = "https://api.openalex.org"
# Identifying yourself = OpenAlex "polite pool" (faster, more reliable).
MAILTO = "anamika.ec@gmail.com"
TIMEOUT = 20


def _get(path: str, params: dict | None = None) -> dict:
    params = dict(params or {})
    params["mailto"] = MAILTO
    resp = requests.get(f"{BASE}{path}", params=params, timeout=TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def find_work(query: str) -> dict | None:
    """
    Resolve a user's free-text input to a single best-matching paper.

    Accepts a DOI, an OpenAlex id, or plain text (title / topic / author).
    Returns the full work record or None if nothing matches.
    """
    query = (query or "").strip()
    if not query:
        return None

    # Direct lookups first - exact and cheap.
    if query.lower().startswith("10.") or "doi.org/" in query.lower():
        doi = query.split("doi.org/")[-1]
        try:
            return _get(f"/works/doi:{doi}")
        except requests.HTTPError:
            return None
    if query.upper().startswith("W") and query[1:].isdigit():
        try:
            return _get(f"/works/{query}")
        except requests.HTTPError:
            return None

    # Otherwise full-text search, most-cited relevant hit first.
    data = _get(
        "/works",
        {
            "search": query,
            "per_page": 5,
            "sort": "relevance_score:desc",
        },
    )
    results = data.get("results") or []
    return results[0] if results else None


def search_works(query: str, limit: int = 8) -> list[dict]:
    """Return a short list of candidate papers for the picker UI."""
    data = _get(
        "/works",
        {"search": query, "per_page": limit, "sort": "relevance_score:desc"},
    )
    out = []
    for w in data.get("results") or []:
        src = (w.get("primary_location") or {}).get("source") or {}
        out.append(
            {
                "id": w.get("id", "").split("/")[-1],
                "title": w.get("display_name"),
                "year": w.get("publication_year"),
                "citations": w.get("cited_by_count"),
                "journal": src.get("display_name"),
                "authors": [
                    a.get("author", {}).get("display_name")
                    for a in (w.get("authorships") or [])[:4]
                ],
            }
        )
    return out


def get_work(work_id: str) -> dict | None:
    try:
        return _get(f"/works/{work_id}")
    except requests.HTTPError:
        return None


def get_source(source_id: str) -> dict | None:
    """Fetch a journal ('source') record by its OpenAlex id."""
    if not source_id:
        return None
    sid = source_id.split("/")[-1]
    try:
        return _get(f"/sources/{sid}")
    except requests.HTTPError:
        return None


def sample_journal(source_id: str, n: int = 50) -> dict:
    """
    OpenAlex's source record doesn't directly expose author geography or
    institutional spread, so we sample the journal's most recent `n`
    articles and aggregate:
        * distinct author country codes  -> geography reach
        * distinct institution ids        -> educator / institutional reach
        * fraction open access            -> accessibility

    A 50-article sample is a good speed/signal trade-off.
    """
    if not source_id:
        return {"countries": 0, "institutions": 0, "oa_ratio": 0.0, "sampled": 0}
    sid = source_id.split("/")[-1]
    data = _get(
        "/works",
        {
            "filter": f"primary_location.source.id:{sid}",
            "per_page": n,
            "sort": "publication_date:desc",
            "select": "open_access,authorships",
        },
    )
    works = data.get("results") or []
    countries: set[str] = set()
    institutions: set[str] = set()
    oa_count = 0
    for w in works:
        if (w.get("open_access") or {}).get("is_oa"):
            oa_count += 1
        for auth in w.get("authorships") or []:
            for inst in auth.get("institutions") or []:
                if inst.get("country_code"):
                    countries.add(inst["country_code"])
                if inst.get("id"):
                    institutions.add(inst["id"])

    return {
        "countries": len(countries),
        "institutions": len(institutions),
        "oa_ratio": (oa_count / len(works)) if works else 0.0,
        "sampled": len(works),
    }
