#!/usr/bin/env python3
"""
Scrape USGS Mineral Commodity Summaries (lithium) into one tidy CSV.

    pip install requests pdfplumber
    python scrape_usgs_lithium.py --start 1996 --end 2026 --out lithium_usgs.csv

What it does
------------
1. Reads the USGS lithium index page and harvests the real PDF URL for every
   MCS edition. URLs are NOT constructed: pre-2020 editions live on an S3
   bucket with inconsistent filenames, so guessing them fails.
2. Downloads each PDF once into ./cache/ and reuses it on later runs.
3. Extracts text at the character level so superscript footnote markers can be
   dropped before parsing. This matters: the 2026 edition prints Argentina's
   2024 production as "5" + "13,800", where 5 is a footnote. Naive text
   extraction yields 513,800 instead of 13,800 - a 37x error that looks
   entirely plausible in a spreadsheet.
4. Parses four blocks per edition: world mine production and reserves by
   country, U.S. salient statistics, the global end-use split, and the world
   production and consumption figures stated in the prose.
5. Writes one long-format CSV and prints validation warnings.

Output columns
--------------
edition        MCS edition year (the publication, not the data year)
data_year      the year the value describes
section        mine_production | reserves | us_salient | end_use | world_total
country        country name, "World", "United States", or "" where n/a
metric         what is measured
value          numeric, or empty when withheld/not published
unit           t_Li | percent | usd_per_t | count | ratio
flag           e=estimated, r=revised, W=withheld, NA, or empty
source_url     the PDF the value came from

Long format is deliberate. USGS changes its country list, its end-use
categories and its column headers between editions, so any wide layout either
loses rows or fills them with fabricated zeros. Pivot at the end, not here.
"""

import argparse
import csv
import os
import re
import sys
import time
from collections import Counter

try:
    import requests
except ImportError:
    sys.exit("pip install requests pdfplumber")
try:
    import pdfplumber
except ImportError:
    sys.exit("pip install requests pdfplumber")


INDEX_URL = ("https://www.usgs.gov/centers/national-minerals-information-center/"
             "lithium-statistics-and-information")

# USGS returns 403 to a bare requests user-agent. It also rate-limits: three
# rapid hits during development got the connection blocked for several minutes.
# Keep the delay. Do not parallelise this.
HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/124.0 Safari/537.36"),
    "Accept": "application/pdf,text/html,*/*",
}
DELAY = 3.0

CACHE = "cache"

# Countries USGS has used in the lithium production table across editions.
COUNTRY_NAMES = [
    "United States", "Argentina", "Australia", "Austria", "Bolivia", "Brazil",
    "Canada", "Chile", "China", "Congo (Kinshasa)", "Czechia", "Finland",
    "Germany", "Ghana", "Mali", "Mexico", "Namibia", "Nigeria", "Portugal",
    "Russia", "Serbia", "Spain", "Zimbabwe", "Other countries",
]

END_USE_TERMS = [
    "batteries", "ceramics and glass", "lubricating greases",
    "continuous casting mold flux powders", "casting mold flux powders",
    "polymer production", "polymers", "air treatment", "medical",
    "pharmaceuticals", "metallurgical", "primary aluminum production",
    "other uses",
]


# --------------------------------------------------------------------------
# fetching
# --------------------------------------------------------------------------

