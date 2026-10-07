#!/usr/bin/env python3
"""
Pull lithium supply-chain trade data from the UN Comtrade API (v1).

Outputs one Excel workbook per partner scope, with each commodity group on its
own tab:

    data/lithium_trade_world.xlsx      tabs: chemicals_ore | cells_batteries |
                                             coverage | _notes
    data/lithium_trade_bilateral.xlsx  (same tabs)

Matching CSVs are written alongside as the authoritative copy, because Excel
caps a sheet at 1,048,576 rows and the bilateral data can exceed that.

Annual data, 1990 through the latest available year.

Zero third-party dependencies: standard library only (the .xlsx writer below is
built on zipfile + XML, so there is nothing to pip install).

Quick start
-----------
    export COMTRADE_API_KEY="your-key-here"
    python3 pull_comtrade_lithium.py --scope world          # fast, small
    python3 pull_comtrade_lithium.py --scope bilateral      # slow, large
    python3 pull_comtrade_lithium.py                        # both

Get a free key at https://comtradedeveloper.un.org/ -> sign up -> subscribe to
the free "Comtrade - v1" product. The free tier is rate limited (on the order of
500 calls/day), so this script caches every API response to disk and resumes
where it left off. Re-run it on consecutive days if you hit the daily cap; cached
chunks cost nothing on the second run.

See README_comtrade_lithium.md for the full column dictionary and the data
caveats that matter (especially HS 2530.90 and the 2012 break in 8507.60).
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import sys
import time
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict
from datetime import datetime, timezone

API_BASE = "https://comtradeapi.un.org/data/v1/get/C/A/HS"
SIGNUP_URL = "https://comtradedeveloper.un.org/"

# Records returned in a single call before we assume the response was truncated
# and subdivide the query. The free tier's documented ceiling is 100k.
RECORD_CAP = 95_000

# Max reference periods accepted in one `period` parameter.
PERIODS_PER_CALL = 12


# --------------------------------------------------------------------------
# Commodity definitions
# --------------------------------------------------------------------------
# lce_factor: multiplier converting one tonne of the commodity to tonnes of
# lithium carbonate equivalent. Only set where the HS code is chemically pure
# enough for the conversion to mean anything; None everywhere else, so the
# output never fabricates an LCE number out of a basket code.

CODE_META = {
    # ---- Group 1: core chemicals + ore -----------------------------------
    "253090": {
        "group": "upstream",
        "desc": "Mineral substances n.e.c. (incl. spodumene/petalite/lepidolite concentrate)",
        "li_group": "ore_concentrate",
        "li_stage": "upstream",
        "code_purity": "mixed",
        "lce_factor": None,
        "lce_basis": "",
        "first_year": 1988,
    },
    "283691": {
        "group": "upstream",
        "desc": "Lithium carbonate",
        "li_group": "chemical_carbonate",
        "li_stage": "midstream",
        "code_purity": "pure",
        "lce_factor": 1.0,
        "lce_basis": "Li2CO3, 1:1 by definition",
        "first_year": 1988,
    },
    "282520": {
        "group": "upstream",
        "desc": "Lithium oxide and hydroxide",
        "li_group": "chemical_hydroxide",
        "li_stage": "midstream",
        "code_purity": "pure",
        "lce_factor": 0.8809,
        "lce_basis": "assumes LiOH.H2O (battery grade); anhydrous LiOH would be 1.5426",
        "first_year": 1988,
    },
    "280519": {
        "group": "upstream",
        "desc": "Alkali metals other than sodium (lithium metal)",
        "li_group": "metal",
        "li_stage": "midstream",
        "code_purity": "pure",
        "lce_factor": 5.3227,
        "lce_basis": "Li metal; code also carries Rb/Cs in small volumes",
        "first_year": 1988,
    },
    "282739": {
        "group": "upstream",
        "desc": "Chlorides n.e.c. (lithium chloride)",
        "li_group": "chemical_other",
        "li_stage": "midstream",
        "code_purity": "mixed",
        "lce_factor": None,
        "lce_basis": "basket code; LiCl factor would be 0.8715 if isolated",
        "first_year": 1988,
    },
    # ---- Group 2: cells and batteries ------------------------------------
    "850760": {
        "group": "batteries",
        "desc": "Electric accumulators; lithium-ion",
        "li_group": "cell_battery",
        "li_stage": "downstream",
        "code_purity": "pure",
        "lce_factor": None,
        "lce_basis": "",
        "first_year": 2012,  # subheading created in HS2012
    },
    "850780": {
        "group": "batteries",
        "desc": "Electric accumulators; other (contains lithium-ion before 2012)",
        "li_group": "cell_battery",
        "li_stage": "downstream",
        "code_purity": "mixed",
        "lce_factor": None,
        "lce_basis": "",
        "first_year": 1988,
    },
    "850650": {
        "group": "batteries",
        "desc": "Primary cells and batteries; lithium",
        "li_group": "cell_battery",
        "li_stage": "downstream",
        "code_purity": "pure",
        "lce_factor": None,
        "lce_basis": "",
        "first_year": 1996,  # subheading created in HS1996
    },
}

GROUPS = {
    "upstream": [c for c, m in CODE_META.items() if m["group"] == "upstream"],
    "batteries": [c for c, m in CODE_META.items() if m["group"] == "batteries"],
}

# Tab name inside the workbook, and the stem of the matching CSV.
GROUP_TABS = {
    "upstream": "chemicals_ore",
    "batteries": "cells_batteries",
}

# One workbook per partner scope.
WORKBOOK_NAMES = {
    "world": "lithium_trade_world.xlsx",
    "bilateral": "lithium_trade_bilateral.xlsx",
}

FLOWS = "M,X,RX,RM"  # import, export, re-export, re-import


# --------------------------------------------------------------------------
# Output schema
# --------------------------------------------------------------------------

COLUMNS = [
    # keys and dimensions
    "period", "year", "freq",
    "reporter_code", "reporter_iso3", "reporter_name",
    "partner_code", "partner_iso3", "partner_name", "partner2_iso3",
    "flow_code", "flow_desc",
    "cmd_code", "cmd_desc",
    # analytic groupings (added by this script, not by Comtrade)
    "li_group", "li_stage", "code_purity",
    # measures
    "trade_value_usd", "cif_value_usd", "fob_value_usd",
    "net_weight_kg", "gross_weight_kg",
    "qty", "qty_unit",
    "unit_value_usd_per_kg",
    "lce_tonnes", "lce_factor", "lce_basis",
    # provenance and quality
    "hs_revision", "is_original_classification",
    "is_reported", "is_aggregate",
    "is_qty_estimated", "legacy_estimation_flag",
    "retrieved_at", "source",
]

# Uniquely identifies an observation; used to drop duplicates across chunks.
KEY_COLUMNS = ("period", "reporter_code", "partner_code", "partner2_iso3",
               "flow_code", "cmd_code")

SOURCE_LABEL = "UN Comtrade API v1 (comtradeapi.un.org)"


# --------------------------------------------------------------------------
# API client
# --------------------------------------------------------------------------

class CallBudgetExhausted(Exception):
    """Raised when the run hits its --max-calls limit."""


CERT_HELP = """
SSL certificate verification failed -- Python cannot find any root certificates.

