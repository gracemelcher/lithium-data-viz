// ===========================================================================
// Everything tunable about the atlas lives here.
//
// The two inputs are CSVs. TRADE_CSV follows the schema of
// data/chemicals_ore_bilateral_v4.csv (UN Comtrade bilateral, as documented in
// data/chemicals_ore_bilateral_CustodyCard.md); CASE_STUDY_CSV follows
// data/case_study_data.csv. Point either one somewhere else and the page
// follows, as long as the column names match.
//
// README_dymaxion_atlas.md describes each option in prose.
// ===========================================================================

/* ------------------------------------------------------------ inputs ---- */

export const TRADE_CSV = 'data/chemicals_ore_bilateral_v4.trimmed.csv';
export const CASE_STUDY_CSV = 'data/case_study_data.csv';

/* --------------------------------------------------- reading the trade --- */

/**
 * Comtrade files both sides of most shipments: an export filed by the seller
 * and an import filed by the buyer. Counting both double-counts trade, so pick
 * whose filing to believe.
 *   'import'  importer-reported rows (the fuller record here, and the default)
 *   'export'  exporter-reported rows
 *   'both'    everything, knowingly double counted
 */
export const FLOW_DIRECTION = 'import';

/** Which column carries the magnitude of a flow. */
export const VALUE_FIELD = 'trade_value_usd';     // or 'net_weight_kg', 'lce_tonnes'

/** How that column is written out. */
export const VALUE_FORMAT = {
  trade_value_usd: { unit: 'usd', label: 'trade value' },
  net_weight_kg: { unit: 'kg', label: 'net weight' },
  lce_tonnes: { unit: 't LCE', label: 'lithium carbonate equivalent' },
};

/**
 * Which origins count as lithium in HS 2530.90.
 *
 * That code is "mineral substances not elsewhere specified in chapter 25" — a
 * residual basket. Spodumene concentrate is conventionally reported in it, but
 * so is a lot of unrelated mineral material, and the basket is the largest
 * single code in the file. So it is filtered by origin rather than taken whole.
 *
 * The list was not chosen from memory. A real lithium-ore exporter shows its
 * value concentrated in the boom years, so each origin's series was profiled:
 * every country here has at most 17% of its 2530.90 value before 2017 and at
 * least 70% from 2021 on, peaking 2022-2024. The countries left out look the
 * opposite way round — Spain peaks in 2005, Morocco in 2008, Norway in 2004 —
 * which is other minerals moving, not lithium. Portugal is a telling one: 97%
 * of its value is pre-2017, because Covas do Barroso is a proposed mine, not
 * an operating exporter.
 *
 * Names are the world atlas's, i.e. after COUNTRY_ALIASES. Set to null to take
 * the basket whole again.
 */
export const ORE_BASKET_ORIGINS = new Set([
  'Australia', 'China',                       // the two largest, kept by hand
  // mined and exported: boom-shaped series, at most 17% of value before 2017
  'Zimbabwe', 'Brazil', 'Nigeria', 'Namibia', 'Mali', 'Ethiopia',
  'Madagascar', 'Rwanda', 'Mozambique', 'Uganda',
  'Dem. Rep. Congo', 'Congo',
  'Canada',                                   // spodumene from NAL and Tanco
  // Ore moving rather than ore mined: none of these three has a spodumene
  // mine, but all are boom-shaped, so the tonnage is lithium passing through —
  // Zimbabwean concentrate ships via Durban, the UAE is a transshipment point.
  // Read these arrows as the port, not the pit.
  'South Africa', 'United Arab Emirates', 'Argentina',
]);

/** is_reported === 'false' rows are Comtrade's own estimates, not filings. */
export const INCLUDE_ESTIMATES = true;

/** 'all' | 'pure' | 'mixed' — code_purity; 'pure' is the cleanest lithium. */
export const PURITY = 'all';

/** Clamp the year range, or leave null for whatever the file holds. */
export const YEAR_RANGE = [null, null];

/**
 * Ribbons drawn per commodity group per year, largest first. The file holds a
 * few thousand bilateral pairs a year, which is unreadable as ribbons; totals,
 * node sizes and the case-study panel still use every row.
 */
export const MAX_FLOWS_PER_GROUP_YEAR = 25;