def get_index_links(session, debug=False):
    """
    Harvest {edition_year: pdf_url} for Mineral Commodity Summaries.

    Deliberately tolerant. USGS has changed this page's markup more than once,
    so rather than expecting a particular tag structure, this pulls every PDF
    href on the page and works out the year and the series from the URL itself,
    falling back to the anchor text. Yearbook PDFs are excluded by URL pattern
    (/myb/, myb1-) rather than by splitting on a heading, which is what broke
    the earlier version.
    """
    links = {}
    try:
        r = session.get(INDEX_URL, headers=HEADERS, timeout=60)
        r.raise_for_status()
        html = r.text
    except Exception as e:
        print("  ! could not read index page: %s" % e)
        html = ""

    # Every anchor with a PDF target, plus whatever text sits inside it.
    for href, text in re.findall(r'href="([^"]+?\.pdf)"(.*?)</a>', html,
                                 re.I | re.S):
        url = href if href.startswith("http") else \
            ("https://www.usgs.gov" + href if href.startswith("/") else None)
        if not url:
            continue

        low = url.lower()
        if "/myb" in low or "myb1-" in low or "-myb" in low:
            continue  # Minerals Yearbook, different parser entirely
        if "lith" not in low and "mcs" not in low:
            continue

        year = None
        # mcs2026-lithium.pdf / mcs-2013-lithi.pdf / mcs2021/...
        ym = re.search(r"mcs[-_]?((?:19|20)\d{2})", low)
        if ym:
            year = int(ym.group(1))
        if year is None:
            ym = re.search(r"/((?:19|20)\d{2})/", low)
            if ym:
                year = int(ym.group(1))
        if year is None:
            plain = re.sub(r"<[^>]+>", " ", text)
            ym = re.search(r"\b((?:19|20)\d{2})\b", plain)
            if ym:
                year = int(ym.group(1))
        if year and 1990 <= year <= 2100:
            links.setdefault(year, url)

    if debug:
        print("  index yielded %d links" % len(links))
        for y in sorted(links):
            print("    %d  %s" % (y, links[y]))

    # Fill anything the page did not give us. These were verified by hand.
    # 2020 onward follows a stable pattern; the older ones live on an S3
    # bucket with filenames that cannot be guessed.
    for y in range(2020, 2027):
        links.setdefault(
            y, "https://pubs.usgs.gov/periodicals/mcs%d/mcs%d-lithium.pdf" % (y, y))
    s3a = ("https://d9-wret.s3-us-west-2.amazonaws.com/assets/palladium/"
           "production/mineral-pubs/lithium/")
    s3b = ("https://d9-wret.s3.us-west-2.amazonaws.com/assets/palladium/"
           "production/mineral-pubs/lithium/")
    verified = {
        2019: ("https://d9-wret.s3-us-west-2.amazonaws.com/assets/palladium/"
               "production/atoms/files/mcs-2019-lithi.pdf"),
        2017: s3a + "mcs-2017-lithi.pdf",
        2015: s3a + "mcs-2015-lithi.pdf",
        2013: s3b + "mcs-2013-lithi.pdf",
    }
    for y, u in verified.items():
        links.setdefault(y, u)

    return links


def fetch_pdf(session, year, url):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, "mcs%d-lithium.pdf" % year)
    if os.path.exists(path) and os.path.getsize(path) > 10000:
        return path
    time.sleep(DELAY)
    r = session.get(url, headers=HEADERS, timeout=120)
    if r.status_code != 200:
        print("  ! HTTP %s for %s" % (r.status_code, url))
        return None
    if not r.content.startswith(b"%PDF"):
        print("  ! not a PDF (bot wall?) for %s" % url)
        return None
    with open(path, "wb") as f:
        f.write(r.content)
    return path


# --------------------------------------------------------------------------
# text extraction with superscript removal
# --------------------------------------------------------------------------

def extract_lines(path, superscript_ratio=0.86):
    """
    Return a list of text lines with superscript characters removed.

    pdfplumber exposes per-character font size. Footnote markers and the
    'e' / 'r' estimate flags are set smaller than body text, so anything
    below `superscript_ratio` of the line's dominant size is stripped out
    and recorded separately.
    """
    lines = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            chars = page.chars
            if not chars:
                continue
            rows = {}
            for ch in chars:
                key = round(ch["top"] / 2.0)
                rows.setdefault(key, []).append(ch)
            for key in sorted(rows):
                row = sorted(rows[key], key=lambda c: c["x0"])
                sizes = [round(c["size"], 1) for c in row]
                base = Counter(sizes).most_common(1)[0][0]
                kept, marks = [], []
                prev = None
                for c in row:
                    if round(c["size"], 1) < base * superscript_ratio:
                        marks.append(c["text"])
                        continue
                    # reinstate spaces lost by character-level assembly
                    if prev is not None and c["x0"] - prev["x1"] > 1.2:
                        kept.append(" ")
                    kept.append(c["text"])
                    prev = c
                text = "".join(kept)
                text = re.sub(r"\s+", " ", text).strip()
                if text:
                    lines.append({"text": text, "marks": "".join(marks)})
    return lines


