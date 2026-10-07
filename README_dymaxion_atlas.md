# Dymaxion atlas — animated globe → flat map → interactive case studies

`index.html` plays a ~30-second shot and then turns into a map you can
use. It reads two CSVs: one of bilateral trade, one of case studies.

```bash
python3 python_scripts/serve.py 8412
```

Then open <http://localhost:8412>. It has to be served over
http — ES modules will not load from `file://`.

Use that script rather than `python3 -m http.server`: it sends `no-store`, so a
plain reload always picks up your edits. Without it browsers hold on to ES
modules, and you get a page stitched from old and new files — the symptom is
things quietly not working (a button with no handler, a layer that never
appears) rather than an error. If you do end up with a stale page, hard refresh
with `Cmd+Shift+R` (Chrome/Firefox) or `Cmd+Option+R` (Safari).

URL shortcuts while working on it: `?intro` skips the landing page and plays
the shot, `?flat` goes straight to the interactive map.

## The landing page

The page opens on the title, the globe centred beneath it turning inside a cage
of trade routes, the case studies fanned out as a rolodex down the right, and
an **Enter** button at the bottom. Nothing starts until Enter is pressed.

The routes are the current year's largest flows, lifted off the surface so they
read as orbits. Dots travel along them, evenly spaced so each route still reads
as a dotted line while it flows. The slerp happens in the vertex shader from
the route's two endpoints, so nothing is re-uploaded per frame.

**Colour carries direction**: a dot leaves its origin in the export colour
(`--export`, navy) and arrives in the import colour (`--import`, orange),
with a quick handover in the middle. It is one shipment, counted at both ends —
which is also why `FLOW_DIRECTION` exists.

**Drag the globe** to turn it — it is a free trackball, not just a spin about
the pole, so you can look at any face of it. It drifts on its own again once
you let go.

The rolodex is a drum you can **scroll, drag or arrow through**; it snaps to a
card. The card at the front is the live one — clicking it opens that case study
there and then, before entering. Clicking any other card brings it to the front
first.

Opening a case study turns the globe so that place faces you, slides it into
the left half of the screen and shrinks it a little, opens the panel across the
right half, and runs a dashed line from the spot on the globe to the panel. The
turn is a yaw about the pole followed by a tilt in the plane that holds the
pole, so the axis stays upright instead of rolling. Dragging takes back control;
closing the panel lets it drift again.

Pressing Enter picks the globe up mid-turn — the shot inherits the rotation the
landing page had reached, so there is no jump.

## The title

The landing's masthead is a single `#title` layer holding two things: the
lithium tile in the upper-left corner and the heading set in three lines down
in the lower left, with Enter beneath it. Keeping them in one element means the
opacity that fades the title fades the mark with it, so the intro and the
case-study handlers have one thing to drive rather than three.

### Reserving the column

The globe is sized from the viewport **height** and the masthead needs
viewport **width**, so a tall narrow window grows the globe straight through
the type: at 1024x900 the heading overlapped it by 51px and at 900x820 by 66px,
while 1024x768 was comfortably clear. Nudging a constant cannot fix that — the
two scale off different axes.

`frameCamera` already reserved a band along the bottom for the timeline, so the
left column works the same way: `keepLeft` is a fraction of the viewport width
that the subject must stay clear of, and the horizontal limits become
one-sided, exactly as `keepClear` makes the vertical ones. The band itself is
measured from the elements — the heading is `clamp()`-sized and rewraps — and
re-measured on resize and once the webfont lands, never per frame, because
reading a rect forces layout.

Two things that are not obvious:

- **The band is not re-centred, and it does not carry `margin`.** `keepClear`
  shifts the target as well as tightening the limit, which is right for the
  bottom strip but wrong here: it walks the globe off centre into the rolodex.
  `keepLeft` only tightens. It also measures the raw extent, because `margin`
  is already slack around the subject — multiplying the band by it as well
  counts the same allowance twice and shrank the globe *below* what it was with
  no reserve at all.
- **The intro carries it too**, released on the same curve as the title fade.
  Without that the globe jumps the instant Enter is pressed, because the
  landing holds the column and the shot's first frame would not. Measured, the
  jump is now 0.0022 world units.

With `LANDING_MARGIN` at 1.52 the globe is as large as a centred globe can be
without reaching the type. Measured from the camera distance — a pixel scan
reads the orbiting route dots, which scatter well past the sphere and are not
what is being cleared:

| viewport | globe | clearance |
| --- | --- | --- |
| 1024x768 | 449px | 26px |
| 1024x900 | 448px | 47px |
| 900x820 | 379px | 42px |
| 1600x800 | 576px | 178px |

The globe is centred to the pixel at every one. 26px is the tightest the
arrangement allows: making the globe larger at 1024x768 means the heading
moving, shrinking, or being overlapped.

### When it goes

The title sits on the landing page, as plain HTML, and fades out
across the faceting — `TITLE` in `src/config.js` sets which phase it goes on
and where in that phase. It is deliberately measured against a *phase* rather
than against the clock: it used to be hard-coded to "hold until 4s, gone by
6s", which matched the original pacing and then left the title still up well
into the unfold the moment the opening phases were shortened. While a case study is open on the
landing it goes entirely, and the Enter button goes with it: the globe is
swinging up and left and a panel is opening on the right, the study is the
thing to read, and Enter would take you off the page in the middle of it. Both
come back when the study closes. `TITLE.studyDim` is what is left of the title
— 0 by default; raise it to leave the title faintly up instead, in which case
the globe passes **in front of it**, which is what the stacking below is for.

The CSS transitions do the easing, so `onStudy()` only names the state. The
Enter button's rule has to turn off `pointer-events` along with the opacity, or
it stays clickable while invisible, and it is declared after `#landing > *` —
that rule turns pointer events back on for every child of the landing and
matches `#enterBar.away` with the same specificity, so order decides it.

Getting the globe in front of HTML takes two things, because a canvas with an
opaque clear can only ever be the back layer:

- The renderer is built with `alpha: true` and clears to `--surface` at **zero
  alpha**, onto a `body` already painted the same colour. This is free: the
  sheet is opaque, so its pixels come out identical either way — measured, the
  ocean is `230,228,216` and the land `212,206,188` with the clear at 0 or at
  1. Only the area outside the sheet changes, from the clear colour to the page
  showing through in that same colour.
- `#title` leaves `.hud` and sits at the top level with `z-index: 0`, under the
  canvas at `z-index: 1`. It has to leave: `.hud` is `position: fixed`, which
  makes its own stacking context, so no `z-index` on a child of it could ever
  reach below the canvas.

There are three layers, and all three need naming explicitly: title (0), canvas
(1), interface (2). Giving the canvas a `z-index` at all lifts it over every
positioned element with `z-index: auto`, which is the whole interface — and
because the canvas now clears transparent, the interface still *looks* right
while the canvas quietly swallows every click and scroll. `.hud` therefore
carries `z-index: 2`. Worth knowing that this failure is invisible in a
screenshot and invisible to `element.click()` in the console, which bypasses
hit-testing; it only shows up under a real pointer.

## The map's outline

The net's 46 cut edges are drawn as one thin ink line, so the sheet reads as a
cut piece of paper rather than as wherever the land happens to stop. It fades
in across the settle phase, because the outline only means anything once the
sheet is flat.

It needs no warp. The deformation is zero along those edges by construction
under either mode — the elastic solve pins them, the analytic field holds them
to zero (see "The border stays put") — so the geometry is built once from
`BOUNDARY` and never touched again.

It does need the sheet's **pose**, which is easy to miss. `setPose` carries the
whole sheet on a transform that only reaches its resting value when `present`
hits 1 at the very end of the settle — the sheet is still turning to face the
camera throughout, 0.49 away from rest as the settle begins. An outline left in
the z = 0 plane is therefore in the wrong place for the whole of the settle and
snaps into alignment at the last moment, which reads as the map glitching just
as it comes to rest. `setBorder` copies the transform off the sheet each frame
instead. Once the fold is open every piece carries that same matrix, so copying
one of them is enough — and the copy sits inside the visibility check, so it
only costs anything while the outline is actually drawn.

It was briefly a band of type orbiting the globe in WebGL, and then a static
line across its equator with the globe covering the middle. The second one is
the better idea and the page cannot hold it: the rolodex takes the right third
of the landing and overlaps the globe itself, so at the globe's own size the
line has about 628px to work with and the globe hides 60% of it — you get
"Unfol" and nothing on the right. Making it work needs the globe at roughly
half its size, or the rolodex narrowed. Both are in the git history if the
landing is ever reproportioned.

Two things learned there that would apply again:

- **The scene's up is not the screen's.** The landing camera sits at roughly
  `(0, -4.6, -1.7)` looking back along `+Y`, with up near `(0, -0.34, 0.94)`.
  Anything built on world axes to sit "across" the view comes out edge-on;
  take the basis from the camera.
- **Perspective shrinks whatever you park behind the globe** before it is
  compared against the silhouette, by `d / (d + depth)` with `d` about 4.93.
  Sizing by the world figure alone tucks the ends behind the globe.

## The shot

### A seam between two eased phases

`introShot` builds `present` — how far the sheet has turned to face the camera
— from two smoothstepped terms, one tied to the unfold and one to the settle.
Butted end to end they share a zero-rate instant: the shot eases out, stands
still for a beat, and eases in again, which reads as a hitch just before the
map comes to rest. It is invisible in the driven quantities, because every one
of them is perfectly smooth; what gives it away is the *rate*. Rendering the
intro frame by frame and taking the mean pixel change between neighbours shows
it plainly — with a 6s unfold against a 4s settle the profile ran

```
10.4:2.52  10.7:1.58  10.8:1.45   <- slows almost to a halt
11.2:2.24  11.6:2.71  12.4:3.12   <- and speeds up again
```

The settle term now starts `SETTLE_LEAD` seconds early so the two gestures
overlap. How bad the seam looks depends on how much the two phases differ in
length, which is why it only appeared once the pacing was retimed — worth
re-running the measurement after any change to `PHASES`.

That fixed the camera and left the same fault in the **sheet**, which took a
second pass to find. `present` does not only swing the camera round; it is also
passed to `sheet.setPose`, so it turns the sheet itself. Overlapping the two
terms was not enough, because the settle term was a smoothstep and a smoothstep
peaks in the middle of its own window — at t≈11.8 here, well after the last
hinge closes at 10.5. So the sheet eased to a near stop as the fold finished
and then picked up a second, accelerating turn:

```
10.45  sheet=0.494    10.55  sheet=0.360   <- slows to a near stop
10.70  sheet=0.388    11.95  sheet=0.525   <- and starts again
```

The settle term is now an ease-*out* (`1 - (1-u)²`), fastest where the fold is
still carrying the motion and decaying from there, so the two hand over without
the sheet ever stopping. Its rate is still zero at the end, so it arrives at
rest. Measured again, the sheet's rate decays monotonically from 0.563 at the
end of the unfold all the way to the stop, with no rise anywhere.

Measuring this needs care in two ways. The camera and the sheet have to be
timed separately — the camera profile was already clean while the sheet was
not. And a scalar summed across the pieces hides it: pieces moving opposite
ways cancel, which invented a stall at t≈7.7 that does not exist (the real
rate there runs 4.037, 4.024, 4.012). Sum the absolute change per piece.

One stall remains, at the facet/unfold boundary: the solid finishes hardening,
stops dead (rate 0.005) and then the net starts falling open (rising to 3.46).
That one may well be wanted — it is the beat between "twenty gnomonic faces"
and "the net falls open" — so it is left alone.


| # | Phase | What happens |
|---|-------|--------------|
| 1 | A globe | Textured sphere, slowly turning, decelerating to a stop |
| 2 | Twenty gnomonic faces | The sphere deflates onto the icosahedron's faces |
| 3 | The net falls open | Faces hinge apart down the fold tree |
| 4 | One flat sheet | The sheet turns to face the camera |
| 5 | Rescaled by trade | The grid deforms by the selected metric |
| 6 | Flows and case studies | Ribbons, country nodes and case-study pins fade in |

Skip jumps to the end; once there the same button replays. The phase captions
in the table drive the timing but are no longer drawn on screen.

## Then it is a map

- **Year** slider across whatever years the trade file holds, plus a play loop.
- **Layers**: one toggle per `li_group` in the file; they double as the legend
  and show that layer's total and route count for the selected year.
- **Scale the map by**: exports, imports, total trade, or net exports — this is
  the grid deformation. Countries that trade more push the grid outward and
  take up more of the sheet; under *net exports*, importers shrink instead.
- **Deformation** slider, from a true Dymaxion (0%) to heavily warped (100%).
- Hover a node for its exports and imports; click it to isolate its flows.
  Click a white dot for a case study; Escape closes it.
- Scroll to zoom, drag to pan.

---

# Configuration

Everything tunable lives in **`src/config.js`**, in the order below. Nothing
else needs editing to change inputs, filtering, pacing or styling.

## Inputs

| Variable | Default | What it does |
|---|---|---|
| `TRADE_CSV` | `data/chemicals_ore_bilateral_v4.trimmed.csv` | Bilateral trade. Any file with the same column names works. |
| `CASE_STUDY_CSV` | `data/case_study_data.csv` | One row per case study. |

### Trade CSV schema

The columns actually read are `year`, `reporter_name`, `partner_name`,
`flow_desc`, `li_group`, `code_purity`, `is_reported`, `is_aggregate`, and
whichever column `VALUE_FIELD` names. Everything else in the file is ignored,
and column order does not matter. The semantics are the ones documented in
`data/chemicals_ore_bilateral_CustodyCard.md`:

- `flow_desc` is `Import` or `Export`, and says *who filed the record*, not
  which way the goods went. An import filed by Albania about partner Austria
  means Austria → Albania. The loader resolves this.
- `is_aggregate` is `true` on World rows; those are always dropped.
- `reporter_name` and `partner_name` are Comtrade's English labels, not ISO
  codes, so they are matched to map names (see *Naming countries*).

### Which product codes are included

Five HS codes carry data in the trade file. Two of them are *residual baskets*
— codes that mean "everything else in this part of the schedule" — and the
file's own `code_purity` column marks them `mixed`:

| HS code | Layer | What the code covers | Included |
| --- | --- | --- | --- |
| 2836.91 | Lithium carbonate | Carbonates; lithium carbonate | whole |
| 2825.20 | Lithium hydroxide | Lithium oxide and hydroxide | whole |
| 2805.19 | Lithium metal | Alkali metals other than sodium | whole |
| 2530.90 | Ore & concentrate | *Mineral substances n.e.s. in chapter 25* | **filtered by origin** |
| 2827.39 | — | *Chlorides of metals, other than calcium/ammonium* | **dropped** |
| 8507.60 | — | Lithium-ion accumulators | **dropped** |

**Two codes are gone entirely**, removed from `COMMODITY_GROUPS`, which drops
their rows and their menu entries. 2827.39 because lithium chloride is one of
many metal chlorides in it, so the series said more about industrial chemicals
than about lithium. 8507.60 because this file carries no rows for it at all —
the layer could only ever read "no flows". Four layers remain.

**2530.90 is filtered by origin**, via `ORE_BASKET_ORIGINS`. Spodumene
concentrate is conventionally reported in this code, but so is a lot of
unrelated mineral material, and it is the largest single code in the file —
taking it whole means more than half of what the map draws might not be
lithium at all.

The allowlist was not chosen from memory. A real lithium-ore exporter has its
value concentrated in the boom years, so every origin's series was profiled.
The countries kept have at most 17% of their 2530.90 value before 2017 and at
least 70% from 2021 on, peaking 2022-2024. The ones left out look the opposite
way round: Spain peaks in 2005, Morocco in 2008, Norway in 2004 — other
minerals moving, not lithium. Portugal is the telling case at 97% pre-2017,
because Covas do Barroso is a *proposed* mine, not an operating exporter.

Three of the kept origins — South Africa, the UAE and Argentina — have no
spodumene mine but boom-shaped series, so they are ore *moving* rather than
ore mined: Zimbabwean concentrate ships via Durban, and the UAE is a
transshipment point. Those arrows should be read as the port, not the pit.

Between them the two changes take the file from $129.6bn to $101.3bn of
charted value, a 22% cut, dropping 203 origins from the ore basket. Set
`ORE_BASKET_ORIGINS` to `null` to take the basket whole again, or use `PURITY`
= `'pure'` to drop 2530.90 along with every other mixed code.

### Trimming the trade CSV

The raw pull is ~105 MB and 360k rows, of which the page keeps 30,437 and
folds those into 29,892 flows. Everything else is dropped before anything is
drawn, so the repo ships the trimmed file rather than the raw one — the full
pull is past GitHub's 100 MiB per-file limit, and 92% of it never reaches the
screen. `python_scripts/trim_trade_csv.py` applies the same filters offline:

```bash
python3 python_scripts/trim_trade_csv.py
```

That writes `data/chemicals_ore_bilateral_v4.flows.csv` — one row per
`(year, li_group, origin, destination)` with the values summed, which is
exactly the bucket `loadTrade` builds and all the page ever reads. **1.7 MB,
1.7% of the original.** `--rows` instead writes the surviving rows of the
original file with every column intact (8.5 MB), which is bigger but keeps
detail the buckets throw away.