This is a standard macOS quirk: the python.org installer ships its certificate
bundle but does not activate it. (curl works because it uses the macOS system
trust store instead, so the network itself is fine.)

Fix it permanently by running the installer's own script:

    /Applications/Python\\ 3.14/Install\\ Certificates.command

Adjust the version number to match your Python. Then re-run this script.

Alternatively, install certifi and this script will pick it up automatically:

    python3 -m pip install certifi
"""


def build_ssl_context():
    """Prefer certifi's CA bundle, which sidesteps the macOS python.org issue
    where the interpreter ships without an activated root certificate store."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


class ComtradeClient:
    def __init__(self, api_key, cache_dir, sleep=1.0, max_calls=None,
                 use_cache=True, verbose=True):
        self.api_key = api_key
        self.cache_dir = cache_dir
        self.sleep = sleep
        self.max_calls = max_calls
        self.use_cache = use_cache
        self.verbose = verbose
        self.calls_made = 0
        self.cache_hits = 0
        self.ssl_context = build_ssl_context()
        os.makedirs(cache_dir, exist_ok=True)

    def _log(self, msg):
        if self.verbose:
            print(msg, file=sys.stderr, flush=True)

    def _cache_path(self, params):
        blob = json.dumps(params, sort_keys=True)
        digest = hashlib.sha256(blob.encode()).hexdigest()[:20]
        return os.path.join(self.cache_dir, f"{digest}.json")

    def get(self, params):
        """Fetch one chunk. Returns a list of raw Comtrade records."""
        path = self._cache_path(params)
        if self.use_cache and os.path.exists(path):
            self.cache_hits += 1
            with open(path) as fh:
                return json.load(fh)

        if self.max_calls is not None and self.calls_made >= self.max_calls:
            raise CallBudgetExhausted(
                f"reached --max-calls={self.max_calls}; re-run to continue "
                f"(cached chunks will be reused)"
            )

        query = {k: v for k, v in params.items() if v is not None}
        url = f"{API_BASE}?{urllib.parse.urlencode(query)}"
        data = self._request_with_retry(url)
        self.calls_made += 1

        with open(path, "w") as fh:
            json.dump(data, fh)
        time.sleep(self.sleep)
        return data

    def _request_with_retry(self, url, attempts=5):
        delay = 5.0
        for attempt in range(1, attempts + 1):
            req = urllib.request.Request(
                url,
                headers={
                    "Ocp-Apim-Subscription-Key": self.api_key,
                    "Accept": "application/json",
                    "User-Agent": "lithium-trade-pull/1.0",
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=180,
                                            context=self.ssl_context) as resp:
                    payload = json.loads(resp.read().decode())
                if payload.get("error"):
                    raise RuntimeError(f"Comtrade error: {payload['error']}")
                return payload.get("data") or []

            except urllib.error.HTTPError as exc:
                if exc.code == 401:
                    raise SystemExit(
                        "\n401 Unauthorized. Your COMTRADE_API_KEY was rejected.\n"
                        f"Check the key, or get one at {SIGNUP_URL}\n"
                    )
                if exc.code == 429:
                    # Rate limited. If it's the daily cap, backing off won't
                    # help, so surface it clearly after a couple of tries.
                    if attempt >= 3:
                        raise SystemExit(
                            "\nRate limited (HTTP 429) repeatedly. You have most "
                            "likely hit the free tier's daily call cap.\n"
                            "Everything fetched so far is cached -- just re-run "
                            "this script tomorrow and it will resume.\n"
                        )
                    self._log(f"  429 rate limited; sleeping {delay:.0f}s")
                elif exc.code in (500, 502, 503, 504):
                    self._log(f"  HTTP {exc.code}; retry {attempt}/{attempts}")
                else:
                    raise
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                # A bad trust store is a permanent condition -- retrying it just
                # produces four more identical failures, so fail fast with the fix.
                reason = getattr(exc, "reason", None)
                if isinstance(exc, ssl.SSLCertVerificationError) or \
                        isinstance(reason, ssl.SSLCertVerificationError):
                    raise SystemExit(CERT_HELP)
                self._log(f"  {type(exc).__name__}: {exc}; retry {attempt}/{attempts}")

            if attempt == attempts:
                raise RuntimeError(f"failed after {attempts} attempts: {url}")
            time.sleep(delay)
            delay *= 2
        return []


# --------------------------------------------------------------------------
# Fetch strategies
# --------------------------------------------------------------------------

def chunk(seq, size):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def relevant_years(code, years):
    """Skip years before the HS subheading existed -- saves wasted calls."""
    first = CODE_META[code]["first_year"]
    return [y for y in years if y >= first]


def fetch_world(client, codes, years):
    """World-total rows: one call per code group per period block.

    partner=World keeps responses tiny, so we can batch many years per call.
    """
    records = []
    covered = sorted({y for c in codes for y in relevant_years(c, years)})
    for block in chunk(covered, PERIODS_PER_CALL):
        client._log(f"  world: {block[0]}-{block[-1]}")
        records.extend(client.get({
            "reportercode": None,          # omit == all reporters
            "period": ",".join(str(y) for y in block),
            "partnerCode": 0,              # 0 == World
            "partner2Code": 0,
            "cmdCode": ",".join(codes),
            "flowCode": FLOWS,
            "includeDesc": "True",
        }))
    return records


def fetch_bilateral(client, codes, years):
    """Full reporter x partner rows, subdividing when a response looks truncated.

    One call per (code, year) is usually enough. If a response comes back at the
    record cap we split it by flow, then by reporter batches, so no data is
    silently lost to truncation.
    """
    records = []
    for code in codes:
        for year in relevant_years(code, years):
            client._log(f"  bilateral: {code} {year}")
            records.extend(_bilateral_chunk(client, code, year))
    return records


def _bilateral_chunk(client, code, year, flow=FLOWS, reporters=None):
    data = client.get({
        "reportercode": reporters,
        "period": str(year),
        "partnerCode": None,           # omit == all partners
        "cmdCode": code,
        "flowCode": flow,
        "includeDesc": "True",
    })

    if len(data) < RECORD_CAP:
        return data

    # Truncated. Split by flow first, then by reporter batches.
    if flow == FLOWS:
        client._log(f"    {code} {year} hit record cap; splitting by flow")
        out = []
        for single in FLOWS.split(","):
            out.extend(_bilateral_chunk(client, code, year, flow=single))
        return out

    if reporters is None:
        client._log(f"    {code} {year} {flow} still capped; splitting by reporter")
        codes_list = sorted({str(r.get("reporterCode")) for r in data if r.get("reporterCode")})
        out = []
        for batch in chunk(codes_list, 25):
            out.extend(_bilateral_chunk(client, code, year, flow=flow,
                                        reporters=",".join(batch)))
        return out

    client._log(f"    WARNING: {code} {year} {flow} may still be truncated "
                f"({len(data)} records)")
    return data


# --------------------------------------------------------------------------
# Normalisation
# --------------------------------------------------------------------------

def _num(value):
    if value in (None, "", "NA"):
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out


def _flag(value):
    if value in (None, ""):
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value).lower()


