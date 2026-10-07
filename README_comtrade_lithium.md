# UN Comtrade lithium trade data pull

Pulls annual lithium supply-chain trade data (1990 → latest available) from the
UN Comtrade v1 API and writes tidy CSVs.

## Setup

1. Register (free) at <https://comtradedeveloper.un.org/>
2. Subscribe to the free **Comtrade - v1** product and copy your primary key
3. Export it:

```bash
export COMTRADE_API_KEY="your-key-here"
```

Add that line to `~/.zshrc` to make it permanent. No `pip install` is needed —
the script uses only the Python standard library, including the `.xlsx` writer
(built on `zipfile` + XML, so there is no openpyxl dependency).

## Running

```bash
python3 pull_comtrade_lithium.py --dry-run
```

```bash
python3 pull_comtrade_lithium.py
```

The full pull is roughly 276 API calls, which fits inside one day of the free
tier (~500/day). Every response is cached in `.comtrade_cache/`, so an
interrupted or rate-limited run resumes for free — just re-run it.

Useful flags: `--scope world` (fast, small), `--scope bilateral`,
`--groups upstream`, `--start/--end`, `--max-calls N`, `--sleep 2.0`.

## Troubleshooting

**`CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate`**

The python.org macOS installer ships a certificate bundle but does not activate
it, so Python starts with no root certificates. (`curl` still works, because it
uses the macOS system trust store — the network itself is fine.) Run the
installer's own script once:

```bash
/Applications/Python\ 3.14/Install\ Certificates.command
```

Match the version number to your Python. The script also falls back to
`certifi` automatically if it is installed, so `python3 -m pip install certifi`
fixes it too.

**`401 Unauthorized`** — the key was rejected. Check `echo $COMTRADE_API_KEY`
is set in the shell you are actually running from, and that you subscribed to
the free "Comtrade - v1" product.

**`429` repeatedly** — you hit the free tier's daily cap. Everything already
fetched is cached; re-run tomorrow and it resumes.

## Output files

Two workbooks — one per partner scope — with the commodity groups as tabs:

| Workbook | Tabs |
|---|---|
| `data/lithium_trade_world.xlsx` | `chemicals_ore` · `cells_batteries` · `coverage` · `_notes` |
| `data/lithium_trade_bilateral.xlsx` | same four tabs |

`chemicals_ore` and `cells_batteries` carry the identical 36-column schema, so
the two tabs stack cleanly if you want one long table. `coverage` shows what
data actually came back; `_notes` restates the caveats below, so the workbook
still explains itself once it's been emailed on without this README.

Matching CSVs are written alongside and are the **authoritative copy**:

```
data/chemicals_ore_world.csv        data/chemicals_ore_bilateral.csv
data/cells_batteries_world.csv      data/cells_batteries_bilateral.csv
data/coverage_summary.csv
```

Excel caps a sheet at 1,048,576 rows, and the bilateral pull can exceed that —
8507.60 alone is very large once every reporter × partner pair is included. If a
group overflows, the script splits it across continuation tabs
(`cells_batteries`, `cells_batteries_2`, …) and prints a warning. No rows are
dropped, but for anything that big the CSV is the better working file.

Use `--format xlsx` or `--format csv` to write only one of the two.

One row per reporter × partner × flow × commodity × year. Flows are `M` import,
`X` export, `RX` re-export, `RM` re-import.

**Do not stack the world and bilateral workbooks** — bilateral rows sum to the
world rows, so combining them double-counts.

## Commodity codes

### Group 1 — chemicals and ore (`upstream`)

| Code | Description | Data from | Purity |
|---|---|---|---|
| 2530.90 | Mineral substances n.e.c. — where spodumene/petalite/lepidolite land | 1988 | mixed |
| 2836.91 | Lithium carbonate | 1988 | pure |
| 2825.20 | Lithium oxide and hydroxide | 1988 | pure |
| 2805.19 | Alkali metals other than sodium — lithium metal | 1988 | pure |
| 2827.39 | Chlorides n.e.c. — lithium chloride | 1988 | mixed |

### Group 2 — cells and batteries (`batteries`)

| Code | Description | Data from | Purity |
|---|---|---|---|
| 8507.60 | Electric accumulators; lithium-ion | **2012** | pure |
| 8507.80 | Electric accumulators; other — holds li-ion before 2012 | 1988 | mixed |
| 8506.50 | Primary cells and batteries; lithium | **1996** | pure |

