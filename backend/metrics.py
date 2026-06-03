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


def _unpack(axes: dict) -> dict:
    """
    Turn an ordered ``label -> (score, raw_display)`` mapping into the radar
    payload arrays.

    Every radar value is a *percentage of that metric's reference maximum*
    (the ceiling passed to the score helpers), so the chart axis is a clean
    0-100%. ``raw_display`` carries the underlying real value for each axis
    (e.g. "3,012 citations") so a tooltip can show the % and the raw number
    side by side — that's what reconciles the plot with the facts table.
    """
    return {
        "labels": list(axes.keys()),
        "values": [round(v[0], 1) for v in axes.values()],
        "raw_display": [v[1] for v in axes.values()],
    }


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
      * Team Size         - number of contributing authors
      * Topic Breadth     - how many distinct subjects the work touches
      * Recent Momentum   - citations earned in the last two years (is it
                            still being cited, or has interest cooled?)
    """
    now = datetime.now().year
    cited = work.get("cited_by_count", 0) or 0
    year = work.get("publication_year") or now
    years_since = max(1, now - year + 1)
    fwci = work.get("fwci")
    refs = len(work.get("referenced_works") or [])

    countries = {
        inst.get("country_code")
        for auth in (work.get("authorships") or [])
        for inst in (auth.get("institutions") or [])
        if inst.get("country_code")
    }

    is_oa = bool((work.get("open_access") or {}).get("is_oa"))
    n_authors = len(work.get("authorships") or [])
    n_topics = len(work.get("concepts") or [])

    # citations booked in the current and previous calendar year
    recent_cites = sum(
        (c.get("cited_by_count") or 0)
        for c in (work.get("counts_by_year") or [])
        if (c.get("year") or 0) >= now - 1
    )

    per_year = cited / years_since

    # Recency: this year -> 100, decays ~10 pts/year, floors at 0
    recency = _clamp(100 - (now - year) * 10)

    # label -> (0-100 score = % of that metric's reference max, raw display)
    axes = {
        "Citation Impact": (_log_score(cited, ceiling=5000), f"{cited:,} citations"),
        "Citation Velocity": (_log_score(per_year, ceiling=200), f"{per_year:.1f} cites/yr"),
        "Field Impact (FWCI)": (
            _ratio_score(fwci or 0, ceiling=3.0),
            f"FWCI {fwci:.2f}" if fwci is not None else "FWCI —",
        ),
        "Reference Depth": (_log_score(refs, ceiling=120), f"{refs} references"),
        "Collaboration Reach": (_ratio_score(len(countries), ceiling=8), f"{len(countries)} countries"),
        "Recency": (recency, str(year)),
        "Open Access": (100.0 if is_oa else 20.0, "Open" if is_oa else "Closed"),
        "Team Size": (_log_score(n_authors, ceiling=30), f"{n_authors} authors"),
        "Topic Breadth": (_ratio_score(n_topics, ceiling=12), f"{n_topics} topics"),
        "Recent Momentum": (_log_score(recent_cites, ceiling=150), f"{recent_cites:,} cites (2y)"),
    }

    payload = _unpack(axes)
    payload["raw"] = {
        "citations": cited,
        "publication_year": year,
        "citations_per_year": round(per_year, 1),
        "fwci": round(fwci, 2) if fwci is not None else None,
        "reference_count": refs,
        "author_countries": sorted(c for c in countries if c),
        "open_access": is_oa,
        "author_count": n_authors,
        "topic_count": n_topics,
        "recent_citations_2yr": recent_cites,
    }
    return payload


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
      * i10 Index          - papers with >=10 citations (depth of impact)
      * Productivity       - total works the journal has published
      * Topic Diversity    - how many distinct subjects it spans
    """
    stats = source.get("summary_stats") or {}
    impact = stats.get("2yr_mean_citedness", 0) or 0
    h_index = stats.get("h_index", 0) or 0
    i10 = stats.get("i10_index", 0) or 0
    total_cites = source.get("cited_by_count", 0) or 0
    works_count = source.get("works_count", 0) or 0
    n_topics = len(source.get("x_concepts") or [])

    countries = sample.get("countries", 0)
    institutions = sample.get("institutions", 0)
    oa_ratio = sample.get("oa_ratio", 0)
    discipline_fit = _discipline_fit(source, paper_concepts)

    # label -> (0-100 score = % of that metric's reference max, raw display)
    axes = {
        "Impact Factor": (_ratio_score(impact, ceiling=15.0), f"IF {impact:.2f}"),
        "h-index": (_log_score(h_index, ceiling=600), f"h = {h_index}"),
        "Citation Volume": (_log_score(total_cites, ceiling=2_000_000), f"{total_cites:,} citations"),
        "Geography Reach": (_ratio_score(countries, ceiling=25), f"{countries} countries"),
        "Educator Reach": (_log_score(institutions, ceiling=200), f"{institutions} institutions"),
        "Discipline Fit": (discipline_fit, f"{discipline_fit:.0f}% topic overlap"),
        "Open Access": (round(oa_ratio * 100, 1), f"{oa_ratio * 100:.0f}% open access"),
        "i10 Index": (_log_score(i10, ceiling=5000), f"i10 = {i10:,}"),
        "Productivity": (_log_score(works_count, ceiling=100_000), f"{works_count:,} works"),
        "Topic Diversity": (_ratio_score(n_topics, ceiling=25), f"{n_topics} topics"),
    }

    payload = _unpack(axes)
    payload["raw"] = {
        "impact_factor_2yr": round(impact, 2),
        "h_index": h_index,
        "i10_index": i10,
        "total_citations": total_cites,
        "works_count": works_count,
        "distinct_countries": countries,
        "distinct_institutions": institutions,
        "distinct_topics": n_topics,
        "open_access_ratio": round(oa_ratio, 2),
        "discipline_fit_pct": discipline_fit,
    }
    return payload


# --------------------------------------------------------------------------
# AUTHOR radar
# --------------------------------------------------------------------------
def author_radar(author: dict) -> dict:
    """
    Build the 5-axis radar payload for a single author.

    The five axes are the most popular author-level bibliometric indicators
    (per the research-impact literature / library guides) that OpenAlex's
    author `summary_stats` lets us compute directly:

      * h-index          - the best-known author metric (Hirsch)
      * i10-index        - Google Scholar's metric: papers with >=10 cites
      * Total Citations  - lifetime scholarly attention
      * Publications     - raw productivity (works count)
      * Recent Impact    - 2-year mean citedness, an "author impact factor"

    (g-index is also popular but needs each paper's citation count, which the
    author summary doesn't expose, so the author-impact-factor stands in.)

    As elsewhere, each value is a percentage of that metric's reference max,
    and `raw_display` carries the real number for the tooltip.
    """
    stats = author.get("summary_stats") or {}
    h_index = stats.get("h_index", 0) or 0
    i10 = stats.get("i10_index", 0) or 0
    mean_2yr = stats.get("2yr_mean_citedness", 0) or 0
    cites = author.get("cited_by_count", 0) or 0
    works = author.get("works_count", 0) or 0

    axes = {
        "h-index": (_log_score(h_index, ceiling=250), f"h = {h_index:,}"),
        "i10-index": (_log_score(i10, ceiling=1000), f"i10 = {i10:,}"),
        "Total Citations": (_log_score(cites, ceiling=500_000), f"{cites:,} citations"),
        "Publications": (_log_score(works, ceiling=1000), f"{works:,} works"),
        "Recent Impact": (_ratio_score(mean_2yr, ceiling=10.0), f"{mean_2yr:.2f} cites/paper (2y)"),
    }
    return _unpack(axes)


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