def normalise(raw, retrieved_at):
    """Map one Comtrade record onto the output schema."""
    code = str(raw.get("cmdCode") or "").strip()
    meta = CODE_META.get(code, {})

    net_kg = _num(raw.get("netWgt"))
    value = _num(raw.get("primaryValue"))

    unit_value = None
    if value is not None and net_kg:      # guards both None and 0
        unit_value = round(value / net_kg, 6)

    lce_factor = meta.get("lce_factor")
    lce_tonnes = None
    if lce_factor is not None and net_kg is not None:
        lce_tonnes = round(net_kg / 1000.0 * lce_factor, 6)

    period = str(raw.get("period") or "")

    return {
        "period": period,
        "year": raw.get("refYear") or (period[:4] if period else ""),
        "freq": raw.get("freqCode") or "A",

        "reporter_code": raw.get("reporterCode"),
        "reporter_iso3": raw.get("reporterISO") or "",
        "reporter_name": raw.get("reporterDesc") or "",
        "partner_code": raw.get("partnerCode"),
        "partner_iso3": raw.get("partnerISO") or "",
        "partner_name": raw.get("partnerDesc") or "",
        "partner2_iso3": raw.get("partner2ISO") or "",

        "flow_code": raw.get("flowCode") or "",
        "flow_desc": raw.get("flowDesc") or "",
        "cmd_code": code,
        "cmd_desc": raw.get("cmdDesc") or meta.get("desc", ""),

        "li_group": meta.get("li_group", ""),
        "li_stage": meta.get("li_stage", ""),
        "code_purity": meta.get("code_purity", ""),

        "trade_value_usd": value,
        "cif_value_usd": _num(raw.get("cifvalue")),
        "fob_value_usd": _num(raw.get("fobvalue")),
        "net_weight_kg": net_kg,
        "gross_weight_kg": _num(raw.get("grossWgt")),
        "qty": _num(raw.get("qty")),
        "qty_unit": raw.get("qtyUnitAbbr") or "",
        "unit_value_usd_per_kg": unit_value,
        "lce_tonnes": lce_tonnes,
        "lce_factor": lce_factor if lce_factor is not None else "",
        "lce_basis": meta.get("lce_basis", ""),

        "hs_revision": raw.get("classificationCode") or "",
        "is_original_classification": _flag(raw.get("isOriginalClassification")),
        "is_reported": _flag(raw.get("isReported")),
        "is_aggregate": _flag(raw.get("isAggregate")),
        "is_qty_estimated": _flag(raw.get("isQtyEstimated")),
        "legacy_estimation_flag": raw.get("legacyEstimationFlag") or "",

        "retrieved_at": retrieved_at,
        "source": SOURCE_LABEL,
    }