/** Ignore flows smaller than this, in whatever VALUE_FIELD counts. */
export const MIN_FLOW_VALUE = 0;

/**
 * li_group values, in drawing order. `token` is the CSS custom property the
 * colour comes from; drop an entry to drop that layer from the page.
 */
// Two codes were dropped outright. HS 2827.39 (chlorides of metals other than
// calcium/ammonium) because lithium chloride is one of many metal chlorides in
// it, so the series said more about industrial chemicals than about lithium.
// HS 8507.60 (lithium-ion accumulators) because this file carries no rows for
// it at all — the layer could only ever read "no flows".
export const COMMODITY_GROUPS = [
  { key: 'ore_concentrate', label: 'Ore & concentrate', hs: '2530.90', token: '--ore' },
  { key: 'chemical_carbonate', label: 'Lithium carbonate', hs: '2836.91', token: '--carbonate' },
  { key: 'chemical_hydroxide', label: 'Lithium hydroxide', hs: '2825.20', token: '--hydroxide' },
  { key: 'metal', label: 'Lithium metal', hs: '2805.19', token: '--metal' },
];

/* ----------------------------------------------- placing the countries --- */

/**
 * Reporter/partner labels that are not places. Rows touching one are dropped.
 * Comtrade's "nes" entries mean "not elsewhere specified".
 */
export const NON_COUNTRIES = [
  'World', 'Areas, nes', 'Other Asia, nes', 'Other Europe, nes', 'Other Africa, nes',
  'Other America, nes', 'Special Categories', 'Free Zones', 'Bunkers', 'Neutral Zone',
  'Br. Antarctic Terr.', 'Fr. South Antarctic Terr.', 'Antarctica',
];

/**
 * Comtrade label -> the name the world atlas uses. Anything unmatched after
 * this is dropped, and the console names it with its trade value so you can
 * decide whether it is worth adding.
 */
export const COUNTRY_ALIASES = {
  'USA': 'United States of America',
  'Rep. of Korea': 'South Korea',
  "Dem. People's Rep. of Korea": 'North Korea',
  'Russian Federation': 'Russia',
  'Türkiye': 'Turkey',
  'Viet Nam': 'Vietnam',
  'China, Hong Kong SAR': 'Hong Kong SAR',
  'China, Macao SAR': 'Macao SAR',
  'United Rep. of Tanzania': 'Tanzania',
  'Dem. Rep. of the Congo': 'Dem. Rep. Congo',
  'Bosnia Herzegovina': 'Bosnia and Herz.',
  "Lao People's Dem. Rep.": 'Laos',
  'North Macedonia': 'Macedonia',
  'Brunei Darussalam': 'Brunei',
  'Bolivia (Plurinational State of)': 'Bolivia',
  'Rep. of Moldova': 'Moldova',
  'State of Palestine': 'Palestine',
  'Iran (Islamic Republic of)': 'Iran',
  'Syrian Arab Republic': 'Syria',
  'Venezuela (Bolivarian Rep. of)': 'Venezuela',
  'Curaçao': 'Curacao',
  'Western Sahara': 'W. Sahara',
  'Sudan (...2011)': 'Sudan',
  'Serbia and Montenegro (...2005)': 'Serbia',
  'Equatorial Guinea': 'Eq. Guinea',
  'Eswatini': 'eSwatini',
  'Cayman Isds': 'Cayman Islands',
  'Solomon Isds': 'Solomon Is.',
  'Faroe Isds': 'Denmark',
  'Netherlands Antilles (...2010)': 'Curacao',
};

/**
 * Trading places the world atlas has no polygon for, and mainland pins for
 * countries whose polygon centroid lands in the wrong ocean because of
 * overseas territories. Both are [longitude, latitude].
 */
