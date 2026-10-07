# ============================================================
# CHAIN_OF_CUSTODY_AUDIT_CARD -- CELLS_BATTERIES_BILATERAL
# ============================================================
# RULES
#
#   1. Append-only. Never edit a past chain entry. Correct it by adding a new entry.
#   2. Every AI step names its model AND its exact prompt. No prompt, no audit.
#   3. Open issues carry forward. Never delete what you didn't fix.
#   4. Every number must trace to a file, a line of code, or a run.
#
# ============================================================


# ============================================================
# CURRENT STATE — what this file is right now
# ============================================================

title: Chemical Ores (Bilateral)
team: Run Club
version: 1

derived_from: none
format: CSV
rows: 412,070

source_type: Secondary collection
source: UN Comtrade API

human_edits: sorted to specific product codes
ai_edits: none

columns:
  - period: string, YYYY, stored as text so Excel cannot reformat it; identical to year in this annual-only pull
  - year: int, 1990–2026, numeric in the workbooks so it pivots correctly
  - freq: char, always A, would be M if monthly were ever enabled
  - reporter_code: int, UN M49 code, 1–899, not ISO numeric despite looking similar
  - reporter_iso3: string, 3-letter ISO, blank for a few Comtrade-only reporter aggregates
  - reporter_name: string, English label, punctuation and ampersands appear in some names
  - partner_code: int, UN M49 code, 0 means World
  - partner_iso3: string, 3-letter ISO, W00 means World
  - partner_name: string, English label
  - partner2_iso3: string, secondary partner for country of origin, almost always W00
  - flow_code: string, M X RX RM, M is import, X is export, RX is re-export, RM is re-import
  - flow_desc: string, English label of flow_code
  - cmd_code: string, 6-digit HS, stored as text so leading zeros survive and Excel does not right-align it
  - cmd_desc: string, HS description as returned by Comtrade
  - li_group: string, one of ore_concentrate chemical_carbonate chemical_hydroxide chemical_other metal cell_battery, added by the script
  - li_stage: string, one of upstream midstream downstream, added by the script
  - code_purity: string, pure or mixed, added by the script, the most useful filter in the file
  - trade_value_usd: int, current USD with decimals, this is primaryValue, FOB for exports and CIF for imports, never deflated
  - cif_value_usd: int, current USD with decimals, frequently blank, populated mainly on import rows
  - fob_value_usd: int, current USD with decimals, frequently blank, populated mainly on export rows
  - net_weight_kg: int, kilograms with decimals, blank or zero surprisingly often, which is what nulls out unit_value_usd_per_kg
  - gross_weight_kg: int, kilograms with decimals, blank for the large majority of rows
  - qty: int, count in whatever qty_unit says, blank where the reporter filed no quantity
  - qty_unit: string, usually kg, sometimes N/A or u for items
  - unit_value_usd_per_kg: int, USD per kg with decimals, derived as trade_value_usd divided by net_weight_kg, blank when net weight is missing or zero, wildly unstable on thin trade
  - lce_tonnes: int, tonnes lithium carbonate equivalent with decimals, populated only where code_purity is pure, deliberately blank elsewhere rather than fabricated
  - lce_factor: int, multiplier with decimals, 1.0 for 2836.91, 0.8809 for 2825.20, 5.3227 for 2805.19, blank for basket and battery codes
  - lce_basis: string, the assumption behind lce_factor, notably that 2825.20 is treated as LiOH monohydrate
  - hs_revision: string, H0 through H6, tells you which HS vintage the reporter filed under, changes mid-series for most countries
  - is_original_classification: boolean, true or false, false means Comtrade converted the code from another vintage
  - is_reported: boolean, true or false, false means the value is a Comtrade estimate rather than a country filing
  - is_aggregate: boolean, true or false, true on World rows
  - is_qty_estimated: boolean, true or false, applies to qty not to trade value
  - legacy_estimation_flag: int, 0 on nearly all modern rows, a legacy Comtrade marker
  - retrieved_at: string, ISO 8601 UTC timestamp, constant across a single run
  - source: string, constant label naming the API


assumptions:
  - Reporter countries reported numbers accurately