def dedupe(rows):
    """Drop repeats that can arise where fetch chunks overlap."""
    seen = set()
    out = []
    for row in rows:
        key = tuple(str(row.get(c, "")) for c in KEY_COLUMNS)
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
    return out


# --------------------------------------------------------------------------
# Minimal streaming .xlsx writer (stdlib only)
# --------------------------------------------------------------------------
# An .xlsx file is just a zip of XML parts. Writing them directly keeps this
# script dependency-free and lets us stream millions of rows without building
# the whole document in memory.

EXCEL_MAX_ROWS = 1_048_576
EXCEL_MAX_DATA_ROWS = EXCEL_MAX_ROWS - 1        # one row goes to the header

# Columns forced to text so Excel cannot reformat them. HS codes in particular
# must not become numbers (Excel strips leading zeros and right-aligns them).
TEXT_COLUMNS = {"cmd_code", "period"}

_ILLEGAL_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def _xml_escape(text):
    text = _ILLEGAL_XML.sub("", str(text))
    return (text.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;"))


def _col_letter(index):
    """0 -> A, 25 -> Z, 26 -> AA."""
    letters = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def _safe_sheet_name(name):
    """Excel forbids []:*?/\\ and caps names at 31 characters."""
    cleaned = re.sub(r"[\[\]:*?/\\]", "_", str(name))
    return cleaned[:31] or "sheet"


def _cell_xml(ref, value, style=0, force_text=False):
    if value is None or value == "":
        return ""
    style_attr = f' s="{style}"' if style else ""
    if not force_text and isinstance(value, (int, float)) and not isinstance(value, bool):
        return f'<c r="{ref}"{style_attr}><v>{value}</v></c>'
    return (f'<c r="{ref}"{style_attr} t="inlineStr">'
            f"<is><t>{_xml_escape(value)}</t></is></c>")


def _sheet_xml_stream(columns, rows, freeze_header=True):
    """Yield the worksheet XML in chunks."""
    last_col = _col_letter(len(columns) - 1)

    head = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/'
            '2006/main">']
    if freeze_header:
        head.append('<sheetViews><sheetView workbookViewId="0">'
                    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" '
                    'state="frozen"/></sheetView></sheetViews>')
    head.append("<sheetData>")

    header_cells = "".join(
        _cell_xml(f"{_col_letter(i)}1", col, style=1, force_text=True)
        for i, col in enumerate(columns)
    )
    head.append(f'<row r="1">{header_cells}</row>')
    yield "".join(head)

    buffer = []
    row_number = 1
    for row in rows:
        row_number += 1
        cells = []
        for i, col in enumerate(columns):
            cells.append(_cell_xml(
                f"{_col_letter(i)}{row_number}",
                row.get(col) if isinstance(row, dict) else row[i],
                force_text=col in TEXT_COLUMNS,
            ))
        buffer.append(f'<row r="{row_number}">{"".join(cells)}</row>')
        if len(buffer) >= 2000:
            yield "".join(buffer)
            buffer = []
    if buffer:
        yield "".join(buffer)

    # autoFilter must follow sheetData to satisfy the schema.
    yield (f'</sheetData><autoFilter ref="A1:{last_col}{max(row_number, 1)}"/>'
           f"</worksheet>")