export const EXTRA_PLACES = {
  'Hong Kong SAR': [114.17, 22.32], 'Singapore': [103.82, 1.35], 'Macao SAR': [113.55, 22.17],
  'Malta': [14.40, 35.90], 'Mauritius': [57.55, -20.35], 'Bahrain': [50.55, 26.07],
  'Maldives': [73.51, 4.17], 'French Polynesia': [-149.43, -17.65], 'Guam': [144.79, 13.44],
  'Bermuda': [-64.75, 32.32], 'Barbados': [-59.55, 13.10], 'Andorra': [1.52, 42.51],
  'Curacao': [-68.95, 12.17], 'Cayman Islands': [-81.25, 19.32], 'Reunion': [55.53, -21.11],
  'Seychelles': [55.49, -4.68], 'Cabo Verde': [-23.62, 15.12], 'Sint Maarten': [-63.05, 18.03],
  'Bonaire': [-68.28, 12.18], 'San Marino': [12.46, 43.94], 'Liechtenstein': [9.55, 47.17],
  'Monaco': [7.42, 43.74], 'Gibraltar': [-5.35, 36.14], 'Aruba': [-69.97, 12.52],
};

export const PINNED_PLACES = {
  'France': [2.4, 46.6], 'United States of America': [-98.5, 39.5], 'Russia': [93, 61],
  'Norway': [9, 61.2], 'Netherlands': [5.3, 52.2], 'Portugal': [-8.2, 39.6],
  'Chile': [-71, -35], 'Canada': [-106, 56], 'China': [104, 35.5], 'Australia': [134, -25],
  'New Zealand': [172.5, -41.5], 'Denmark': [9.5, 56.2], 'Spain': [-3.7, 40.3],
  'United Kingdom': [-2, 53.5], 'Brazil': [-51, -12], 'Argentina': [-64, -34],
};

/* -------------------------------------------------------- case studies --- */

/** Where the case-study photographs live. */
export const CASE_STUDY_IMAGE_DIR = 'images/case_studies/';

/* ------------------------------------------- primary source documents --- */

/** Where the files in DOCUMENTS live, relative to the page. */
export const DOCUMENT_DIR = 'documents/';

/**
 * Primary sources held in the repository, previewed inside the page rather
 * than opened on someone else's website. This is the one place that ties a
 * file to a case study and to the name a reader sees; a file sitting in
 * `documents/` and not listed here does not appear anywhere.
 *
 *   study  the case study's `name` exactly as data/case_study_data.csv spells
 *          it. Rename a study there and it has to be renamed here too, or the
 *          document is dropped with a console warning — the same trap as
 *          CASE_STUDY_PLACES above.
 *   file   the filename inside DOCUMENT_DIR. Subfolders are fine.
 *   label  what the reader sees, written for a reader rather than for a
 *          filesystem: "Environmental impact assessment, 2021", not
 *          "jadar_eia_v3_FINAL.pdf".
 *
 * PDFs, images, plain text and HTML preview inline. Anything else — .docx and
 * .xlsx in particular — offers a download instead, because no browser renders
 * them without a converter.
 *
 * The entries below are examples and point at nothing; replace them. See
 * documents/README.md.
 */
export const DOCUMENTS = [
  { study: 'Argentina Puna',
    file: 'argentina-puna-kachi-yupi-protocol.pdf',
    label: 'Kachi Yupi, free prior consultation protocol, 2015' },
  { study: 'Argentina Puna',
    file: 'argentina-puna-amparo.pdf',
    label: 'Amparo petition and injunction request' },

  { study: 'Jadar',
    file: 'jadar-eu-decision-2025-1174.pdf',
    label: 'Commission Decision (EU) 2025/1174, 4 June 2025' },
  { study: 'Jadar',
    file: 'jadar_rio_tinto_proposal.docx.pdf',
    label: 'Rito Tinto Project Proposal, 10 May 2025' },

  { study: 'Manono',
    file: 'manono_us_drc_agreement.pdf',
    label: 'US-DRC Agreement, 2025' },
  { study: 'Manono',
    file: 'manono_arbitration_update.pdf',
    label: 'AVZ Arbitration Update, 2025' },

  { study: 'Covas do Barroso',
    file: 'barroso_env_impact_assessment.pdf',
    label: 'Savannah Lithium Failed Environmental Impact Assessment, 2024' },
  { study: 'Covas do Barroso',
    file: 'barroso_env_impact_easement.pdf',
    label: 'Environmental Impact Assessment Easement, 2024' },
  { study: 'Covas do Barroso',
    file: 'barroso_eu_raw_materials_act.pdf',
    label: 'EU Raw Materials Act, 2024' },

  { study: `Thacker Pass / Peehee Mu'huh`,
    file: 'Thacker_BLM_Approval.pdf',
    label: 'BLM Mine Approval, 2021' },
  { study: `Thacker Pass / Peehee Mu'huh`,
    file: 'Thacker_RSIC_Lawsuit.pdf',
    label: 'Reno-Sparks Indian Colony Lawsuit, 2023' },

  { study: 'Salar de Atacama',
    file: 'SalarAtacama_JointAgreement.pdf',
    label: 'SQM and Codelco Partnership Agreement, 2024' },


  { study: 'Buhera',
    file: 'Zimbabwe_MineralsAndMinesAct.pdf',
    label: 'Zimbabwe Minerals and Mines Act, 2016' },
  { study: 'Buhera',
    file: 'Zimbabwe_ZELA_Analysis.pdf',
    label: 'ZELA Analysis of Lithium Mining, 2023' },

];