The script does not reimplement the filters from memory. It parses the
constants out of `src/config.js` and the valid place names out of the world
atlas the page loads, so it cannot quietly drift. It prints the same three
numbers the browser console logs on every load, and they should match:

```
359,545 rows read, 30,437 kept, 29,892 flows
```

Checked harder than that: the per-country export totals for the latest year
agree with the running page to the dollar (China 965,613,997, Chile
783,389,699, USA 138,399,917).

One caveat. *Which* rows survive depends on `VALUE_FIELD`, because a row is
dropped when that field is not greater than `MIN_FLOW_VALUE`. The flows output
sums all three value columns so you can switch fields afterwards, but the
selection is the one the current config implies — changing `VALUE_FIELD`,
`PURITY`, `FLOW_DIRECTION` or `YEAR_RANGE` means running it again.

The page is not wired to read the trimmed file; it still streams the full one.
Pointing `TRADE_CSV` at the flows output would need `loadTrade` changed too,
since the column names differ.

### Primary source documents

Documents kept in the repository are previewed *in* the page rather than opened
on someone else's site. Put files in `documents/` and register each one in
`DOCUMENTS` in `src/config.js`:

```js
export const DOCUMENTS = [
  { study: 'Jadar', file: 'jadar-eia-2021.pdf', label: 'Environmental impact assessment, 2021' },
];
```

That mapping is the only thing that ties a file to a case study and to the name
a reader sees. A file sitting in `documents/` and not listed there appears
nowhere — a static page cannot read a directory, so there is nothing to scan.

- **study** — the case study's `name` exactly as the CSV spells it. Rename a
  study there and this has to be renamed too. Unlike `CASE_STUDY_PLACES`, which
  fails loudly by dropping the study off the map, a stale name here fails
  quietly: the study still appears, just with no documents. The mapping is
  therefore checked once at load and anything pointing at a name no case study
  has is named in the console.
- **file** — the filename inside `documents/`. Subfolders are fine.
- **label** — written for a reader, not for a filesystem.

They appear in the case-study panel under *Primary sources*, above the
`primary_source_*` links from the CSV, which now sit under *Primary sources on
the web*. Clicking one opens a viewer over the page with the document, its
filename, an *Open in new tab* link and a close button; Escape, the close
button or a click on the backdrop all dismiss it.

| extension | how it shows |
| --- | --- |
| `.pdf` | inline, in the browser's own PDF viewer |
| `.png` `.jpg` `.jpeg` `.webp` `.gif` `.avif` `.svg` | inline as an image |
| `.txt` `.md` `.csv` `.json` | fetched and shown as plain text |
| `.html` `.htm` | inline in a frame |
| anything else | a download link, because no browser renders `.docx` or `.xlsx` without a converter |

Two details worth keeping if this is edited. The viewer empties its frame when
it closes, or a PDF keeps its plugin alive behind the page. And its Escape
handler uses `stopImmediatePropagation`, not `stopPropagation`: the drawer has
its own Escape handler on `window`, and plain `stopPropagation` does not stop
another listener on the *same* target, so one press closed the viewer and the
case study behind it together.

### What is actually in `documents/`

Of the 13 `primary_source_*` links in the CSV, only a handful are documents
that can be downloaded and redistributed. The rest are web pages — a newspaper
behind a paywall, NGO press releases, a company page, a campaign homepage — and
several refuse automated requests outright (SEC EDGAR, ZimLII, CourtListener
and the Oakland Institute all answer 403 or a bot challenge). Those stay as
links under *Primary sources on the web*, which is the right place for someone
else's copyrighted page.

What is held locally is public-record material: two legal and community
documents for Argentina Puna, and for Jadar the EU Commission decision and the
project information pack.

### Case-study CSV schema

`name`, `location`, `conflict_years`, `impact_categories` (comma separated),
`area`, `summary`, `testimonial`, `testimonial_name`, `testimonial_title`,
`source_1`, `source_2`, `primary_source_1`…`primary_source_3`.

`testimonial_name` is who said the quote and `testimonial_title` describes who
they are. Both present, both appear under the quote — the name first, the
description under it. Only one present, that one appears alone. Neither, and
there is no attribution line at all. Missing columns behave like empty ones, so
adding them to the CSV is enough; nothing else needs changing. The quote's
source is not shown.

Empty fields are simply left out of the panel, so a half-filled row still
works.

The file carries no coordinates, so each study is placed by `CASE_STUDY_PLACES`
(below). Optional `lon`, `lat` and `country` **columns** override that if you
would rather keep the position in the CSV.

## Reading the trade

| Variable | Default | What it does |
|---|---|---|
| `FLOW_DIRECTION` | `'import'` | `'import'`, `'export'` or `'both'`. Comtrade files most shipments twice — once by each side — so `'both'` knowingly double counts. Importer-reported rows are the fuller record in this file (~214k rows vs ~146k). |
| `VALUE_FIELD` | `'trade_value_usd'` | The magnitude of a flow. `'net_weight_kg'` and `'lce_tonnes'` also work; axis labels and the number formatting follow `VALUE_FORMAT`. Note `lce_tonnes` is only populated where `code_purity` is `pure`. |
| `INCLUDE_ESTIMATES` | `true` | Keep rows where `is_reported` is `false` — Comtrade's own estimates rather than country filings. They are about half the file. |
| `PURITY` | `'all'` | `'pure'` restricts to codes that are unambiguously lithium; `'mixed'` does the opposite. The custody card calls this the most useful filter in the file. |
| `YEAR_RANGE` | `[null, null]` | Clamp the years, e.g. `[2015, 2025]`. |
| `MAX_FLOWS_PER_GROUP_YEAR` | `25` | Ribbons drawn per layer per year, largest first. The file holds a few thousand country pairs a year, which is unreadable as ribbons. **Node sizes, the deformation and the case-study panel still use every row** — this only limits what is drawn. |
| `MIN_FLOW_VALUE` | `0` | Drop flows below this, in whatever `VALUE_FIELD` counts. |
| `COMMODITY_GROUPS` | 4 entries | The `li_group` values to show and their labels — ore & concentrate, carbonate, hydroxide, metal. All four are on by default and the *Layers* dropdown turns them on and off; colour does **not** follow the group (see "Layers and colour"). Delete an entry to drop that layer; add one if your file has a group these don't cover. |

## Naming countries

The trade file identifies places by name, and those names have to match
`world110m.js` to get a position on the map.

| Variable | What it does |
|---|---|
| `NON_COUNTRIES` | Labels that are not places (`World`, `Areas, nes`, `Bunkers`, …). Rows touching one are dropped. |
| `COUNTRY_ALIASES` | Comtrade label → map name, e.g. `'USA' → 'United States of America'`. About twenty entries cover everything above a rounding error. |
| `EXTRA_PLACES` | Trading places with no polygon in `world110m.js` — Hong Kong, Singapore, Gibraltar and similar — as `[lon, lat]`. |
| `PINNED_PLACES` | Mainland pins for countries whose polygon centroid lands in the wrong ocean because of overseas territories (France, the USA, Chile, …). |

Anything still unmatched is dropped, and the browser console lists the labels
with how many rows each cost, so you can decide whether to add it. With the
bundled file the leftovers are micro-states and island territories with
negligible lithium trade.

## Case-study placement and photographs

`CASE_STUDY_PLACES` maps a study's `name` to `{ lon, lat, country, image }`.
`country` ties the study to the trade data and drives the exports panel in its
drawer, so it must be one of the mapped country names. The six studies in the
bundled CSV are already placed.

`image` is a filename inside `CASE_STUDY_IMAGE_DIR`, which is
`images/case_studies/`. Drop photographs in there with these names:

| Case study | File |
|---|---|
| Thacker Pass / Peehee Mu'huh | `thacker-pass.jpg` |
| Salar de Atacama | `salar-de-atacama.jpg` |
| Argentina Puna | `argentina-puna.jpg` |
| Jadar | `jadar.jpg` |
| Covas do Barroso | `covas-do-barroso.jpg` |
| Buhera | `zimbabwe.jpg` |

`CASE_STUDY_PLACES` is keyed on the study's `name` **as the CSV spells it**, so
renaming a study in the CSV means renaming the key too — otherwise it has no
position and `loadCaseStudies` drops it with a console warning, which looks
like a case study quietly vanishing from the map and the timeline. That is
what happened when "Zimbabwe" became "Buhera".

Rename them in the config if you'd rather; `.png` and `.webp` work too, just
put the extension in the config entry. Landscape crops around 1200 x 800 suit
both places the picture is used: a wide band behind the rolodex card, and a
3:2 hero at the top of the case-study panel. A study whose file is missing
renders without a picture and names the file it looked for in the console —
nothing breaks, so you can add them one at a time.

The panel leads with the **testimonial**, set large, with whoever said it
underneath; the summary follows, then the facts, then that country's real
exports for the selected year, then sources.

Two of them — Salar de Atacama and Argentina Puna — are about 200 km apart and
their markers overlap until you zoom in. That is the projection being honest.

## The shot and the map

### The landing page

| Variable | Default | What it does |
|---|---|---|
| `LANDING.arcs` | `54` | How many flows orbit the globe. |
| `LANDING.maxPerOrigin` | `3` | Arcs from any one exporter. Without a cap the whole cage sprays out of whichever country trades most. |
| `LANDING.dotsPerArc` | `30` | Dots in flight along each route; they are what space it out into a dotted line. |
| `LANDING.minAltitude` / `maxAltitude` | `0.10` / `0.62` | How far a route lifts off the surface, as a fraction of the globe's radius. Varied per route so the cage has depth. |
| `LANDING.dotSize` | `[2.0, 4.6]` | CSS px, scaled by the size of the flow. |
| `LANDING.speed` | `[0.035, 0.085]` | Trips per second along the route, varied per route. |
| `LANDING.spinRate` | `0.055` | Radians per second the globe turns while waiting. |
| `ROLODEX.step` | `20` | Degrees of drum between one card and the next. |
| `ROLODEX.radius` | `232` | px from the drum's axis to a card — how far it swings. |
| `ROLODEX.card` | `[266, 92]` | Card size in px, before perspective magnifies it. |
| `ROLODEX.perspective` | `1500` | px. Lower exaggerates the drum, higher flattens it. |
| `ROLODEX.wheelSensitivity` / `dragSensitivity` | | How far a scroll or a drag turns the drum. |

Three constants in `src/main.js` set the framing, all as a fraction of the
viewport's width: `LANDING_OFFSET` (0, the globe centred), `STUDY_OFFSET`
(0.25, a quarter-screen left while a case study is open) and `STUDY_MARGIN`
(2.1, how much smaller the globe goes to clear the panel — its on-screen
diameter is the viewport height divided by the margin, so 2.1 leaves it only
slightly smaller than the 1.95 it sits at otherwise).

### The shot and the map

| Variable | Default | What it does |
|---|---|---|
| `PHASES` | 6 phases, 26.5s | `[id, seconds, caption]`. Edit the seconds and the camera, the progress bar and the captions all follow. |
| `TITLE` | `fadePhase: 'facet'` | When the title goes, as a fraction of a named phase rather than as a clock time, so retiming `PHASES` carries it along. `studyDim` is what is left of it while a case study is open. |
| `TIMELINE` | `yearMs: 620`, `studyDwellMs: 3200`, `dash: 22` | The year axis along the bottom of the finished map. `yearMs` is how long an ordinary year holds while it plays; `studyDwellMs` is the longer hold on a year a case study starts in, so the card can be read. `studyYear` pulls the start year out of the CSV's free-text `conflict_years` ("2017-present" gives 2017) — change it if you add a proper date column. |
| `KEEP_CLEAR_PX` (main.js) | `184` | How much of the screen bottom the framing leaves free, so the timeline and its tiles do not sit on top of the map. In pixels, because the strip it clears is a fixed size; eased in over the settle phase so nothing snaps. |
| `ROUTE_DOTS` | `perRoute: [3, 30]`, `speed: 0.42` | Trade routes on the flat map, as travelling dots rather than ribbons. Volume shows as density, not thickness. `speed` is net units per second so every dot moves at the same pace on screen whatever its route's length. `trackOpacity` above 0 brings back a faint line beneath them. |
| `TEXTURE_WIDTH` | `8192` | Width of the equirectangular canvas the globe and the map share (2:1, so the height is half). Clamped to the GPU's maximum at runtime. 4096 is about where the 50m coastlines stop gaining; 8192 pays off with the 10m tier or when zooming the finished map. |
| `MESH_SUBDIVISION` | `56` | How finely each face is divided for *drawing*. Under `mode: 'elastic'` the deformation is solved on its own, coarser mesh (`ELASTIC.subdivision`) and baked into a texture, so this now controls how smoothly the drawn sheet samples that field rather than the field itself. `FACE_GRID.divisions` should divide it. |
| `WARP.mode` | `'elastic'` | `'elastic'` solves the map as a sheet of material; `'field'` is the original closed-form sum of per-source pushes, kept for comparison. See "Precision of the scaling". |
| `ELASTIC` | see file | The elastic sheet. `subdivision` is the mesh the *solve* runs on (not the one that is drawn); `foundation` and `reach` are the locality knobs; `gain` is a calibration left at 1 on purpose. Every field is annotated in `src/config.js` with what it is worth. |
| `WARP.tail` / `WARP.reach` | `2.0` / `2.6` | Only under `mode: 'field'`. How fast a source's pull decays outside its disc, and how many radii out it stops entirely. `tail: 1` with no cutoff is the classic Dougenik 1/r, which drags the whole map. |
| `PEEL` | `0.25` | How much of the unfold staggers the hinges, 0 to ~0.9. At 0 every hinge opens in lockstep; raising it makes the hinges near the root lead and the outer ones follow, so the sheet peels instead of splaying all at once. Each hinge still travels the full dihedral angle, eased across its own slice of the window, so the net still closes exactly onto the globe. Raising it shortens each slice, so raise the `unfold` phase with it. |
| `SPIN_RATE` | `0.2` | Radians per second the globe turns at the start, easing to a stop. |
| `DEFAULT_YEAR` | `null` | `null` uses the latest year in the file. |
| `DEFAULT_METRIC` | `'total'` | Which metric the deformation starts on. Its control is hidden — see "TEMPORARY: a cut-down panel". |
| `DEFAULT_DEFORMATION` | `0.75` | Where the strength slider starts, 0–1. The slider is hidden — see "TEMPORARY: a cut-down panel". |
| `WARP` | see file | `grow`/`shrink` set how much the biggest trader swells and how much a net importer contracts, and `maxSources` is how many countries get a term — both apply to either mode. `maxOffset` and `borderHold` apply only to `mode: 'field'`; under `'elastic'` the silhouette is pinned in the solve instead. |
| `CAMERA_FOV` | `40` | Degrees. |
| `NODE_SIZE`, `RIBBON_WIDTH` | `study: 30` | Marker and ribbon scaling. `study` is the sprite a case study's white dot and outline are drawn inside, and also sets its click radius — the visible dot is a little over half of it. |
| `CATEGORIES` | 4 entries | Case-study impact categories and a colour each. Drives the *Highlight* toggles, the dash and tile colours, and the heat blobs. |
| `HEAT` | `radius: 0.30`, `peak: 0.86` | The soft field of category colour around each case study, in place of the ring the markers used to wear. `radius` is in net units (the sheet is ~5.8 wide), so the blob covers a region of the map and scales with it. `falloff` is the Gaussian exponent — raise for a tighter core. `coreGain` darkens the dense centre of a blob, which on cream reads as "more". See "Case studies as a heat field". |

## Colour

The palette is in "The look" below. The orbiting dots on the landing page use
`--export` and `--import` to show which way a shipment is going, and
case-study markers on the map are plain white — the one value nothing else
uses, so they read as the human layer on top of the trade.

Colour no longer distinguishes one commodity from another — see *Layers and
colour* below. The per-commodity custom properties in `index.html`
(`--ore`, `--carbonate`, `--hydroxide`, `--metal`) still exist because each
group's `token` is how `src/main.js` builds the `catColor` map, and that map
doubles as the switched-on-layers gate in `src/flows.js` (`if
(!catColor.has(f.cat)) continue`). The colours it carries only reach the route
ribbons, which are drawn at zero opacity. `--cells` is left over from the
removed battery layer.

---

## The look

Cream paper, navy ink, hairline rules — a technical drawing rather than a lit
globe. The map's ocean *is* the page colour, so coastlines read as drawn
instead of as the boundary between two fills, headings are set in the mono
face, and panels are hairline boxes with no shadow.

| | |
| --- | --- |
| page, and the sea | `#f2efe2` |
| land | `#e6dfca` |
| ink: coastlines, type, rules | `#183152` |
| exports | `#375d81` |
| imports, and focus | `#fd832e` |
| accent | `#f20806` |

It is one palette, defined once as custom properties on `:root` in
`index.html`. The page briefly carried two — this one and a dark
"brine" palette — behind a switch in the panel, which is gone; the dark values
are in the git history if they are ever wanted.

Three things copy colour out of the cascade and would have to be updated with
it: the WebGL clear colour, the shader uniforms (sheet edge and grid, overlay
ink, export/import), and the base-map texture, which bakes token values into
an 8192-wide canvas. They are read once at startup from `tokens()` in
`src/main.js`.

Watch for colours hard-coded for a dark page when editing. Moving to the light
palette turned up four: the rolodex cards had a near-black veil under what had
become navy type, the drawer's "case study" badge was white on white, the
Enter button was near-black type on a mid-navy fill, and `--salt` is now ink
rather than near-white, so anything using it as "the bright colour" inverts.

## Highlighting case studies by category

Case studies carry an `impacts` list, and `CATEGORIES` in `src/config.js` maps
six of those onto colours:

| Category | | studies |
| --- | --- | --- |
| Water Use | `#375D81` blue | 2 |
| Ecological | `#557153` green | 3 |
| Indigenous Rights | `#6A4C93` violet | 2 |
| Displacement | `#FD832E` amber | 3 |
| Foreign-Owned Mine | `#1F6F6B` teal | 4 |
| Economic | `#F20806` red | 2 |

Four of those hexes come from the supplied palette, which was drawn up when
there were four categories. `Indigenous Rights` and `Foreign-Owned Mine` came
later, and their colours are chosen to sit in the same register — saturated,
mid-dark, legible on cream — rather than taken from it.

The **order** of `CATEGORIES` matters as much as the colours. A study usually
carries several impacts, and with no filter on it takes the colour of the first
one in the list that it has, so the order decides each study's resting colour.
The list is grouped land, people, money, which also happens to spread the seven
studies across five different colours rather than giving four of them the same
one. `Economic` never leads, because both studies carrying it also carry
`Foreign-Owned Mine`, which sits above it.

Most studies carry several impacts — Salar de Atacama has three — so which one
supplies the colour cannot simply be the first one listed. `studyCategory()`
takes the first *selected* category a study matches when a filter is on, and
the first it lists otherwise. Without that rule, filtering for Indigenous
Rights lights Salar de Atacama in the Water Use blue it happens to list first,
which reads as a bug rather than as a site that is both. The map, the dashes and the tiles all
call the same function, so they can never disagree about what colour a study
is.

The *Highlight* field toggles categories on and off; `state.cats` holds the
selected set, empty meaning "all". A study is in the highlight when the set is
empty or its impacts intersect it (`inHighlight()`), and that one predicate
drives four surfaces:

- **Heat blobs** — full intensity in the highlight, `HEAT.lift` (1.18×) when a
  filter is on, and `HEAT.dim` (0.18×) outside it. The blob keeps its hue when
  dimmed; only the intensity answers to the filter.
- **Map dots** — in-highlight dots are white and grow to 1.25× when a filter
  is active; the rest shrink to 0.7× and are pulled 55% toward the ordinary
  node colour, so they step back without becoming invisible. A dimmed study is
  still a clickable site, and its click radius does not shrink with the dot.
- **Timeline dashes** — each dash is stroked in its category colour always, and
  drops to 0.28 opacity when outside the highlight.
- **Timeline tiles** — each tile gets a 3px category top border, and drops to
  0.4 opacity when outside.

Nothing is removed, so the shape of the timeline and the distribution of
markers stay readable; the selection only changes what is emphasised. Clicking
a category runs `rebuild()`, `drawAxis()` and `paintTiles()` — the map needs a
rebuild because colour, size and intensity are baked into the node and blob
lists.

## Case studies as a heat field

A case study used to be a ringed, slowly pulsing marker. It is now a soft field
of its category colour — a heat blob — with a small **white dot** at the site,
so there is one crisp thing to find and aim at inside the wash. White is the
one value no other mark on the map uses, which is what separates a case study
from a country node at a glance.

The dot has no outline. Its alpha falls off over a short distance instead
(`smoothstep(0.34, 0.18, r)` of the sprite radius), so the blob behind shows
through at the edge and the white grades into the site's own category colour
rather than sitting on top of it as a separate mark. A scanline through
Buhera's dot runs `255,255,255` at the centre out through `243,200,136` and
`236,169,71` to the amber of the blob.

Shrinking the dot costs nothing in usability, because the click radius comes
from `NODE_SIZE.study` (30) and not from what is drawn — the hit area is more
than three times the width of the visible dot.

The blob is **one quad per study, sized in net units** (`HEAT.radius`, 0.30 of
a sheet about 5.8 wide, so roughly a 15-degree arc) rather than a point sprite
sized in pixels. Two reasons:

- A heatmap is a claim about a *region*, so its extent should scale with the
  map rather than hover above it at a fixed screen size.
- `gl_PointSize` is capped by the driver — 511px on this machine — and a blob
  this large would hit the ceiling and silently stop growing as the camera
  closes in.

The falloff is Gaussian, shifted and rescaled so density is exactly 1 at the
centre and exactly 0 at the rim. Without that shift the wash ends on a visible
circular edge, which is the ring the change was meant to remove. Overlapping
blobs compound through ordinary alpha blending — `1-(1-a₁)(1-a₂)` — so clusters
read hotter, which is the behaviour you want and, unlike additive blending,
works on a cream page as well as a black one.

Intensity is a **gain on the category colour**, not a blend toward some hot
colour, so the hue survives and the four categories stay apart at the core.
`HEAT.coreGain` darkens the core, which on cream reads as "more"; darkening on
a light page has no ceiling. Brightening on a dark one did, which is why the
value had to be tiny when the page was dark — over black the alpha falloff is
already a luminance ramp, so real brightening only clipped the pale
categories, and lifting `#ABC8E2` by even 0.2 pinned its blue channel at 255
and turned the core white.

Each quad is displaced by the warp sampled **at its centre**, not per corner
(`warpOffset(aCentre, aHold)` in `HEAT_VS`). A blob therefore slides with its
site and stays circular instead of shearing when a nearby trade source pulls
the grid; because the marker's vertex shader samples the warp at the same point
with the same hold factor, the core and the blob cannot drift apart. Verified
at 100% deformation.

The layer renders at `renderOrder` 5, below the ribbons (10), the route dots
(15) and the markers (20), so it reads as part of the map rather than as
something floating over the trade.


## The border stays put

When the grid deforms, only the interior moves. The sheet keeps exactly the
silhouette it was unfolded with and could still be folded back into a globe —
countries distend, the outline does not. The cut edges are emitted by the build
tool (`boundary` in `src/dymaxion-data.js`).

How that is enforced depends on `WARP.mode`:

- **elastic** (default) pins every vertex lying on a cut edge, so those points
  are simply not free to move. The constraint is structural rather than a
  taper, and it is also what makes the deformation behave: a pinned silhouette
  fixes the sheet's total area, which is why the targets are normalised to sum
  to it (see "Precision of the scaling").
- **field** multiplies the displacement by a hold factor that falls to zero at
  the edge. It depends only on where a point sits on the undeformed net, so it
  is baked once into an `aHold` vertex attribute rather than recomputed per
  frame. `WARP.borderHold` sets how wide the held band is.

The `aHold` attribute is still built under either mode so the two can be
swapped, but the elastic path ignores it — tapering a field that is already
zero at the edge would shrink the deformation near the silhouette past what the
material actually does.

---

## Every piece shades the same

The net's 22 pieces are not all wound the same way — 11 have positive signed
area in net coordinates and 11 negative, 59 wedges against 61. That is a
property of the net (half the pieces are mirrored), not a mistake in it.

Emitting their triangles in plain lattice order carries that straight into the
geometry, and the sheet then renders as two populations. `DoubleSide` draws
them either way, so nothing disappears, but `gl_FrontFacing` comes out false
for the mirrored half; the fragment shader flips their normal to face away
from both lights, both terms clamp to zero, and those pieces shade at `0.80`
against `1.02` for the rest. On screen that is whole triangles of the map
sitting at a visibly darker grey — and on the globe it is worse, because there
the flip points the normal into the sphere, so half the faces were lit as if
from inside.

`buildSheet` now reverses the winding for mirrored wedges, so every triangle
faces the same way. Sampling a grid over the flat sheet before and after: two
ocean values (`13,20,22` and `10,16,18`) and two land values (`42,57,59` and
`36,50,52`) collapse to one of each.

If this ever comes back, the symptom is a *piecewise* difference — whole net
triangles, following the piece boundaries — rather than a gradient. A gradient
would be the lighting working as intended.

---

## The projection

The icosahedron is in R. Buckminster Fuller's Dymaxion orientation — vertex 0
at 2.3008820° N, 5.245390° W with an adjacent vertex at azimuth 7.46658°, the
orientation with no vertex on land. Points are projected gnomonically onto the
face they fall on, which is what makes the sphere and the flat sheet the same
surface.

**The net is Fuller's own, read back off his published map.** It is neither a
net a search found nor the "canonical" band-and-caps net every paper
icosahedron uses. Both of those were tried and neither matches: a free search
prefers compact pinwheels, and the band-and-caps family (60 of them, all
non-overlapping) puts the continents in the wrong left-to-right order.

**It is also not a net of 20 whole triangles.** Fuller's outline turns at
triangle centroids and edge midpoints, which means his cuts run along medians:
two of the twenty faces are cut and their pieces placed in different cells.
That is what gives the real map its stepped edges, and it is why no unfolding
into whole triangles can reproduce it. Splitting each lattice cell by its three
medians into six wedges represents the map exactly — 120 wedges, 6 per face,
no remainder — which comes out as **22 rigid pieces**: 18 whole faces, one face
in two halves, and one face as a two-thirds quad plus a one-third triangle.

`FULLER_PIECES` in `python_scripts/build_dymaxion.py` holds it, as
`(row, column, points_down)`, the wedges of that cell that are present, and
which icosahedron vertex sits at which corner of the cell. The layout, the fold
tree and every hinge follow from that table. It was recovered rather than
guessed: the lattice was measured off Fuller's own outline, and one anchor then
fixes every cell's face by rolling the solid along the shared half-edges. The
winning anchor agreed 93% on land against 72% for the runner-up — short of
100% only because Fuller's projection is not quite gnomonic.

The 22 pieces share exactly 21 edges, so the net is a spanning tree with no
redundant seams. Both pieces of a split face fold onto that one face from
different directions, which is checked on every build: 66 corners land on the
icosahedron to within 1e-15. Cutting those two faces lets the remaining cuts
stay at sea, so the land cut cost is 355 — below the 370 floor for any net of
20 whole triangles, which is the whole point of Fuller's "one-world island".

Reading left to right it gives Fuller's order: Australia, Africa and Asia,
Europe, Greenland, North America, South America, Antarctica.

Because pieces are not faces, the projection works per wedge:
`geo.js` carries `NET_CELLS`, every wedge with its net corners and the same
corners as barycentric coordinates on its face, and `sphereToNet` /
`netToSphere` map through whichever wedge contains the point. Round-tripping
5000 random directions agrees to 1e-15.

Two older nets are kept behind flags, for comparison:

```bash
python3 python_scripts/build_dymaxion.py --preview /tmp/net.png
python3 python_scripts/build_dymaxion.py --whole        # 20 whole triangles
python3 python_scripts/build_dymaxion.py --canonical    # band-and-caps instead
```

`--whole` uses `FULLER_CELLS`, the same arrangement approximated with 20 whole
triangles (the two split faces placed whole, positioned to keep the net
connected). It loses only the stepped edges.

`canonical_net()` builds that fallback from `NET_AXIS` (which of the 6 opposite
vertex pairs) and `NET_CUT` (where the band of 10 is cut). `orient_sheet()`
then turns it in its own plane: it lays the band horizontal first and only then
picks between the two ways up, by which one puts the northern hemisphere at the
top. Scoring "north up" and outline shape against each other instead lets a
tilt win on the north term and hands back a net rotated 45–60°. Fuller's own
layout skips this, because the lattice already carries its orientation.

A third option, a free search, is kept behind a flag:

```bash
python3 python_scripts/build_dymaxion.py --search      # explore alternatives
```

The search scores all 30 icosahedron edges against a 1° land mask and looks for
a depth-first fold tree whose 11 cut edges stay at sea, whose land sits near
the middle of the sheet, and whose outline fits `ASPECT`. It is not the
canonical net and is only there to explore alternatives. Antarctica is
weighted down to 6%, because Fuller's own net cuts it up too — that weight is
for scoring only, and must not double as a presence test: multiplying it by
the cos(latitude) cell area and then skipping cells below a threshold once
punched a 10-degree hole in the mask around the South Pole. Either way the
result is verified to fold back onto the icosahedron to within 1e-15 before it
is written out.

**The grid on the map is the icosahedron's own subdivision**, not a graticule:
each face is split into a triangular lattice — `FACE_GRID` in `src/config.js`
sets the divisions per edge (4) and the opacity (set it to 0 to hide the grid
without touching any geometry). Latitude and longitude sit at an angle to the
geometry this projection is built on, so they told you nothing useful about it;
only the equator survives, as a reference line. The lattice is drawn from
barycentric coordinates in the shader, so it follows the grid deformation.

```bash
python3 python_scripts/build_dymaxion.py --preview /tmp/net.png
```

That regenerates `src/dymaxion-data.js` (12 vertices, 20 faces, the net's 2-D
coordinates, the fold tree with its hinges, and the alignment matrix) and writes
a PNG of the layout. The knobs are at the top of that file — the random seed,
## Coastline detail

The globe and the flat map are both the same equirectangular canvas, so detail
comes from two places: how fine the coastline data is, and how big that canvas
is. No imagery is involved — it is filled country polygons with a stroked
coast.

**Tiers.** Natural Earth ships three, all public domain, and all three are in
the repo as `world110m.js`, `world50m.js` and `world10m.js`. Swapping tiers is
one line in `index.html`:

```html
<script src="world50m.js"></script>
```

| tier | file | vertices | countries | load |
| --- | --- | --- | --- | --- |
| 110m | `world110m.js` | 8,246 | 177 | instant |
| **50m (default)** | `world50m.js` | **80,617** | 241 | ~0.6s |
| 10m | `world10m.js` | 477,295 | 255 | ~1.5s |

50m is the default: ten times the detail of 110m for 739KB, and about where a
4096-wide canvas stops gaining. 10m is worth it if you zoom into the finished
map, and costs about a second more to parse and a few tenths of a millisecond
per frame — nothing structural.

Every country name is identical across the tiers, which is what makes the swap
safe: the trade joins in `COUNTRY_ALIASES` and every `country` in
`CASE_STUDY_PLACES` keep matching. The finer tiers also carry exactly one
globe-sweeping land ring, so the Antarctica pole closure is unaffected. Both
were checked before switching, because either would have broken quietly.

**Canvas size.** `TEXTURE_WIDTH` (8192, a 2:1 canvas) is clamped at runtime to
whatever the GPU reports as its maximum, so asking for more than the hardware
allows is safe rather than a blank map. 8192 is about 23 pixels per degree.

**Mesh.** `MESH_SUBDIVISION` (32) is the geometric side of the same question:
it is how finely each face is divided, which sets how closely the sphere and
the gnomonic warp are followed between vertices. It has nothing to do with the
coastline — it governs the shape, not the drawing. 32 gives about 22,000
triangles across the 22 pieces. `FACE_GRID.divisions` should divide it.

## Precision of the scaling

The map is deformed by solving it as a sheet of elastic material, not by
summing pushes. Each of the net's 120 wedges is divided into a grid of small
triangles and welded into one mesh of 8,917 vertices, 26,196 lines and 17,280
triangles; the silhouette is pinned; every line is a spring with its own
elastic modulus and every triangle carries a target area taken from the trade
data. Relaxing that mesh is what moves the map.

### Why the old field was replaced

The original warp was the classic Dougenik cartogram force — each source
pushing outward, linear inside its radius and decaying as R/r outside, summed.
It had been localised already (a steeper tail, a hard cutoff at `WARP.reach`
radii, more and smaller sources), which brought the share of the sheet that
moves down from ~100% to about a third. But two problems were structural
rather than a matter of tuning:

**It folded the map.** Nothing in a sum of pushes knows there is material in
between, so where sources crowd, the field drags one part of the sheet through
another. Measured on the real export sources, it turned **201 triangles inside
out at the default strength and 555 at full**. That is visible as coastline
smeared across itself.

**It did not actually control area.** A source's disc ended up whatever size
the summed pushes happened to leave it, and the error ran in the wrong
direction: a country asked to grow 2.3× came out at **3.49×**. The map was
overstating the very differences it exists to show.

### What the elastic solve does instead

A triangle's own area target fights back long before it can turn inside out,
and the area is the constraint rather than a side effect. Measured on the same
real sources, across the export, import and net metrics:

| at full strength | field (old) | elastic (new) |
| --- | --- | --- |
| inverted triangles | 555 | **0** |
| area error, on the countries that actually scale | 30% | **24%** |
| share of the sheet that moves | 32% | **28%** |
| peak displacement | 0.387 | 0.106 |

The remaining 24% is a systematic *under*statement — a country asked for 2.3×
comes out nearer 1.5×, where the old field gave 3.49×. Understating a
difference is the safer error for a data graphic, and `ELASTIC.gain` exists to
trade it back if you disagree; see the config notes for why it is 1.

### Where the locality comes from

Two per-line properties, rather than a distance cutoff:

- **the elastic modulus**, higher away from the data, so far-off material is
  stiff and simply does not take up the strain; and
- **an elastic foundation**, which ties each vertex to where it started with a
  stiffness that rises as you leave the sources behind.

The foundation is what does most of the work: turn it off and 69% of the sheet
moves; at 0.15 with `reach` 2.2 it is 28%. The modulus contrast alone is worth
only a couple of points. Both are in `ELASTIC`.

### What it costs, and how it reaches the GPU

The solve runs on the CPU when the data changes — never per frame. A cold
solve is about **95ms**; every later one warm-starts from the previous answer
and takes **35–45ms**, which is what makes playing the timeline (a new year
every 620ms) affordable. The strength slider never triggers a solve at all:
the sheet is always solved at full strength and the slider scales the result,
which tracks a direct solve to within about 1.6 points of area error and
inverts nothing at any setting.

The result is baked into a 1024×512 half-float displacement texture over the
net's bounding box, and `warpOffset` in every shader is a single fetch from it.
`warpPoint`, the CPU twin that positions markers and does hit testing,
bilinearly samples the very same grid of numbers — so the map and the things
drawn on top of it cannot drift apart. Measured at full deformation, a case
study's marker lands **0.36 px** from where the GPU draws it.

Because the silhouette is pinned in the solve, the baked field is already zero
on the cut edges, so the shader does not apply the `aHold` taper (see "The
border stays put"). The attribute is still built, so `WARP.mode` can be flipped
back to `'field'` to compare the two without pulling anything out.

### Two things worth knowing if you re-tune this

**Tune on more than one metric.** The `net` metric puts strong shrinkers right
next to strong growers, and it is far harder than the others. Raising
`ELASTIC.gain` to 1.8 looks like a clear win on exports alone — area error
halves — while taking `net` from 0 inverted triangles to 186.

**Watch which average you read.** Most sources ask for a scale very near 1, so
a median area error across all of them is dominated by sources that are
trivially satisfied and reads as about 2% whatever the solver is doing. The
number that means anything is the error on the handful of countries that
actually ask for scaling.

## The key

A single tall column beside the map, 186px wide: the title, the four impact
categories stacked one per row, the direction key and Replay.

Its middle sits a third of the way down the page — `PANEL_AT` in
`src/main.js`, where 1/2 would centre it — and `top` is set by `placePanel()`
rather than by CSS. A percentage `top` with a translate cannot know about the
timeline strip along the bottom, and a column this tall runs into the
case-study cards on a short window: centred, it overlapped them by 35px at
1024x680 and 65px at 1280x620. `placePanel()` puts it on the line and then
clamps it clear of the same band the map reserves (`KEEP_CLEAR_PX`), so it
lands exactly where asked when there is room and rides up only when there is
not. It measures the panel rather than assuming a height, because the heading
rewraps with the viewport, and runs again once the webfont has landed.

## TEMPORARY: a cut-down panel

Three controls are hidden while the piece is shown on fixed settings — the
layer picker, *Scale the map by*, and the *Deformation* slider. What is left is
the title, the *Highlight* categories, the direction key and *Replay*, in a
panel narrowed from 268px to 232px. The heading reads "The Dymaxion Map".

The settings they would have offered are the defaults: all four product layers
on, scaled by **total trade**, deformation **75%**.

Nothing is deleted. The markup and all of its wiring are untouched; the three
fields carry a `temp-off` class and one CSS rule hides them, so removing that
rule and the three classes brings them back working. `DEFAULT_METRIC` and
`DEFAULT_DEFORMATION` in `src/config.js` are now pushed *into* the select and
the slider at startup rather than being duplicated in the markup, so the
controls cannot drift out of step with the config while nobody can see them.

## Layers and colour

**Every product layer is on by default.** The panel's `Layers` control is a
dropdown, not a row of chips: it reads "All products" until you narrow it, then
names the layer or counts them ("3 of 5 products"). Each row carries that
layer's value and route count for the selected year, which is what the old
coloured chips were really communicating.

One layer always stays on — otherwise the map would have nothing to draw and
the only way back would be the menu you had just emptied. The one kept is
whichever currently carries the most value, rather than whichever was clicked
last, so it is never a layer that happens to be empty for the selected year.

**Colour means one thing only: direction.** Nothing is coloured by commodity
any more. A dot leaves its origin in the export colour and arrives in the
import colour, interpolated along the route, so every arrow reads as a
direction of travel — the same idea as the orbits on the landing page. The
`Direction` key in the panel — two dotted swatches, Exports and Imports — is
the whole legend.

That is why the dots carry an `aProg` attribute (0 at the origin, 1 at the
destination) rather than a colour: the mix happens in the shader from two
uniforms, which is one float per dot per frame instead of three, and it keeps
the gradient smooth as a dot travels.

## Trade routes as travelling dots

The routes on the flat map are drawn the way the orbits on the landing page
are: streams of moving dots rather than ribbons. **Volume reads as density** —
a busy route carries more dots, not a thicker line.

`ROUTE_DOTS` in `src/config.js` holds the knobs. The ribbon mesh is still
there and `trackOpacity` above 0 brings it back as a faint track beneath the
dots; at 0 its geometry is not even built.

**Density has to be logarithmic.** Trade values here span five orders of
magnitude — the busiest drawn route is about 50,000x the median — so scaling
density by the value, or even by its square root, pins all but a handful of
routes at the minimum. Measured: the square root gave 3 dots to everything
below the 90th percentile. A log scale over the range of the routes actually
drawn gives a real spread, currently a median of 15 dots per path against a
maximum of 30.

**The dots step on the CPU, and that is deliberate.** A route is a great
circle projected into the net and broken at the cut edges, so it is a
polyline, not something a shader can walk analytically the way `orbits.js`
slerps between two points on a sphere. Each run becomes a path with cumulative
arc length and every dot is a cursor along one; `advanceDots()` moves them.
Two details make it cheap: each cursor only ever moves forward, so walking it
is O(1) amortised, and `borderHold` is sampled once per path vertex and
interpolated with the position, so the warp never has to be re-solved for a
moving point. About 1,900 dots cost 0.2ms a frame, and the warp still happens
in the shader, so the dots deform with the sheet like everything else on it.

## The timeline

Once the map is flat, the year axis runs along the bottom instead of sitting in
the panel as a slider. Case studies appear on it as dashes at the year their
conflict starts, and you can scrub it, drag it, arrow-key it, or press play.

Every dated study has its own small tile standing above the axis, always
visible — a thumbnail, the name and the place.

**The tiles are deliberately uniform**, 124x84 each: one line of title, one of
subtitle, and the photo's frame is always there — so a study whose image is not
in `images/case_studies/` yet leaves an empty frame rather than a shorter tile.
The row reads as a row.

Two things are shortened for the tiles **and nowhere else** — the panel, the
rolodex and the map tooltip all keep the full text:

- `TIMELINE.shortNames` overrides a title too long for a tile. "Thacker Pass /
  Peehee Mu'huh" shows as "Peehee Mu'huh"; add more as needed.
- `TIMELINE.shortPlace()` makes the subtitle from the study's **country**, via
  `TIMELINE.countryShort` for the two whose atlas names do not fit ("United
  States of America" to "USA", "Dem. Rep. Congo" to "DR Congo"). Where the
  country would merely repeat the title, the year stands in instead; drop that
  check in `buildCards` if you would rather it always said the country. It is
  not firing at the moment — it existed for the study then called "Zimbabwe",
  which is now "Buhera", so the subtitle is the country again.

Clicking a tile opens the full panel; hovering or focusing it, or the playhead reaching its year, makes it
*live*: its tile, its dash and its connector pick up the accent colour, and a
dashed leader line joins it to that place on the map.

**The tiles cannot each sit exactly over their own dash.** The studies cluster
in 2017-2024, so at any readable width the tiles overlap. `layoutCards()`
therefore starts each tile where its dash is, walks left to right pushing
overlapping neighbours apart, pulls the run back if it has overflowed the right
edge, and then draws a connector from each tile down to the dash it belongs to.
Studies sharing a year (2017 and 2024 both hold two) get adjacent dashes
`TIMELINE.dashGap` apart and adjacent tiles.

At the map stage the sheet lies in the world z = 0 plane and a node's *warped*
net coordinates are its world coordinates, so `updateMapLeader()` points the
line at exactly the marker the map drew — deformation and all. `drawLeader()`
clamps the place's screen position into the target's box, which lands on the
nearest point of its edge, so the same code serves a small tile below the map
and the wide panel out to the right.

The intro's own transport — the progress bar and Skip — is hidden once the map
arrives, both because the bottom strip belongs to the timeline and its tiles
and because the panel already offers **Replay**.

Replay goes back to the landing page, Enter button and all, not to the first
frame of the shot — replaying the piece should mean replaying the piece. The
landing branch of the frame loop reasserts the pose, the facet, the halo, the
orbits and the warp every frame, so `toLanding()` only has to undo what
`enter()` and `finish()` set once: the panel, the transport, the timeline, the
focused country, any open study, and the clock the routes fade in against.

Three details worth knowing:

- **Studies can share a year.** 2017 holds two (Jadar, Covas do Barroso) and so
  does 2024 (Salar de Atacama, Buhera). Playback shows each in turn before
  stepping on, rather than only ever raising the first.
- **Playback is a chain of timeouts, not an interval**, because the hold on a
  study year is longer than on an ordinary one.
- **A missing photo has to be hidden twice over.** `img.hidden` alone does
  nothing here, because `.scard img { display: block }` outranks the browser's
  own `[hidden]` rule — hence the explicit `.scard img[hidden]`. And the error
  listener has to be attached *before* `src`, or a cached 404 fires before the
  listener exists and the tile keeps an empty strip where the photo should be.
  Both were real: the tiles for studies whose photos are not in
  `images/case_studies/` yet collapse to text only once both are in place.
- **A dismissed landing page used to swallow clicks along the bottom.**
  `#landing.gone` sets `pointer-events: none`, but `#landing > *` sets `auto`
  on its children, and a child that re-enables pointer events is hit-testable
  even when its parent has them off — so the invisible Enter bar kept eating
  clicks. Nothing had been there before the timeline, so it never showed.

### Case studies without a year or a place

Two of the seven rows in `data/case_study_data.csv` cannot be placed, and both
fail quietly by design rather than guessing:

- **Argentina Puna** has an empty `conflict_years`, so it gets no dash. It is
  still on the map and in the rolodex; give it a year and a dash appears.
- **Manono** is not in `CASE_STUDY_PLACES`, so it has no coordinates and is
  dropped from the map entirely, with a console warning from `loadCaseStudies`.
  Add `lon`/`lat` for it in `src/config.js` (or lon/lat columns in the CSV) and
  it joins the map and the 2017 group on the timeline.

**Reserving the bottom of the screen.** `frameCamera`'s `keepClear` drops the
target below the subject's centre, which lifts the map clear of the timeline
and its tiles. The vertical limits then have to be *one-sided* — the top edge
is the full half-height away, the bottom edge only as far as the reserved band
leaves. One symmetric limit measured from the lowered target counts the offset
twice: it solved for a distance about a third too far and left the map 45%
smaller than it needed to be, while still technically clearing the tiles. Worth
knowing because the map looked framed, just small.

**Two things that made the unfold judder**, both worth knowing because the
fixes are not obvious.

*The hinges.* Staggering them (`PEEL`) needs the ramp inside each hinge's
slice to be eased, not clamped-linear. A bare clamp gives every hinge a corner
at each end of its slice — it snaps into motion and snaps to a halt — and with
six depths that reads as a run of small jerks. Measured, the worst kink in
piece motion dropped 3.5x when the slices were eased. The fold handed to
`sheet.setPose` is therefore *linear* in time: `mesh.js` does the easing, and
easing in both places would compress each hinge's travel into the middle of
its slice and speed it up instead.

*The camera.* Solving the framing exactly every frame judders, because as the
pieces swing the silhouette grows and shrinks again, so the solved distance is
not monotonic — it ran 4.07, 4.10, 4.03, 4.09 and the camera dollied in, out
and in again. No causal filter fixes this: damping it smoothly lags and
*clips* the sheet (measured at 0.17 units with 4% headroom), and snapping
outward to avoid clipping puts a corner in the motion every time it switches
between the two rules. The intro is deterministic in `t`, though, so
`buildIntroPath()` solves the whole path up front and smooths it with an
envelope — for each sample the largest fit over a window, then averaged over
that window, twice. Every value averaged in is at least the fit at the sample
being written, so clipping is impossible however much it is smoothed; the
envelope is widened to cover both passes for exactly that reason.
`__atlas.checkFit()` walks the intro and reports the worst slack (0, i.e. it
touches the tightest fit and never goes under). Camera acceleration fell 3.4x
and jerk 3x, at the cost of framing 0.4% looser. `introShot(t)` holds the
per-time parameters so the live loop and the precomputed path cannot drift.

**Antarctica and the South Pole.** Natural Earth's Antarctica is one ring
traced from the antimeridian all the way round the coast and back, so it
sweeps the full 360 degrees of longitude. Closed in the plane, that draws a
straight edge back across the map at about 84.7S — which gives three separate
wrong things: the fill stops at that edge instead of reaching the pole (a cap
of "ocean" over the pole), point-in-polygon calls the pole sea, and the coast
stroke paints that edge as a false coastline across the interior.

Closing the ring *down through the pole* instead fixes all three at once and
gives the continent its real shape: the path follows the coast, then drops to
the bottom of the map and back. The coast is stroked as an open line, so the
synthetic part is never drawn. `buildBaseMap()` in `src/texture.js` does this
to the canvas (see `sweepsGlobe`), and `land_cells()` does the same to the
ring before sampling it. The two have to agree, or the map and the net's
scoring disagree about where the land is. Both assert that exactly one ring
sweeps the globe, so a different land file cannot silently skip the fix.

The indentations that remain are the Ross and Weddell embayments — real
coastline. Natural Earth classes the ice shelves as not-land, so they read as
sea; Fuller's own map fills them in as part of one solid mass.

the Antarctica weight in `land_cells()`, `ASPECT`, and the scoring weights in
`pick_net()`. Everything downstream follows from the one generated file.
Takes ~25s.

## Layout

```
index.html              page, styles, HUD markup
src/config.js                    EVERY tunable — inputs, filters, pacing, sizes
src/main.js                      scene, timeline, camera, picking, panel + drawer
src/orbits.js                    the landing page's dotted orbiting routes
src/data.js                      CSV streaming, filtering, aggregation
src/mesh.js                      the morphing sheet (sphere → icosahedron → net)
src/warp.js                      the deformation, as GLSL and as JS; picks the mode
src/elastic.js                   the elastic sheet: mesh, solve, displacement bake
src/flows.js                     ribbons, country nodes, case-study pins
src/geo.js                       Dymaxion projection (sphere -> net)
src/texture.js                   the equirectangular base map, painted to a canvas
src/topo.js                      minimal TopoJSON reader + spherical centroids
src/dymaxion-data.js             GENERATED — see python_scripts/build_dymaxion.py
documents/                       primary sources, previewed in the page
python_scripts/build_dymaxion.py the net search
python_scripts/trim_trade_csv.py cuts the trade CSV down to what the page reads
python_scripts/check_shaders.py  guards against a backtick inside a GLSL literal
vendor/                          three.js r169 + OrbitControls, vendored to run offline
world110m.js                     country outlines, loaded as a plain script
```

The one invariant worth knowing: when the animation ends, the sheet lies exactly
in the z = 0 plane in net coordinates. Everything drawn on top of the map —
ribbons, nodes, hit testing — works in those coordinates and runs through the
same warp function as the sheet, which is why the overlay stays registered with
the map when the grid deforms.

## Performance

The bundled trade file is 8.5 MB / 30,437 rows — the output of
`trim_trade_csv.py --rows`, which is the raw 105 MB pull with the 92% of rows
the page discards already removed. It is streamed and folded into (year, layer,
origin, destination) buckets as it arrives rather than held in memory as one
string, with a byte counter while it reads.

Smaller still is possible: `trim_trade_csv.py` with no flags writes the
pre-aggregated buckets at 1.7 MB. That needs different column names, so it is
not a drop-in; the `--rows` output is, which is why it is the one committed.

## Known rough edges

- An unfolded polyhedron has no single "north", so the sheet is only a best fit
  to north-up; Africa and Australia in particular sit at an angle. That is
  inherent to the projection; the trade-off lives in `orient_sheet()` in the
  build tool.
- The layer chips count every route in the data, while only the largest
  `MAX_FLOWS_PER_GROUP_YEAR` per layer are drawn.
- Interior fold edges still deform with the rest of the sheet; only the outer
  silhouette is held. Adjacent faces deform identically along a shared hinge,
  so the sheet stays continuous, but folding it back up would no longer be a
  rigid motion in the interior.
- Flow ribbons break wherever a great circle crosses one of the net's cut edges
  rather than jumping across the sheet — correct, but a flow can visibly stop
  at one edge and resume at another.
- `data/chemicals_ore_bilateral_v4.csv` has no `cell_battery` rows, so that
  layer shows "no flows"; the batteries live in a separate pull.