_RELS_ROOT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""

_STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium9" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>"""


def write_xlsx(path, sheets):
    """Write a workbook. `sheets` is a list of (name, columns, rows) tuples."""
    sheets = [(_safe_sheet_name(n), c, r) for n, c, r in sheets]

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        overrides = "".join(
            f'<Override PartName="/xl/worksheets/sheet{i}.xml" '
            f'ContentType="application/vnd.openxmlformats-officedocument.'
            f'spreadsheetml.worksheet+xml"/>'
            for i in range(1, len(sheets) + 1)
        )
        zf.writestr("[Content_Types].xml",
                    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                    '<Types xmlns="http://schemas.openxmlformats.org/package/'
                    '2006/content-types">'
                    '<Default Extension="rels" ContentType="application/vnd.'
                    'openxmlformats-package.relationships+xml"/>'
                    '<Default Extension="xml" ContentType="application/xml"/>'
                    '<Override PartName="/xl/workbook.xml" ContentType='
                    '"application/vnd.openxmlformats-officedocument.'
                    'spreadsheetml.sheet.main+xml"/>'
                    '<Override PartName="/xl/styles.xml" ContentType='
                    '"application/vnd.openxmlformats-officedocument.'
                    'spreadsheetml.styles+xml"/>'
                    f"{overrides}</Types>")

        zf.writestr("_rels/.rels", _RELS_ROOT)
        zf.writestr("xl/styles.xml", _STYLES)

        sheet_tags = "".join(
            f'<sheet name="{_xml_escape(name)}" sheetId="{i}" r:id="rId{i}"/>'
            for i, (name, _, _) in enumerate(sheets, start=1)
        )
        zf.writestr("xl/workbook.xml",
                    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                    '<workbook xmlns="http://schemas.openxmlformats.org/'
                    'spreadsheetml/2006/main" xmlns:r="http://schemas.'
                    'openxmlformats.org/officeDocument/2006/relationships">'
                    f"<sheets>{sheet_tags}</sheets></workbook>")

        rel_tags = "".join(
            f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org'
            f'/officeDocument/2006/relationships/worksheet" '
            f'Target="worksheets/sheet{i}.xml"/>'
            for i in range(1, len(sheets) + 1)
        )
        rel_tags += (f'<Relationship Id="rId{len(sheets) + 1}" Type="http://'
                     f'schemas.openxmlformats.org/officeDocument/2006/'
                     f'relationships/styles" Target="styles.xml"/>')
        zf.writestr("xl/_rels/workbook.xml.rels",
                    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                    '<Relationships xmlns="http://schemas.openxmlformats.org/'
                    f'package/2006/relationships">{rel_tags}</Relationships>')

        for i, (_, columns, rows) in enumerate(sheets, start=1):
            with zf.open(f"xl/worksheets/sheet{i}.xml", "w") as handle:
                for piece in _sheet_xml_stream(columns, rows):
                    handle.write(piece.encode("utf-8"))

    return path


def paginate_for_excel(tab_name, rows):
    """Split a dataset across continuation tabs if it exceeds Excel's limit.

    Returns [(tab_name, rows), ...]. The matching CSV always holds the complete
    dataset, so a split here is a convenience, never a loss of data.
    """
    if len(rows) <= EXCEL_MAX_DATA_ROWS:
        return [(tab_name, rows)]

    pages = []
    for index, start in enumerate(range(0, len(rows), EXCEL_MAX_DATA_ROWS), start=1):
        suffix = "" if index == 1 else f"_{index}"
        pages.append((f"{tab_name}{suffix}", rows[start:start + EXCEL_MAX_DATA_ROWS]))
    return pages


NOTES_COLUMNS = ["item", "detail"]

NOTES_ROWS = [
    ["Source", SOURCE_LABEL],
    ["Tabs", "chemicals_ore = HS 2530.90, 2836.91, 2825.20, 2805.19, 2827.39 | "
             "cells_batteries = HS 8507.60, 8507.80, 8506.50"],
    ["Grain", "One row per reporter x partner x flow x commodity x year"],
    ["Flows", "M = import, X = export, RX = re-export, RM = re-import"],
    ["", ""],
    ["CAVEAT: no lithium ore code",
     "Spodumene concentrate sits in HS 2530.90, a basket of unrelated mineral "
     "substances. A good proxy for Australia, mostly noise elsewhere. Comtrade "
     "stops at 6-digit HS, so national spodumene lines need the ABS directly."],
    ["CAVEAT: 8507.60 starts 2012",
     "The lithium-ion subheading was created in HS2012. Apparent zero trade "
     "before 2012 is a classification artefact, not a real collapse. Use "
     "8507.80 as a rough pre-2012 bridge."],
    ["CAVEAT: 8506.50 starts 1996", "Heading 8506 was restructured by chemistry in HS1996."],
    ["CAVEAT: reporting lags",
     "Recent years are missing reporters, not missing trade. Check the coverage "
     "tab before reading a recent-year decline as real. No annual 2026 data yet."],
    ["CAVEAT: mirror statistics",
     "A's exports to B rarely equal B's imports from A. The is_reported column "
     "separates reported values from Comtrade estimates."],
    ["", ""],
    ["code_purity", "'pure' = the HS code is essentially all lithium; 'mixed' = "
                    "lithium is a minority of a basket code. Filter to 'pure' "
                    "for series you can defend in print."],
    ["lce_tonnes", "Tonnes of lithium carbonate equivalent, populated only for "
                   "chemically pure codes. Blank for basket and battery codes "
                   "rather than a fabricated number. See lce_basis per row."],
    ["Do not stack tabs", "Bilateral rows sum to the world rows. Combining the "
                          "two workbooks double-counts."],
]


def write_csv(path, rows):
    rows = sorted(
        rows,
        key=lambda r: (str(r["cmd_code"]), str(r["year"]),
                       str(r["reporter_iso3"]), str(r["flow_code"]),
                       str(r["partner_iso3"])),
    )
    with open(path, "w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=COLUMNS, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({k: ("" if row.get(k) is None else row.get(k))
                             for k in COLUMNS})
    return len(rows)


COVERAGE_COLUMNS = ["group", "scope", "cmd_code", "cmd_desc", "year",
                    "n_records", "n_reporters", "total_trade_value_usd"]


def coverage_rows(datasets):
    """Summary showing what actually came back, so gaps are visible.

    `datasets` maps (group, scope) -> rows. Returns a list of lists matching
    COVERAGE_COLUMNS.
    """
    buckets = defaultdict(lambda: {"records": 0, "reporters": set(), "value": 0.0})
    for (group, scope), rows in datasets.items():
        for row in rows:
            bucket = buckets[(group, scope, row["cmd_code"], str(row["year"]))]
            bucket["records"] += 1
            bucket["reporters"].add(row["reporter_code"])
            if row["trade_value_usd"]:
                bucket["value"] += row["trade_value_usd"]

    out = []
    for key in sorted(buckets):
        group, scope, code, year = key
        bucket = buckets[key]
        out.append([
            group, scope, code, CODE_META.get(code, {}).get("desc", ""),
            int(year) if str(year).isdigit() else year,
            bucket["records"], len(bucket["reporters"]),
            round(bucket["value"], 2),
        ])
    return out