/**
 * data/case_study_data.csv carries no coordinates or pictures, so each study's
 * `name` is completed here. `country` ties it to the trade data and drives the
 * exports panel in the drawer; it has to be one of the mapped country names
 * above. `image` is a filename inside CASE_STUDY_IMAGE_DIR — a study whose
 * file is missing simply renders without a picture.
 *
 * A study can override any of this by adding `lon`, `lat`, `country` or
 * `image` columns to the CSV — those win when present.
 */
export const CASE_STUDY_PLACES = {
  "Thacker Pass / Peehee Mu'huh": {
    lon: -118.05, lat: 41.71, country: 'United States of America',
    image: 'thacker-pass.jpg',
  },
  'Salar de Atacama': {
    lon: -68.20, lat: -23.50, country: 'Chile', image: 'salar-de-atacama.jpg',
  },
  'Argentina Puna': {
    lon: -66.50, lat: -23.50, country: 'Argentina', image: 'argentina-puna.jpg',
  },
  'Jadar': { lon: 19.35, lat: 44.53, country: 'Serbia', image: 'jadar.jpg' },
  'Covas do Barroso': {
    lon: -7.78, lat: 41.66, country: 'Portugal', image: 'covas-do-barroso.jpg',
  },
  // Keyed on the study's `name` in the CSV, so renaming a study there means
  // renaming it here too — otherwise it has no position and is dropped with a
  // warning. The point is central Zimbabwe rather than Buhera district,
  // because `location` still spans four provinces.
  'Buhera': { lon: 30.90, lat: -19.00, country: 'Zimbabwe', image: 'zimbabwe.jpg' },
  // `country` has to be the world atlas's own name — the alias table above maps
  // Comtrade's 'Dem. Rep. of the Congo' onto this one — or the study's exports
  // section comes up empty.
  'Manono': {
    lon: 27.432145, lat: -7.287988, country: 'Dem. Rep. Congo', image: 'manono.jpg',
  },
};

/** The scrollable rolodex on the landing page. */
export const ROLODEX = {
  step: 20,               // degrees of the drum between one card and the next
  radius: 232,            // px from the drum's axis to a card — its depth
  card: [266, 92],        // px, width and height before perspective
  perspective: 1500,      // px; lower exaggerates the drum, higher flattens it
  wheelSensitivity: 0.0033,
  dragSensitivity: 0.012,
};

/* ------------------------------------------------------------ the shot --- */

/**
 * The landing state: the globe turning inside a cage of dotted trade routes,
 * with the case studies fanned out as a rolodex, until Enter is pressed.
 */
export const LANDING = {
  arcs: 54,               // how many of the year's largest flows orbit the globe
  maxPerOrigin: 3,        // per exporter, so the cage wraps the globe evenly
  dotsPerArc: 30,         // dots in flight along each route; they space it out
  minAltitude: 0.10,      // how far a route is lifted off the surface, as a fraction
  maxAltitude: 0.62,      //   of the globe's radius — varied per route
  dotSize: [2.0, 4.6],    // CSS px at the landing camera distance, by flow size
  speed: [0.035, 0.085],  // trips per second along the route
  spinRate: 0.055,        // radians per second the globe turns while waiting
};

/** Phase id, seconds, caption. The total run time is the sum of the seconds. */
export const PHASES = [
  ['globe', 2.5, 'A globe'],
  ['facet', 2.0, 'Twenty gnomonic faces'],
  ['unfold', 6.0, 'The net falls open'],
  ['settle', 4.0, 'One flat sheet'],
  ['scale', 3.5, 'Rescaled by trade'],
  ['reveal', 2.5, 'Flows and case studies'],
];