def parse_number(tok):
    """'13,800' -> 13800 ; '--' / 'W' / 'NA' -> None."""
    tok = tok.strip().rstrip(".")
    if tok in ("--", "—", "-", "W", "NA", "XX", ""):
        return None
    tok = tok.replace(",", "").replace("$", "")
    try:
        return float(tok) if "." in tok else int(tok)
    except ValueError:
        return None


# --------------------------------------------------------------------------
# parsers
# --------------------------------------------------------------------------

def parse_production_table(lines, edition, url):
    """
    Country rows in the World Mine Production and Reserves table.

    Layout is: Country, production year A, production year B, reserves.
    Data years are edition-2 and edition-1.
    """
    out = []
    y_a, y_b = edition - 2, edition - 1

    started = False
    for ln in lines:
        t = ln["text"]
        if re.search(r"World\s+Mine\s+Production\s+and\s+Reserves", t, re.I):
            started = True
            continue
        if not started:
            continue
        if re.search(r"World\s+Resources", t, re.I):
            break

        name = None
        for c in sorted(COUNTRY_NAMES, key=len, reverse=True):
            if t.lower().startswith(c.lower()):
                name = c
                rest = t[len(c):]
                break
        if name is None:
            m = re.match(r"World total[^0-9W\-—]*(.*)$", t, re.I)
            if not m:
                continue
            name, rest = "World", m.group(1)

        toks = re.findall(r"[\d,]+\.?\d*|--|—|\bW\b|\bNA\b", rest)
        toks = [x for x in toks if x.strip()]
        if not toks:
            continue

        vals = [parse_number(x) for x in toks]
        raw = toks

        # Reserves is the last column; the two before it are production.
        if len(vals) >= 3:
            prod = vals[:2]
            prod_raw = raw[:2]
            reserves = vals[-1]
        elif len(vals) == 2:
            prod, prod_raw, reserves = [vals[0], None], [raw[0], ""], vals[1]
        else:
            prod, prod_raw, reserves = [vals[0], None], [raw[0], ""], None

        flag = ln["marks"]
        for dy, v, rw in zip((y_a, y_b), prod, prod_raw):
            if v is None and "W" not in rw:
                continue
            out.append(dict(
                edition=edition, data_year=dy, section="mine_production",
                country=name, metric="mine production",
                value="" if v is None else v, unit="t_Li",
                flag="W" if rw.strip() == "W" else flag, source_url=url))
        if reserves is not None:
            out.append(dict(
                edition=edition, data_year=edition - 1, section="reserves",
                country=name, metric="reserves", value=reserves,
                unit="t_Li", flag=flag, source_url=url))
    return out


def parse_us_salient(lines, edition, url):
    """U.S. salient statistics block: five year columns."""
    out = []
    years, started = [], False
    row_labels = [
        ("Production", "production", "t_Li"),
        ("Imports for consumption", "imports for consumption", "t_Li"),
        ("Exports", "exports", "t_Li"),
        ("Consumption, apparent", "apparent consumption", "t_Li"),
        ("Consumption, estimated", "estimated consumption", "t_Li"),
        ("Employment, mine and mill", "employment", "count"),
    ]
    for ln in lines:
        t = ln["text"]
        if re.search(r"Salient Statistics", t, re.I):
            # No trailing \b: the final column is written "2025e" and a word
            # boundary between "5" and "e" does not exist, which silently
            # drops the estimate year - the one most people actually want.
            years = [int(m.group()) for m in re.finditer(r"\b(?:19|20)\d{2}", t)]
            started = True
            continue
        if not started:
            continue
        if re.search(r"^Recycling", t, re.I):
            break
        if not years:
            continue

        for label, metric, unit in row_labels:
            if t.lower().startswith(label.lower()):
                rest = t[len(label):]
                toks = re.findall(r"[\d,]+\.?\d*|\bW\b|--|—", rest)
                for dy, tok in zip(years, toks):
                    v = parse_number(tok)
                    out.append(dict(
                        edition=edition, data_year=dy, section="us_salient",
                        country="United States", metric=metric,
                        value="" if v is None else v, unit=unit,
                        flag="W" if tok.strip() == "W" else "",
                        source_url=url))
                break

        if re.search(r"lithium carbonate", t, re.I) and re.search(r"dollars per metric ton", t, re.I):
            toks = re.findall(r"[\d,]+", t)
            prices = [parse_number(x) for x in toks if parse_number(x) and parse_number(x) > 1000]
            for dy, v in zip(years, prices):
                out.append(dict(
                    edition=edition, data_year=dy, section="us_salient",
                    country="United States", metric="lithium carbonate price",
                    value=v, unit="usd_per_t", flag="", source_url=url))
    return out


def parse_end_uses(lines, edition, url):
    """
    Global end-use split. One sentence per edition, describing edition-1.
    Wording drifts: 'global end-use markets are estimated as follows' in older
    editions, 'global end uses were estimated as follows' in newer ones.
    """
    out = []
    blob = " ".join(l["text"] for l in lines)
    m = re.search(r"global end[- ]use[s]?[^:]{0,40}:(.{0,400}?)\.", blob, re.I | re.S)
    if not m:
        return out
    frag = m.group(1)
    for part in frag.split(";"):
        pm = re.search(r"([A-Za-z][A-Za-z\s\(\)]+?),\s*(\d+)\s*%", part)
        if not pm:
            continue
        use = re.sub(r"^\s*and\s+", "", pm.group(1).strip()).lower()
        out.append(dict(
            edition=edition, data_year=edition - 1, section="end_use",
            country="World", metric=use, value=int(pm.group(2)),
            unit="percent", flag="e", source_url=url))
    return out


def parse_world_totals(lines, edition, url):
    """World production and consumption stated in the Events and Trends prose."""
    out = []
    blob = " ".join(l["text"] for l in lines)

    m = re.search(r"worldwide lithium production in (\d{4})\s+(?:increased|decreased)"
                  r"[^.]*?to\s+approximately\s+([\d,]+)\s+tons?[^.]*?from\s+([\d,]+)\s+tons?",
                  blob, re.I)
    if not m:
        m = re.search(r"worldwide lithium production in (\d{4})[^.]*?to\s+([\d,]+)\s+tons?"
                      r"[^.]*?from\s+([\d,]+)\s+tons?", blob, re.I)
    if m:
        yr = int(m.group(1))
        out.append(dict(edition=edition, data_year=yr, section="world_total",
                        country="World", metric="mine production, excl. U.S.",
                        value=parse_number(m.group(2)), unit="t_Li",
                        flag="e", source_url=url))
        out.append(dict(edition=edition, data_year=yr - 1, section="world_total",
                        country="World", metric="mine production, excl. U.S.",
                        value=parse_number(m.group(3)), unit="t_Li",
                        flag="r", source_url=url))

    m = re.search(r"[Cc]onsumption of lithium in (\d{4})[^.]*?"
                  r"(?:estimated|projected) to be\s+(?:about\s+)?([\d,]+)\s+tons?", blob)
    if m:
        out.append(dict(edition=edition, data_year=int(m.group(1)),
                        section="world_total", country="World",
                        metric="consumption", value=parse_number(m.group(2)),
                        unit="t_Li", flag="e", source_url=url))
    m2 = re.search(r"from\s+(?:the\s+)?(?:revised\s+)?consumption(?:\s+figure)?\s+of\s+"
                   r"([\d,]+)\s+tons?\s+in\s+(\d{4})", blob, re.I)
    if m2:
        out.append(dict(edition=edition, data_year=int(m2.group(2)),
                        section="world_total", country="World",
                        metric="consumption", value=parse_number(m2.group(1)),
                        unit="t_Li", flag="r", source_url=url))
    return out


# --------------------------------------------------------------------------
# validation
# --------------------------------------------------------------------------

def validate(rows):
    """Catch the failure modes that produce plausible-looking wrong numbers."""
    warn = []
    prod = [r for r in rows if r["section"] == "mine_production"
            and r["country"] not in ("World", "") and r["value"] != ""]

    # 1. A stray footnote digit multiplies a value by 10 or more. Compare each
    #    country against its own neighbouring data year across all editions.
    by_country = {}
    for r in prod:
        by_country.setdefault(r["country"], []).append(r)
    for c, rs in by_country.items():
        rs.sort(key=lambda r: (r["data_year"], r["edition"]))
        for a, b in zip(rs, rs[1:]):
            # Only adjacent years. Comparing 2012 against 2024 flags ordinary
            # growth as corruption and buries the real hits in noise.
            if not 0 < b["data_year"] - a["data_year"] <= 1:
                continue
            if a["value"] and b["value"]:
                ratio = max(a["value"], b["value"]) / max(min(a["value"], b["value"]), 1)
                if ratio > 8:
                    warn.append("%s %s=%s then %s=%s (%.0fx) - check for a "
                                "footnote digit glued to the number"
                                % (c, a["data_year"], a["value"],
                                   b["data_year"], b["value"], ratio))

    # 2. Country sum against the published world total, same edition and year.
    totals = {(r["edition"], r["data_year"]): r["value"] for r in rows
              if r["section"] == "mine_production" and r["country"] == "World"
              and r["value"] != ""}
    sums = {}
    for r in prod:
        sums[(r["edition"], r["data_year"])] = sums.get(
            (r["edition"], r["data_year"]), 0) + r["value"]
    for k, published in totals.items():
        s = sums.get(k)
        if s and published and abs(s - published) / published > 0.06:
            warn.append("MCS %s, %s: countries sum to %s vs published %s "
                        "(%.0f%% apart)" % (k[0], k[1], int(s), int(published),
                                            abs(s - published) / published * 100))

    # 3. End-use shares must total 100.
    eu = {}
    for r in rows:
        if r["section"] == "end_use":
            eu[r["edition"]] = eu.get(r["edition"], 0) + r["value"]
    for ed, tot in eu.items():
        if abs(tot - 100) > 1:
            warn.append("MCS %s: end-use shares total %s%%, not 100%%" % (ed, tot))

    # 4. Editions that yielded nothing.
    got = set(r["edition"] for r in rows)
    for ed in sorted(got):
        n = len([r for r in rows if r["edition"] == ed])
        if n < 5:
            warn.append("MCS %s produced only %d rows - layout probably differs"
                        % (ed, n))
    return warn


# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=int, default=2010)
    ap.add_argument("--end", type=int, default=2026)
    ap.add_argument("--out", default="lithium_usgs.csv")
    ap.add_argument("--only", type=int, nargs="*",
                    help="specific edition years, overrides start/end")
    ap.add_argument("--debug-links", action="store_true",
                    help="print every PDF link found on the index page and exit")
    args = ap.parse_args()

    session = requests.Session()
    print("Reading index ...")
    links = get_index_links(session, debug=args.debug_links)
    print("Have %d candidate editions (index plus verified fallbacks)."
          % len(links))
    if args.debug_links:
        for y in sorted(links):
            print("  %d  %s" % (y, links[y]))
        return

    wanted = args.only if args.only else [
        y for y in sorted(links) if args.start <= y <= args.end]

    rows = []
    for ed in wanted:
        url = links.get(ed)
        if not url:
            print("MCS %d: not on index page" % ed)
            continue
        print("MCS %d ..." % ed)
        path = fetch_pdf(session, ed, url)
        if not path:
            continue
        try:
            lines = extract_lines(path)
        except Exception as e:
            print("  ! could not read PDF: %s" % e)
            continue
        got = []
        got += parse_production_table(lines, ed, url)
        got += parse_us_salient(lines, ed, url)
        got += parse_end_uses(lines, ed, url)
        got += parse_world_totals(lines, ed, url)
        print("  %d rows" % len(got))
        rows += got

    if not rows:
        sys.exit("Nothing parsed.")

    rows.sort(key=lambda r: (r["data_year"], r["section"], r["country"], r["metric"]))
    cols = ["edition", "data_year", "section", "country", "metric",
            "value", "unit", "flag", "source_url"]
    with open(args.out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    print("\nWrote %d rows to %s" % (len(rows), args.out))

    warn = validate(rows)
    if warn:
        print("\n%d validation warnings - read these before using the data:" % len(warn))
        for x in warn:
            print("  - " + x)
    else:
        print("No validation warnings.")

    print("\nNote: where two editions report the same data_year, both rows are "
          "kept. USGS revises heavily (2024 went 240,000 -> 222,000). Pick a "
          "vintage deliberately; do not deduplicate blindly.")


if __name__ == "__main__":
    main()