## Caveats that will bite you

**There is no HS code for lithium ore.** Spodumene concentrate is reported under
2530.90, "mineral substances not elsewhere specified", alongside vermiculite,
perlite and other unrelated minerals. For Australia this code is overwhelmingly
spodumene and works as a proxy; for most other reporters it is mostly noise.
Comtrade only goes to 6-digit HS, so the national 8-digit lines that *do* isolate
spodumene (e.g. Australia's 2530.90.90) are not reachable here — go to the ABS
directly for those.

**8507.60 breaks in 2012.** The lithium-ion subheading was created in HS2012.
Any li-ion series that appears to start at zero before 2012 is an artefact of the
classification, not a real trade collapse. Use 8507.80 as a rough pre-2012
bridge, remembering it also contains every other non-lead-acid battery chemistry.

**8506.50 starts in 1996**, when HS1996 restructured heading 8506 by chemistry.

**Reporting lags are uneven.** Not every country has filed for the most recent
year or two. Check `coverage_summary.csv` before reading a recent-year decline as
real — it is usually missing reporters. There is no annual 2026 data yet.

**Mirror statistics disagree.** A's reported exports to B rarely equal B's
reported imports from A (valuation, timing, transhipment, confidentiality). The
`is_reported` column distinguishes genuinely reported values from Comtrade's own
estimates.

**Lithium chemicals are frequently confidential.** Chile and Argentina have
suppressed or aggregated lithium lines in some years.

## Column dictionary

### Keys and dimensions
`period`, `year`, `freq`, `reporter_code` (UN M49), `reporter_iso3`,
`reporter_name`, `partner_code` (0 = World), `partner_iso3`, `partner_name`,
`partner2_iso3`, `flow_code`, `flow_desc`, `cmd_code`, `cmd_desc`

### Analytic groupings
Added by this script, not by Comtrade:

- `li_group` — `ore_concentrate`, `chemical_carbonate`, `chemical_hydroxide`, `chemical_other`, `metal`, `cell_battery`
- `li_stage` — `upstream`, `midstream`, `downstream`
- `code_purity` — `pure` (the code is essentially all lithium) or `mixed` (lithium is a minority of a basket code)

`code_purity` is the most useful filter in the file. Restricting to `pure` gives
you the series you can defend in print.

### Measures
`trade_value_usd` (primary value), `cif_value_usd`, `fob_value_usd`,
`net_weight_kg`, `gross_weight_kg`, `qty`, `qty_unit`,
`unit_value_usd_per_kg` (derived: value ÷ net weight),
`lce_tonnes`, `lce_factor`, `lce_basis`

### Provenance and quality
`hs_revision` (H0–H6), `is_original_classification`, `is_reported`,
`is_aggregate`, `is_qty_estimated`, `legacy_estimation_flag`, `retrieved_at`,
`source`

## On the LCE columns

`lce_tonnes` converts net weight to tonnes of lithium carbonate equivalent, and
is populated **only** where the HS code is chemically pure enough for the number
to mean something. Basket codes and battery codes get a blank, never a fabricated
value.

| Code | Factor | Basis |
|---|---|---|
| 2836.91 Li₂CO₃ | 1.0000 | 1:1 by definition |
| 2825.20 LiOH | 0.8809 | **assumes LiOH·H₂O** (battery grade). Anhydrous LiOH would be 1.5426 |
| 2805.19 Li metal | 5.3227 | code also carries small Rb/Cs volumes |

The 2825.20 factor is the one assumption worth revisiting: the code mixes
monohydrate, anhydrous hydroxide and lithium oxide. Trade is overwhelmingly
monohydrate, so 0.8809 is the right default, but it is an assumption and
`lce_basis` records it on every row.

## Codes deliberately excluded

Available if you want them added — say the word:

- **2826.90** (LiPF₆ electrolyte salt, LiF), **2833.29** (lithium sulphate),
  **2841.90** (cathode active material — LCO/NMC), **2850.00** (LiH, LiAlH₄) —
  all large baskets where lithium is a small and inconsistently classified share
- **8549.13 / .14 / .19** — battery scrap and black mass. Real recycling signal,
  but HS2022 only, so a 4-year series rather than a 36-year one
- **2845.30** (lithium-6 enriched) — fusion/nuclear, almost entirely confidential
- **2904.33** (lithium perfluorooctane sulphonate) — a surfactant, unrelated to
  the battery chain