def write_coverage_csv(path, rows):
    with open(path, "w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(COVERAGE_COLUMNS)
        writer.writerows(rows)
    return len(rows)


def write_workbook(path, scope, scope_datasets, groups):
    """One workbook per partner scope, one tab per commodity group."""
    sheets = []
    warnings = []

    for group in groups:
        rows = scope_datasets.get(group)
        if rows is None:
            continue
        pages = paginate_for_excel(GROUP_TABS[group], rows)
        if len(pages) > 1:
            warnings.append(
                f"'{GROUP_TABS[group]}' has {len(rows):,} rows, above Excel's "
                f"{EXCEL_MAX_DATA_ROWS:,} per-sheet limit; split across "
                f"{len(pages)} tabs. The CSV holds the complete dataset."
            )
        for tab_name, page_rows in pages:
            sheets.append((tab_name, COLUMNS, page_rows))

    scoped = {k: v for k, v in scope_datasets.items()}
    sheets.append(("coverage", COVERAGE_COLUMNS,
                   coverage_rows({(g, scope): r for g, r in scoped.items()})))
    sheets.append(("_notes", NOTES_COLUMNS, NOTES_ROWS))

    write_xlsx(path, sheets)
    return warnings


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def resolve_key(cli_key):
    key = cli_key or os.environ.get("COMTRADE_API_KEY", "").strip()
    if key:
        return key
    raise SystemExit(
        "\nNo API key found.\n\n"
        "  1. Sign up (free) at " + SIGNUP_URL + "\n"
        "  2. Subscribe to the free 'Comtrade - v1' product\n"
        "  3. Copy your primary key, then:\n\n"
        '       export COMTRADE_API_KEY="your-key-here"\n\n'
        "     (add that line to ~/.zshrc to make it permanent)\n\n"
        "  4. Re-run this script.\n\n"
        "Alternatively pass it inline with --key. The free tier is rate limited;\n"
        "this script caches responses and resumes, so hitting the cap is safe.\n"
    )


def main():
    parser = argparse.ArgumentParser(
        description="Pull lithium supply-chain trade data from UN Comtrade.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--key", help="Comtrade API key (else $COMTRADE_API_KEY)")
    parser.add_argument("--start", type=int, default=1990)
    parser.add_argument("--end", type=int, default=datetime.now().year,
                        help="default: current year; years with no data are "
                             "simply absent from the output")
    parser.add_argument("--groups", default="upstream,batteries",
                        help="comma list: upstream, batteries")
    parser.add_argument("--scope", default="both",
                        choices=["world", "bilateral", "both"])
    parser.add_argument("--out", default="data",
                        help="output directory (default: ./data)")
    parser.add_argument("--format", default="both",
                        choices=["xlsx", "csv", "both"],
                        help="'both' (default) writes the workbooks plus CSVs; "
                             "CSVs are the authoritative copy since Excel caps "
                             "a sheet at 1,048,576 rows")
    parser.add_argument("--cache-dir", default=".comtrade_cache")
    parser.add_argument("--sleep", type=float, default=1.0,
                        help="seconds between API calls (default: 1.0)")
    parser.add_argument("--max-calls", type=int, default=None,
                        help="stop after N live calls; re-run to resume")
    parser.add_argument("--no-cache", action="store_true",
                        help="ignore cached responses")
    parser.add_argument("--dry-run", action="store_true",
                        help="print the planned call budget and exit")
    args = parser.parse_args()

    groups = [g.strip() for g in args.groups.split(",") if g.strip()]
    for group in groups:
        if group not in GROUPS:
            raise SystemExit(f"unknown group '{group}'; choose from {list(GROUPS)}")

    years = list(range(args.start, args.end + 1))
    scopes = ["world", "bilateral"] if args.scope == "both" else [args.scope]

    if args.dry_run:
        print(f"Years: {args.start}-{args.end}   Groups: {groups}   Scopes: {scopes}\n")
        total = 0
        for group in groups:
            codes = GROUPS[group]
            if "world" in scopes:
                covered = sorted({y for c in codes for y in relevant_years(c, years)})
                calls = (len(covered) + PERIODS_PER_CALL - 1) // PERIODS_PER_CALL
                total += calls
                print(f"  {group:10s} world      ~{calls:4d} calls")
            if "bilateral" in scopes:
                calls = sum(len(relevant_years(c, years)) for c in codes)
                total += calls
                print(f"  {group:10s} bilateral  ~{calls:4d} calls (before any splits)")
        print(f"\nMinimum total: ~{total} calls. Free tier is roughly 500/day.")
        print("Responses are cached, so a capped run resumes on the next run.")
        return

    api_key = resolve_key(args.key)
    os.makedirs(args.out, exist_ok=True)

    client = ComtradeClient(
        api_key=api_key,
        cache_dir=args.cache_dir,
        sleep=args.sleep,
        max_calls=args.max_calls,
        use_cache=not args.no_cache,
    )
    retrieved_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    want_xlsx = args.format in ("xlsx", "both")
    want_csv = args.format in ("csv", "both")

    datasets = {}
    all_warnings = []
    interrupted = False

    # Scope is the outer loop so each workbook can be finished and written
    # before moving on -- a rate-limited run still leaves complete output for
    # whatever scope it got through.
    for scope in scopes:
        scope_datasets = {}
        for group in groups:
            print(f"\n=== {scope} / {group} ===", file=sys.stderr)
            try:
                if scope == "world":
                    raw = fetch_world(client, GROUPS[group], years)
                else:
                    raw = fetch_bilateral(client, GROUPS[group], years)
            except CallBudgetExhausted as exc:
                print(f"\nStopping: {exc}", file=sys.stderr)
                interrupted = True
                raw = []

            rows = dedupe([normalise(r, retrieved_at) for r in raw])
            scope_datasets[group] = rows
            datasets[(group, scope)] = rows

            if want_csv:
                path = os.path.join(args.out, f"{GROUP_TABS[group]}_{scope}.csv")
                print(f"  -> {path}  ({write_csv(path, rows):,} rows)",
                      file=sys.stderr)

            if interrupted:
                break

        if want_xlsx and scope_datasets:
            path = os.path.join(args.out, WORKBOOK_NAMES[scope])
            warnings = write_workbook(path, scope, scope_datasets, groups)
            tabs = " | ".join(GROUP_TABS[g] for g in groups if g in scope_datasets)
            total = sum(len(r) for r in scope_datasets.values())
            print(f"  -> {path}  (tabs: {tabs} | coverage | _notes; "
                  f"{total:,} data rows)", file=sys.stderr)
            all_warnings.extend(warnings)

        if interrupted:
            break

    if want_csv:
        coverage_path = os.path.join(args.out, "coverage_summary.csv")
        n = write_coverage_csv(coverage_path, coverage_rows(datasets))
        print(f"  -> {coverage_path}  ({n:,} rows)", file=sys.stderr)

    for warning in all_warnings:
        print(f"\nNOTE: {warning}", file=sys.stderr)

    print(f"\nAPI calls: {client.calls_made} live, {client.cache_hits} from cache",
          file=sys.stderr)
    if interrupted:
        print("Run was cut short by the call budget or rate limit. "
              "Re-run to resume from cache.", file=sys.stderr)


if __name__ == "__main__":
    main()