/**
 * The title on the landing page, and when it goes.
 *
 * The fade is measured against a *phase*, not against the clock, so changing
 * the pacing in PHASES carries it along. `fadeStart` and `fadeEnd` are
 * fractions of `fadePhase`: the default takes it out across the first 80% of
 * the faceting, so it is gone by the time the globe has hardened into an
 * icosahedron. Set `fadePhase: 'globe'` to lose it sooner.
 *
 * `studyDim` is what is left of the title while a case study is open on the
 * landing page — 0 takes it away entirely, which is the default, and the Enter
 * button goes with it. Raise it to leave the title faintly up instead; the
 * globe passes in front of it either way.
 */
export const TITLE = {
  fadePhase: 'facet',
  fadeStart: 0,
  fadeEnd: 0.8,
  studyDim: 0,
};

/**
 * Case-study categories, from the CSV's `impact_categories`, with a colour
 * each. These are the darker swatch of each family, which is what reads on the
 * cream page.
 *
 * The order matters as well as the colours: a study usually carries several
 * impacts, and with no filter on it takes the colour of the first one in this
 * list that it has (see `studyCategory` in src/main.js). The list is grouped
 * land, people, money, which also spreads the default colours across the seven
 * studies rather than giving four of them the same one.
 *
 * All six hexes are from the supplied palette, one per named family where the
 * family fits the category. Two of its swatches are deliberately unused: the
 * pale tints (the left-hand columns and the top strip) and the yellow #FBCB1E
 * sit at 1.1-1.5:1 against the cream page, so they vanish at legend-dot size.
 * Of what remains, these six are the widest spread of hue — navy, forest,
 * cyan, orange, lime, red — which is what keeps them apart as 9px dots.
 */
export const CATEGORIES = [
  { key: 'Water Use',          color: '#375D81' },  // navy      — water-usage row
  { key: 'Ecological',         color: '#557153' },  // forest    — land-use row
  { key: 'Indigenous Rights',  color: '#18B7C1' },  // cyan      — cultural row
  { key: 'Displacement',       color: '#FD832E' },  // orange    — relocation row
  { key: 'Foreign-Owned Mine', color: '#78B302' },  // lime      — economic row
  { key: 'Economic',           color: '#F20806' },  // red       — economic row
];

/**
 * The timeline along the bottom of the finished map.
 *
 * `yearMs` is how long each year holds while it plays; `studyDwellMs` is the
 * longer hold when the playhead lands on a year a case study starts in, so
 * there is time to read the card. `studyYear` pulls the start year out of the
 * CSV's `conflict_years`, which is free text like "2017-present".
 */