known_issues:
  - Some of the product codes include components that we are not concerned with:
    - 2836.91	Lithium carbonate
      - Clean
    - 8506.50	Lithium primary cells.	Mixed Li chemistries, all genuinely lithium
      - Clean.
    - 8507.60	Li-ion accumulators	All Li-ion, but spans coin cells → EV packs → grid containers. $/kg varies ~10×	
      - Clean but 2012
    - 2825.20	Li hydroxide	No foreign chemistry, but mixes LiOH·H₂O ~16.5% Li, anhydrous LiOH ~29%, and Li₂O	Good on value, approximate on tonnage
    - 2530.90	Spodumene, petalite, lepidolite	Celestite, strontianite, cryolite, earth colours, meerschaum, amber, arsenic sulphides. Plus the real lithium includes glass/ceramic grade, not just battery	
      - AUS and CHN only. Noise elsewhere
    - 2805.19	Lithium metal	Potassium, rubidium, caesium. Caesium's high $/kg distorts unit values. Widened in 2002 when strontium + barium folded in from 2805.22	
      - Direction only. 2002 break is structural
    - 2827.39	Lithium chloride	Ferric, zinc, cobalt, copper, tin, barium, potassium chlorides — commodity chemicals that dwarf LiCl by weight	
      - Direction only. Weakest code in the set
    - 8507.80	Li-ion before 2012	Pre-2012: Li-ion + NiMH + others. Post-2012: residual only — Na-S, zinc-air, flow, silver-oxide	
      - Bridge only. Meaning flips at 2012


intended_use: data viz project
not_for: market-based decisions
provenance_confidence: high


# ============================================================
# CHAIN OF CUSTODY — append-only, oldest first
#
# ============================================================

chain_of_custody:

  - step: 0
    holder: Run Club
    role: originator
    date: 2026-09-22
    action: pulled from UN Comtrade API

    ai_role: propose, wrote code to pull
    model: claude opus 5

    prompt: |
      Write me a script to pull data from the UN Comtrade on lithium. Before you start, I want you to suggest a schema for the csv that will be generated. The script should pull and structure data from 1990-2026 (or latest available). Before you begin, check with me for which codes we should include (give me a rundown of the different codes and what they indicate).

    input: none
    output: chemicals_ore_bilateral.csv
    changes: created csv from API response

    audit: |

    open_issues:
      - includes some product codes or years we don't want to pay attention to

  - step: 1
    holder: Run Club
    role: originator
    date: 2026-09-25
    action: Removed duplicated/extraneous columns: period, freq, reporter_code, reporter_iso3, flow_code, 

    ai_role: Used AI to write a python script which was then used to create a new CSV
    model: claude sonnet 5

    prompt: |
      Write me a quick script called drop_columns.py to take a csv and remove all columns specified in a given list. the script should ouptut a copy of the given csv with just those columns deleted. the three inputs of the script should be the csv to edit and the title of the csv to output and row names

    input: chemicals_ore_bilateral.csv
    output: chemicals_ore_bilateral_v2.csv
    changes: removes some extraneous rows 

    audit: |
      Audited the python script before running it to verify it completes only the expected operations

    open_issues:
      - includes some product codes or years we don't want to pay attention to

  - step: 2
    holder: Run Club
    role: originator
    date: 2026-09-25
    action: Removed years that we are not interested in 

    ai_role: Used AI to write a python script which was then used to create a new CSV
    model: claude sonnet 5

    prompt: |
      write me a quick script called specific_years.py to take a csv that has a column called year and delete all rows that fall out of a given year range. the script should ouptut a copy of the given csv with just those rows deleted. the two inputs of the script should be the csv to edit and the title of the csv to output

    input: chemicals_ore_bilateral_v2.csv
    output: chemicals_ore_bilateral_v3.csv
    changes: removes years outside the range 2020-2026 

    audit: |
      Audited the python script before running it to verify it completes only the expected operations

    open_issues:
      - includes some product codes we don't want to pay attention to

  - step: 3
    holder: Run Club
    role: originator
    date: 2026-09-25
    action: Removed re-import and re-export data 

    ai_role: Used AI to write a python script which was then used to create a new CSV
    model: claude sonnet 5

    prompt: |
      write me a quick script called drop_reexport.py to take a csv and remove all the rows where the value of the column flow_desc is either Re-import or Re-export. the script should ouptut a copy of the given csv with just those rows deleted. the two inputs of the script should be the csv to edit and the title of the csv to output. also note that I'm putting all the scripts in the python_scripts folder

    input: chemicals_ore_bilateral_v3.csv
    output: chemicals_ore_bilateral_v4.csv
    changes: removes rows where flow_desc is re-import or re-export 

    audit: |
      Audited the python script before running it to verify it completes only the expected operations

    open_issues:
