"""
metrics.py
----------
Pure functions that turn raw OpenAlex records into 0-100 normalized
"radar" scores. Keeping the math here (separate from the web layer)
makes every score easy to unit-test and tweak.

Why 0-100? A radar / spider plot only reads well when every axis shares
the same scale. Raw values (citations in the thousands, impact factor in
single digits) would make the polygon meaningless, so each metric is
squashed onto a common 0-100 scale with a transform chosen to match how
that metric is actually distributed (log for heavy-tailed counts, linear
caps for ratios, etc.).
"""

from __future__ import annotations

import math
from datetime import datetime


# --------------------------------------------------------------------------
# small normalization helpers
# --------------------------------------------------------------------------
def _clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def _log_score(value: float, ceiling: float) -> float:
    """
    Map a heavy-tailed count (citations, works, h-index) onto 0-100 using a
    log curve. `ceiling` is the count that should score ~100.

    Citations, journal output, etc. follow a power law: a handful of items
    have huge values and most have small ones. A linear scale would push
    almost everything into the bottom 1% of the axis. Log compression keeps
    the axis informative across the whole range.
    """
    if value <= 0:
        return 0.0
    return _clamp(math.log10(value + 1) / math.log10(ceiling + 1) * 100)


def _ratio_score(value: float, ceiling: float) -> float:
    """Linear map of a bounded value (e.g. impact factor) with a hard cap."""
    if value <= 0:
        return 0.0
    return _clamp(value / ceiling * 100)


# --------------------------------------------------------------------------
# PAPER radar
# --------------------------------------------------------------------------
def paper_radar(work: dict) -> dict:
    """
    Build the radar payload for a single paper.

    Axes (and the reasoning behind each):
      * Citation Impact   - raw scholarly attention (log-scaled count)
      * Citation Velocity - citations per year; rewards papers that are
                            cited fast, not just old papers that accrued
                            citations over decades
      * Field Impact      - OpenAlex FWCI (field-weighted citation impact):
                            1.0 == world average for the field, so this is
                            the fairest cross-discipline comparison
      * Reference Depth   - how well-grounded the work is in prior lit
      * Collaboration     - distinct countries among the authors (breadth
                            of the team / international reach)
      * Recency           - how current the work is
      * Open Access       - is it freely readable (reach / equity signal)
    """
    cited = work.get("cited_by_count", 0) or 0
    year = work.get("publication_year") or datetime.now().year
    years_since = max(1, datetime.now().year - year + 1)
    fwci = work.get("fwci")
    refs = len(work.get("referenced_works") or [])

    countries = {
        inst.get("country_code")
        for auth in (work.get("authorships") or [])
        for inst in (auth.get("institutions") or [])
        if inst.get("country_code")
    }

    is_oa = bool((work.get("open_access") or {}).get("is_oa"))

    # Recency: this year -> 100, decays ~10 pts/year, floors at 0
    recency = _clamp(100 - (datetime.now().year - year) * 10)

    axes = {
        "Citation Impact": _log_score(cited, ceiling=5000),
        "Citation Velocity": _log_score(cited / years_since, ceiling=200),
        "Field Impact (FWCI)": _ratio_score(fwci or 0, ceiling=3.0),
        "Reference Depth": _log_score(refs, ceiling=120),
        "Collaboration Reach": _ratio_score(len(countries), ceiling=8),
        "Recency": recency,
        "Open Access": 100.0 if is_oa else 20.0,
    }

    return {
        "labels": list(axes.keys()),
        "values": [round(v, 1) for v in axes.values()],
        "raw": {
            "citations": cited,
            "publication_year": year,
            "citations_per_year": round(cited / years_since, 1),
            "fwci": round(fwci, 2) if fwci is not None else None,
            "reference_count": refs,
            "author_countries": sorted(c for c in countries if c),
            "open_access": is_oa,
        },
    }


# --------------------------------------------------------------------------
# JOURNAL radar
# --------------------------------------------------------------------------
def journal_radar(source: dict, sample: dict, paper_concepts: set[str]) -> dict:
    """
    Build the radar payload for the journal (OpenAlex "source").

    `source`         - the journal record (summary_stats, counts, concepts)
    `sample`         - aggregates computed from a sample of recent articles
                       (distinct countries, distinct institutions, OA ratio)
    `paper_concepts` - the input paper's concept ids, used to score how well
                       the paper actually fits the journal's subject area

    Axes:
      * Impact Factor     - OpenAlex 2-year mean citedness (a JIF analogue)
      * h-index           - long-run prestige / consistency
      * Citation Volume   - total scholarly footprint of the journal
      * Geography Reach    - distinct author countries (global vs regional)
      * Educator/Inst Reach- distinct contributing institutions
      * Discipline Fit     - concept overlap between paper and journal
      * Open Access        - share of freely-readable articles
    """
    stats = source.get("summary_stats") or {}
    impact = stats.get("2yr_mean_citedness", 0) or 0
    h_index = stats.get("h_index", 0) or 0
    total_cites = source.get("cited_by_count", 0) or 0

    discipline_fit = _discipline_fit(source, paper_concepts)

    axes = {
        "Impact Factor": _ratio_score(impact, ceiling=15.0),
        "h-index": _log_score(h_index, ceiling=600),
        "Citation Volume": _log_score(total_cites, ceiling=2_000_000),
        "Geography Reach": _ratio_score(sample.get("countries", 0), ceiling=25),
        "Educator Reach": _log_score(sample.get("institutions", 0), ceiling=200),
        "Discipline Fit": discipline_fit,
        "Open Access": round(sample.get("oa_ratio", 0) * 100, 1),
    }

    return {
        "labels": list(axes.keys()),
        "values": [round(v, 1) for v in axes.values()],
        "raw": {
            "impact_factor_2yr": round(impact, 2),
            "h_index": h_index,
            "total_citations": total_cites,
            "works_count": source.get("works_count"),
            "distinct_countries": sample.get("countries", 0),
            "distinct_institutions": sample.get("institutions", 0),
            "open_access_ratio": round(sample.get("oa_ratio", 0), 2),
            "discipline_fit_pct": discipline_fit,
        },
    }


def _discipline_fit(source: dict, paper_concepts: set[str]) -> float:
    """
    How well does the paper's subject match the journal's typical subjects?

    We compare the paper's concept ids against the journal's top concepts
    (OpenAlex `x_concepts`) and weight the overlap by the journal's concept
    scores, so matching a *core* topic of the journal counts more than
    matching a fringe one.
    """
    if not paper_concepts:
        return 50.0  # unknown -> neutral

    journal_concepts = {
        c.get("id"): (c.get("score") or 0)
        for c in (source.get("x_concepts") or [])
    }
    if not journal_concepts:
        return 50.0

    matched = sum(score for cid, score in journal_concepts.items() if cid in paper_concepts)
    total = sum(journal_concepts.values()) or 1
    return _clamp(matched / total * 100)