export const TIMELINE = {
  yearMs: 620,
  studyDwellMs: 3200,
  /**
   * How long the map takes to travel from one year to the next while playing,
   * in ms. The playhead, the route dots and the deformation all cross on this
   * clock, so a year is a glide rather than a cut.
   *
   * Shorter than `yearMs` on purpose: the gap is the beat the map holds still
   * at the new year before setting off again, which is what makes the motion
   * read as stepping through years rather than as one continuous drift. Set it
   * to 0 for the old behaviour, an instant change at each step. Values above
   * `yearMs` are clamped to it — the glide cannot outlast its own year.
   */
  glideMs: 460,
  /**
   * Height in px of the total-trade line graph under the year axis, and the
   * one number the rest of the layout is derived from: the tiles above the
   * timeline and the band the map keeps clear both move up by this much. Set
   * it to 0 to take the graph out without disturbing anything else.
   */
  chartHeight: 54,
  /**
   * Which column the graph under the axis plots.
   *
   * Not the same question as VALUE_FIELD, which is what sizes the routes and
   * the cartogram. Plotted in dollars, this line is flat for twenty years and
   * then spikes: 20 of the 26 years sit below a tenth of the 2023 peak, and
   * almost all of that peak is the lithium price, not the trade. Implied price
   * went from $3,399/t in 2000 to $78,391/t in 2023 and back to $23,773 in
   * 2024, while the tonnage climbed steadily throughout. So the default is
   * tonnage, which is the question most people are actually asking.
   *
   *   'lce_tonnes'      lithium content. The honest measure of "how much
   *                     lithium", but the dataset carries no LCE figure for
   *                     ore and concentrate — converting concentrate tonnage
   *                     to lithium content needs a grade assumption it does
   *                     not make — so this line covers the refined chemical
   *                     groups only, and the countries that ship rock are
   *                     absent from it — a caveat the graph no longer states
   *                     on screen, so it is worth stating wherever this is
   *                     published.
   *   'net_weight_kg'   gross shipped weight, every group included. Complete,
   *                     but 91-95% of it is ore by weight, so it mostly plots
   *                     how much rock moved rather than how much lithium.
   *   'trade_value_usd' what it cost. The original behaviour.
   */
  chartField: 'lce_tonnes',
  tick: 5,                      // height of an ordinary year tick, px
  tickMajor: 9,                 // every fifth year
  dash: 22,                     // height of a case-study dash
  dashGap: 5,                   // studies sharing a year sit this far apart, px
  /**
   * Titles to shorten on the timeline tiles only. The full name still stands
   * in the panel, the rolodex and the map's tooltip — this is purely to keep
   * the little tiles legible.
   */
  shortNames: {
    "Thacker Pass / Peehee Mu'huh": "Peehee Mu'huh",
  },
  /**
   * The tile subtitle: the country, not the region. `country` holds the world
   * atlas's own name, a couple of which are too long for a tile, so those get
   * a short form here. Falls back to the tail of the CSV's `location`.
   */
  countryShort: {
    'United States of America': 'USA',
    'Dem. Rep. Congo': 'DR Congo',
  },
  shortPlace: (s, short) => {
    if (s.country) return short[s.country] || s.country;
    const parts = String(s.location || '').split(',').map((t) => t.trim()).filter(Boolean);
    return parts[parts.length - 1] || '';
  },
  /**
   * Which year a study sits at on the axis, pulled out of the CSV's free-text
   * `conflict_years` — "2017-present" gives 2017. A row with no year gets no
   * dash and no tile.
   */
  studyYear: (s) => {
    const m = String(s.years || '').match(/\d{4}/);
    return m ? +m[0] : null;
  },
};

/** Radians per second the globe turns at the start, easing to a stop. */
export const SPIN_RATE = 0.2;

/* --------------------------------------------------------- the map ------ */

export const DEFAULT_YEAR = null;          // null = the latest year in the file
export const DEFAULT_METRIC = 'total';     // 'none' | 'out' | 'in' | 'total' | 'net'
export const DEFAULT_DEFORMATION = 2.0;   // 0..1, the strength slider's start

/** How hard the data pushes the grid around. */
/**
 * The cartogram field.
 *
 * Each source scales a disc of radius `minRadius`..`minRadius + radiusRange`
 * rigidly about itself, then its pull decays outside that disc. The classic
 * Dougenik force decays as 1/r, which never really stops: with wide radii and
 * a long tail, every country dragged every other one and the whole sheet
 * drifted as a block — the mean displacement was the same 0.23 net units
 * everywhere on the map, near a source or not.
 *
 * So the field is now local. `tail` steepens the decay outside the disc and
 * `reach` cuts it off entirely at that multiple of the radius, which gives
 * each source finite support; the radii are smaller and there are more of
 * them, so the map deforms as many small local adjustments rather than a few
 * broad ones. Precision here is about the *field*, not the mesh: the mesh
 * already samples it to within 0.08% (see "Precision of the scaling").
 */
export const WARP = {
  mode: 'elastic',        // 'elastic' solves the sheet; 'field' is the old closed-form sum
  maxOffset: 0.55,        // ceiling on displacement, in net units (the sheet is ~5.8 wide)
  minRadius: 0.085,       // reach of the smallest source
  radiusRange: 0.215,     // extra reach at the largest source
  tail: 2.0,              // decay outside the disc: (R/r)^tail, 1 = classic Dougenik
  reach: 2.6,             // pull is zero beyond this many radii — finite support
  grow: 1.30,             // how much the largest source swells
  shrink: 0.70,           // how much a negative source (net importer) contracts
  maxSources: 72,         // countries that get their own term in the field
  borderHold: 0.45,       // the deformation fades to nothing this far from a cut edge,
                          // so the sheet keeps the outline it was unfolded with
};

/**
 * The elastic sheet (see elastic.js), used when `WARP.mode` is 'elastic'.
 *
 * `subdivision` is how many pieces each edge of a wedge is cut into, so each
 * of the net's 120 wedges becomes subdivision² triangles. This is the mesh the
 * *solve* runs on, not the one that is drawn — MESH_SUBDIVISION still controls
 * that, and it is finer. Raising it localises the deformation (the share of
 * the sheet that moves falls from 58% at 6 to 44% at 14) and costs time
 * roughly linearly; 12 gives 8,917 vertices and solves in about 200ms.
 *
 * `iterations` is converged by about 120 on the real data; 500 moves nothing.
 * Only the first solve pays it anyway — every later one starts from the
 * previous answer and needs `warmIterations`, which is what makes playing the
 * timeline (a new year every 620ms) affordable: a cold solve is ~140ms, a warm
 * one ~35ms.
 *
 * `untanglePasses` cleans up the triangles that settle inverted where sources
 * crowd, by enforcing area on those alone.
 *
 * `spread` is how far past its radius a source still asks for scale, and
 * `reach` how far its influence extends for the purpose of softening the
 * material.
 *
 * `modulusSoft` and `modulusStiff` are the elastic modulus of a line inside
 * and outside the data's reach. The contrast between them matters less than
 * `foundation`, which ties each vertex to where it started with a stiffness
 * that rises as you leave the sources — that is what actually keeps the
 * deformation local. Together `foundation` and `reach` are the locality knobs:
 * with the foundation off, 69% of the sheet moves; at 0.25 with reach 2.2 it
 * is 26%, against 32% for the field this replaced.
 *
 * `gain` is calibration, not physics, and is deliberately 1 — the knob is kept
 * because the tradeoff behind that choice is not obvious. A sheet on a
 * foundation is compliant, so it reaches only part of the area it is asked
 * for, and asking for proportionally more does buy fidelity: on the export
 * metric alone, 1.8 cuts the area error from 20% to 12%. It also folds the
 * sheet. The export and import metrics tolerate it, but `net` puts strong
 * shrinkers next to strong growers, and there it goes from 0 inverted
 * triangles to 186. Tuning on one metric hides this completely. Not folding is
 * the entire point of solving the sheet rather than summing pushes, so the
 * compliance stays and the map understates differences slightly instead.
 *
 * `areaStiffness` weighs the per-triangle area target against the line
 * springs; it carries the cartogram, so leave it at 1 and move the moduli.
 *
 * `texture` is the grid the solved field is baked into, and `pad` the margin
 * left around the net so sampling near the silhouette has somewhere to land.
 */
export const ELASTIC = {
  subdivision: 12,
  iterations: 150,
  warmIterations: 60,
  untanglePasses: 24,
  relax: 1.0,
  spread: 1.35,
  reach: 2.2,
  modulusSoft: 0.25,
  modulusStiff: 0.45,
  areaStiffness: 1.0,
  foundation: 0.15,
  gain: 1.0,
  texture: [1024, 512],
  pad: 0.05,
};

/**
 * The equirectangular canvas the globe and the flat sheet both sample.
 *
 * 4096 is about 11 pixels per degree, which is roughly where Natural Earth's
 * 50m coastlines stop gaining; 8192 is worth it with the 10m tier or if you
 * zoom into the finished map. Clamped to whatever the GPU reports as its
 * maximum, so asking for more than the hardware allows is safe.
 */
export const TEXTURE_WIDTH = 8192;

export const MESH_SUBDIVISION = 56;

/**
 * How much of the unfold is spent staggering the hinges, 0 to ~0.9.
 *
 * At 0 every hinge opens in lockstep, which means a piece six hinges out from
 * the root moves through six rotations at once — the outer edges of the net
 * whip around and sweep through their neighbours. Raising it makes the hinges
 * near the root lead and the outer ones follow, so the sheet peels open.
 * Each hinge still travels the full dihedral angle, just over its own slice of
 * the window, so the net still closes exactly onto the globe.
 */
export const PEEL = 0.25;

