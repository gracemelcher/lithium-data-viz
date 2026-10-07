// Reading the two input CSVs.
//
// The trade file is large (the bundled one is ~105 MB / 360k rows), so it is
// streamed and folded down as it arrives rather than held as one string: each
// row is filtered, its direction resolved, and its value added to a
// (year, group, origin, destination) bucket. What survives is a few tens of
// thousands of aggregated flows.
//
// Countries are identified by their world atlas name throughout — the trade
// file has no ISO codes, only Comtrade's English labels.
import { decode, centroid } from './topo.js';
import {
  TRADE_CSV, CASE_STUDY_CSV, FLOW_DIRECTION, VALUE_FIELD, VALUE_FORMAT, TIMELINE,
  INCLUDE_ESTIMATES, PURITY, YEAR_RANGE, MIN_FLOW_VALUE, MAX_FLOWS_PER_GROUP_YEAR,
  ORE_BASKET_ORIGINS,
  COMMODITY_GROUPS, NON_COUNTRIES, COUNTRY_ALIASES, EXTRA_PLACES, PINNED_PLACES,
  CASE_STUDY_PLACES, CASE_STUDY_IMAGE_DIR, DOCUMENTS, DOCUMENT_DIR,
} from './config.js';

/* ---------------------------------------------------------------- csv ---- */

/** Split one CSV line, respecting quotes. Fast path for lines without any. */
function splitLine(line) {
  if (line.indexOf('"') < 0) return line.split(',');
  const out = [];
  let field = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

/** Whole-file parse, for the small CSV. Handles newlines inside quotes. */
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift().map((h) => h.replace(/^﻿/, '').trim());
  return rows.filter((r) => r.some((v) => v !== '')).map((r) => {
    const o = {};
    head.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
}

/**
 * Stream a CSV line by line. `onRow` gets the raw field array plus a column
 * index; `onProgress` gets bytes read so far and the total, when known.
 */
async function streamCSV(url, onHeader, onRow, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  const total = +(res.headers.get('content-length') || 0);
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let tail = '', read = 0, header = null, ticks = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.length;
    const chunk = tail + decoder.decode(value, { stream: true });
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf('\n', start);
      if (nl < 0) break;
      let line = chunk.slice(start, nl);
      start = nl + 1;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line) continue;
      if (!header) {
        header = splitLine(line.replace(/^﻿/, '')).map((h) => h.trim());
        onHeader(header);
      } else onRow(splitLine(line));
    }
    tail = chunk.slice(start);
    if (onProgress && ++ticks % 24 === 0) {
      onProgress(read, total);
      await new Promise((r) => setTimeout(r, 0));     // let the page repaint
    }
  }
  if (tail.trim() && header) onRow(splitLine(tail));
  if (onProgress) onProgress(read, total);
}

/* ------------------------------------------------------------- places ---- */

export async function loadWorld() {
  const topo = window.WORLD_ATLAS || window.WORLD_110M;
  if (!topo) throw new Error('the world atlas script did not load');
  const features = decode(topo, 'countries');
  const positions = new Map();          // map name -> [lon, lat]
  for (const f of features) {
    if (!f.name) continue;
    const c = PINNED_PLACES[f.name] || centroid(f);
    if (c) positions.set(f.name, c);
  }
  for (const [name, ll] of Object.entries(EXTRA_PLACES)) {
    if (!positions.has(name)) positions.set(name, ll);
  }
  return { features, positions };
}

/* -------------------------------------------------------------- trade ---- */

export async function loadTrade(positions, onProgress) {
  const wanted = new Set(COMMODITY_GROUPS.map((g) => g.key));
  const drop = new Set(NON_COUNTRIES);
  const [minYear, maxYear] = YEAR_RANGE;
  const keepImports = FLOW_DIRECTION !== 'export';
  const keepExports = FLOW_DIRECTION !== 'import';

  // A second measure alongside VALUE_FIELD, carried only so the timeline graph
  // can plot tonnage while everything else is sized by value. Skipped when the
  // two are the same column.
  const SECOND = TIMELINE.chartField && TIMELINE.chartField !== VALUE_FIELD
    ? TIMELINE.chartField : null;

  let col = null;
  const need = ['year', 'reporter_name', 'partner_name', 'flow_desc', 'li_group',
                'code_purity', 'is_reported', 'is_aggregate', VALUE_FIELD,
                ...(SECOND ? [SECOND] : [])];

  const buckets = new Map();            // "year|group|origin|dest" -> value
  const seconds = new Map();            // the same keys -> that second measure
  const unknown = new Map();            // unmapped label -> value seen
  const stats = { rows: 0, kept: 0 };

  const resolve = (label) => {
    if (drop.has(label)) return null;
    const name = COUNTRY_ALIASES[label] || label;
    return positions.has(name) ? name : (unknown.set(label, (unknown.get(label) || 0) + 1), null);
  };

  await streamCSV(TRADE_CSV, (header) => {
    col = {};
    for (const key of need) {
      const i = header.indexOf(key);
      if (i < 0) throw new Error(`${TRADE_CSV} has no "${key}" column`);
      col[key] = i;
    }
  }, (f) => {
    stats.rows++;
    if (f[col.is_aggregate] === 'true') return;
    if (!INCLUDE_ESTIMATES && f[col.is_reported] === 'false') return;
    if (PURITY !== 'all' && f[col.code_purity] !== PURITY) return;

    const group = f[col.li_group];
    if (!wanted.has(group)) return;

    const year = +f[col.year];
    if (!year || (minYear && year < minYear) || (maxYear && year > maxYear)) return;

    const isImport = f[col.flow_desc] === 'Import';
    if (isImport ? !keepImports : !keepExports) return;

    const v = +f[col[VALUE_FIELD]];
    if (!(v > MIN_FLOW_VALUE)) return;

    // An import is filed by the buyer, so the goods moved partner -> reporter.
    const from = resolve(isImport ? f[col.partner_name] : f[col.reporter_name]);
    if (!from) return;
    // HS 2530.90 is a residual basket, so only vetted origins count as
    // lithium. Filtered on the origin whichever direction is being read, and
    // the destination is left alone — anyone may buy ore.
    if (group === 'ore_concentrate' && ORE_BASKET_ORIGINS
        && !ORE_BASKET_ORIGINS.has(from)) return;
    const to = resolve(isImport ? f[col.reporter_name] : f[col.partner_name]);
    if (!to || to === from) return;

    stats.kept++;
    const key = `${year}|${group}|${from}|${to}`;
    buckets.set(key, (buckets.get(key) || 0) + v);
    if (SECOND) {
      // Blank for whole groups rather than at random — ore carries no LCE at
      // all — so a missing figure is left out of the sum, not treated as zero
      // trade. The graph says which groups it covers.
      const w = +f[col[SECOND]];
      if (w > 0) seconds.set(key, (seconds.get(key) || 0) + w);
    }
  }, onProgress);

  const byYear = new Map();
  const years = new Set();
  let maxFlow = 0;
  for (const [key, v] of buckets) {
    const [year, cat, a, b] = key.split('|');
    const y = +year;
    years.add(y);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push({ year: y, cat, a, b, v, t: seconds.get(key) || 0 });
    if (v > maxFlow) maxFlow = v;
  }
  for (const rows of byYear.values()) rows.sort((x, y2) => y2.v - x.v);

  if (unknown.size) {
    console.warn('trade labels with no place on the map (add them to COUNTRY_ALIASES '
      + 'or NON_COUNTRIES in src/config.js):',
      [...unknown.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30));
  }
  console.info(`${TRADE_CSV}: ${stats.rows.toLocaleString()} rows read, `
    + `${stats.kept.toLocaleString()} kept, ${buckets.size.toLocaleString()} flows`);

  return {
    secondField: SECOND,
    years: [...years].sort((a, b) => a - b),
    cats: COMMODITY_GROUPS.map((g) => g.key),
    byYear,
    maxFlow,
    format: VALUE_FORMAT[VALUE_FIELD] || VALUE_FORMAT.trade_value_usd,
    stats,
  };
}

/** Flows for one year, restricted to the enabled groups. Every row, unsorted. */
export function slice(data, year, enabled) {
  return (data.byYear.get(year) || []).filter((f) => enabled.has(f.cat));
}

/**
 * Both ends of a year-to-year transition in one list, so that playback can
 * cross between them without the route geometry being rebuilt mid-glide.
 *
 * Every flow present in either year appears once, carrying `vA` and `vB` — its
 * value in each year, 0 where it is absent — alongside `v`, the larger of the
 * two. `v` is what sizes the geometry: dot counts and the log density range
 * are structural and cannot change per frame, so they are built for the busier
 * end and the quieter end fades down to meet them. A route that exists in only
 * one of the two years therefore fades in or out rather than popping.
 *
 * Sorted largest-first, matching `slice`, because `topFlows` reads it that way.
 */
export function sliceUnion(data, yA, yB, enabled) {
  if (yA === yB) {
    return slice(data, yA, enabled).map((f) => ({ ...f, vA: f.v, vB: f.v }));
  }
  const out = new Map();
  const add = (rows, key) => {
    for (const f of rows) {
      const k = `${f.cat}|${f.a}|${f.b}`;
      let e = out.get(k);
      if (!e) out.set(k, (e = { cat: f.cat, a: f.a, b: f.b, v: 0, vA: 0, vB: 0 }));
      e[key] = f.v;
    }
  };
  add(slice(data, yA, enabled), 'vA');
  add(slice(data, yB, enabled), 'vB');
  const rows = [...out.values()];
  for (const e of rows) e.v = Math.max(e.vA, e.vB);
  rows.sort((x, y) => y.v - x.v);
  return rows;
}

/** The subset worth drawing: the largest few per group. */
export function topFlows(rows, n = MAX_FLOWS_PER_GROUP_YEAR) {
  const perGroup = new Map();
  const out = [];
  for (const f of rows) {                 // rows arrive largest-first
    const seen = perGroup.get(f.cat) || 0;
    if (seen >= n) continue;
    perGroup.set(f.cat, seen + 1);
    out.push(f);
  }
  return out;
}

/**
 * Per-country exports, imports and throughput for a slice.
 *
 * `field` picks which value to add up: 'v' for an ordinary slice, or 'vA'/'vB'
 * to total one end of a `sliceUnion` without splitting the rows back apart.
 * Every country in the union appears in all three, at 0 where it has no trade
 * that year, so the three maps share one key set and can be lerped by code.
 */
export function totals(rows, field = 'v') {
  const t = new Map();
  const get = (code) => {
    if (!t.has(code)) t.set(code, { code, out: 0, in: 0 });
    return t.get(code);
  };
  for (const f of rows) {
    get(f.a).out += f[field];
    get(f.b).in += f[field];
  }
  for (const v of t.values()) {
    v.total = v.out + v.in;
    v.net = v.out - v.in;
  }
  return t;
}

/* -------------------------------------------------------- case studies --- */

const HOST = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

export async function loadCaseStudies(positions) {
  let rows;
  try {
    const res = await fetch(CASE_STUDY_CSV);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    rows = parseCSV(await res.text());
  } catch (err) {
    console.warn(`${CASE_STUDY_CSV} unavailable:`, err);
    return [];
  }

  const out = [];
  for (const r of rows) {
    const name = r.name;
    if (!name) continue;
    const place = CASE_STUDY_PLACES[name] || {};
    const lon = r.lon ? +r.lon : place.lon;
    const lat = r.lat ? +r.lat : place.lat;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      console.warn(`case study "${name}" has no position — add it to CASE_STUDY_PLACES `
        + 'in src/config.js, or give the CSV lon/lat columns');
      continue;
    }
    const country = r.country || place.country || null;
    if (country && !positions.has(country)) {
      console.warn(`case study "${name}" names country "${country}", which is not on the map`);
    }

    // Who said it, and who they are. Either may be blank, or the columns may
    // be missing altogether; the panel shows whichever parts are present.
    const speaker = (r.testimonial_name || '').trim();
    const speakerTitle = (r.testimonial_title || '').trim();

    const file = r.image || place.image || '';
    out.push({
      name,
      image: file ? CASE_STUDY_IMAGE_DIR + file : null,
      location: r.location || '',
      years: r.conflict_years || '',
      impacts: (r.impact_categories || '').split(',').map((s) => s.trim()).filter(Boolean),
      area: r.area || '',
      summary: r.summary || '',
      testimonial: (r.testimonial || '').trim(),
      speaker,
      speakerTitle,
      sources: [r.source_1, r.source_2]
        .map((u) => (u || '').trim()).filter((u) => /^https?:/.test(u))
        .map((u) => ({ url: u, host: HOST(u) })),
      primarySources: [r.primary_source_1, r.primary_source_2, r.primary_source_3]
        .map((u) => (u || '').trim()).filter((u) => /^https?:/.test(u))
        .map((u) => ({ url: u, host: HOST(u) })),
      // Documents held in the repository, from the DOCUMENTS mapping. Matched
      // on the study's name, so a rename in the CSV has to be mirrored there.
      documents: docsFor(name),
      lon, lat, country,
    });
  }
  return out;
}

/**
 * The registered documents for one case study, with their paths resolved.
 *
 * The whole mapping is checked once, not per study, so a file registered
 * against a name no case study has is reported rather than silently ignored —
 * that is what a rename looks like, and it is otherwise invisible.
 */
let docsWarned = false;
function docsFor(name) {
  if (!docsWarned) {
    docsWarned = true;
    const known = new Set(Object.keys(CASE_STUDY_PLACES));
    const orphans = DOCUMENTS.filter((d) => !known.has(d.study));
    if (orphans.length) {
      console.warn('documents registered to a case study that does not exist '
        + '(check the `study` field against the CSV\'s `name`):',
        orphans.map((d) => `${d.file} -> "${d.study}"`));
    }
  }
  return DOCUMENTS
    .filter((d) => d.study === name && d.file)
    .map((d) => ({
      label: d.label || d.file,
      file: d.file,
      url: DOCUMENT_DIR + d.file,
      kind: documentKind(d.file),
    }));
}

/** How a file can be shown: the viewer only has these four ways to do it. */
export function documentKind(file) {
  const ext = (file.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg'].includes(ext)) return 'image';
  if (['txt', 'md', 'csv', 'json'].includes(ext)) return 'text';
  if (['html', 'htm'].includes(ext)) return 'page';
  return 'download';     // .docx, .xlsx and friends: no browser renders them
}

/* ------------------------------------------------------------ display --- */

export function formatValue(v, format) {
  const s = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (format.unit === 'usd') {
    if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(a >= 1e10 ? 0 : 1)}bn`;
    if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}m`;
    if (a >= 1e3) return `${s}$${Math.round(a / 1e3)}k`;
    return `${s}$${Math.round(a)}`;
  }
  if (a >= 1e9) return `${s}${(a / 1e9).toFixed(1)}bn ${format.unit}`;
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(1)}m ${format.unit}`;
  if (a >= 1e3) return `${s}${Math.round(a / 1e3)}k ${format.unit}`;
  return `${s}${Math.round(a)} ${format.unit}`;
}