/**
 * The grid drawn over the map is the icosahedron's own subdivision — each of
 * the 20 faces split into a triangular lattice, which is the geometry the
 * projection and the unfolding are actually built on. `divisions` must divide
 * MESH_SUBDIVISION for the lines to land on mesh edges. Set opacity to 0 to
 * hide the grid without changing any of the geometry.
 */
export const FACE_GRID = { divisions: 4, opacity: 0.18 };

export const CAMERA_FOV = 40;

/** Marker sizes, in CSS pixels at the resting camera distance. */
export const NODE_SIZE = { min: 3.5, range: 18, study: 30 };

/**
 * Case-study heat blobs — the soft field of category colour around each site,
 * in place of the ring the markers used to wear.
 *
 * `radius` is in **net units**, not pixels: the sheet is about 5.8 wide, so
 * 0.26 is roughly a 13-degree arc. Keeping it geographic rather than
 * screen-sized is the point — the blob is a claim about a region, so it has to
 * scale with the map rather than hover above it at a fixed size.
 *
 * `falloff` is the Gaussian exponent; the curve is shifted so it reaches
 * exactly zero at the rim, which is what keeps the blob from ending on a
 * visible circular edge. Raise it for a tighter core, lower it for a wider
 * wash. `peak` is the alpha at the centre.
 *
 * `coreGain` darkens the dense centre of a blob — on cream that reads as
 * "more". It is a multiplier on the category colour rather than a blend
 * toward some other colour, so the hue survives and the four categories stay
 * apart at the core. Darkening on a light page has no ceiling; brightening on
 * a dark one did, which is why the value was far smaller when the page was
 * dark (lifting `#ABC8E2` by even 0.2 pins its blue channel at 255 and turns
 * the core white — exactly the hue loss the gain exists to avoid).
 *
 * `dim` is the multiplier for a study outside the highlight, and `lift` the
 * one for a study inside it while a filter is on.
 */
export const HEAT = {
  radius: 0.30,
  falloff: 3.1,
  peak: 0.86,
  coreGain: -0.34,
  dim: 0.18,
  lift: 1.18,
  /**
   * How much of each wedge is spent blending into its neighbour, when a site
   * answers to more than one of the selected categories and the blob is split
   * between them. 0 gives hard radial seams; 0.5 would blend edge to edge and
   * leave no pure colour anywhere. Around 0.18 reads as two colours bleeding
   * into each other rather than as two pie slices.
   */
  seam: 0.18,
};

/** Ribbon thickness, as a fraction of the net's width. */
export const RIBBON_WIDTH = { min: 0.0035, range: 0.030 };

/**
 * Trade routes on the flat map, drawn as travelling dots rather than ribbons
 * — the same reading as the orbits on the landing page.
 *
 * Volume shows as *density*: a busy route carries more dots, not a thicker
 * line. `perRoute` is how many the quietest and busiest routes get, scaled by
 * the square root of the value so one enormous flow does not swamp the rest.
 * `speed` is in net units per second, so every dot moves at the same pace on
 * screen whatever the length of its route, with `speedVary` of random spread
 * so they do not march in lockstep. `trackOpacity` above 0 brings back a faint
 * line under the dots.
 */
export const ROUTE_DOTS = {
  perRoute: [2, 55],
  size: [1.7, 6.2],
  /**
   * How hard the biggest routes are pushed away from the rest.
   *
   * The weight that drives density and dot size is the value's position on a
   * log scale, which is the only way to show a spread of 4,000:1 at all — but
   * log compresses so much that the dominant corridors barely separated from
   * the also-rans. In 2025, China->South Korea carries 222 times the median
   * drawn route and used to draw about 5 times the ink.
   *
   * The weight is raised to this power before it is used. 1 is the plain log
   * scale. Above 1 the middle of the range is pulled down while the top stays
   * pinned at 1, so the majors pull away: at 2.0 that same route draws about
   * 46 times the median's ink. Raise it to sharpen further — at the cost of
   * the long tail of small routes fading toward invisibility.
   */
  emphasis: 2.0,
  speed: 0.42,
  speedVary: 0.25,
  fade: 0.08,                   // fraction of the route spent fading in / out
  dimAlpha: 0.10,               // routes not touching the focused country
  baseAlpha: 0.95,
  trackOpacity: 0.0,
};
