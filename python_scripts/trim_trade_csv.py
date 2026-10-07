#!/usr/bin/env python3
"""Cut the trade CSV down to the data the visualisation actually reads.

The bundled file is ~105 MB and 360k rows, of which the atlas keeps about
30k and folds those into roughly 30k aggregated flows. Everything else is
dropped before anything is drawn: other commodity codes, the export-reported
half of each shipment, aggregate rows, places that are not on the map, and
origins that are not credible lithium for the residual HS 2530.90 basket.

Two output shapes:

  flows (default)  One row per (year, group, origin, destination) with the
                   values summed -- exactly the buckets `loadTrade` builds,
                   and all the page ever reads. Smallest by far.

  rows (--rows)    The surviving rows of the original file, columns untouched.
                   Bigger, but still the real records, so it stays useful if
                   you want to re-derive something the buckets threw away.

The filters are not reimplemented from memory: every constant is read out of
`src/config.js` and the list of valid place names out of the world atlas the
page loads, so this cannot quietly drift from what the page does. Run it and
compare the printed counts against the browser console, which logs the same
three numbers on every load.

One caveat worth knowing. Which rows survive depends on `VALUE_FIELD`, because
a row is dropped when that field is not greater than `MIN_FLOW_VALUE`. The
flows output sums all three value columns so you can switch fields afterwards,
but the *selection* is the one the current config implies. Changing
`VALUE_FIELD`, `PURITY`, `FLOW_DIRECTION` or `YEAR_RANGE` means running this
again.

Usage:
    python3 python_scripts/trim_trade_csv.py
    python3 python_scripts/trim_trade_csv.py --rows -o data/kept_rows.csv
    python3 python_scripts/trim_trade_csv.py --csv data/other.csv --quiet
"""

import argparse
import csv
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, 'src', 'config.js')
DEFAULT_ATLAS = os.path.join(ROOT, 'world50m.js')

VALUE_COLUMNS = ['trade_value_usd', 'net_weight_kg', 'lce_tonnes']


# --------------------------------------------------------------- config ----
# config.js holds plain data literals, but they are JS: single quotes,
# unquoted object keys, `new Set([...])`, trailing commas and comments. A
# regex would trip over the apostrophe in "Dem. People's Rep. of Korea", so
# this is a small real parser instead.

class JSLiteral:
    def __init__(self, text, pos=0):
        self.s = text
        self.i = pos

    def ws(self):
        while self.i < len(self.s):
            c = self.s[self.i]
            if c in ' \t\r\n,':
                self.i += 1
            elif self.s.startswith('//', self.i):
                nl = self.s.find('\n', self.i)
                self.i = len(self.s) if nl < 0 else nl + 1
            elif self.s.startswith('/*', self.i):
                end = self.s.find('*/', self.i)
                self.i = len(self.s) if end < 0 else end + 2
            else:
                return

    def value(self):
        self.ws()
        c = self.s[self.i]
        if c == '{':
            return self.obj()
        if c == '[':
            return self.arr()
        if c in '"\'':
            return self.string()
        if self.s.startswith('new Set(', self.i):
            self.i += len('new Set(')
            v = self.value()
            self.ws()
            assert self.s[self.i] == ')', 'unterminated new Set('
            self.i += 1
            return set(v)
        for word, val in (('true', True), ('false', False), ('null', None)):
            if self.s.startswith(word, self.i):
                self.i += len(word)
                return val
        return self.number()

    def string(self):
        quote = self.s[self.i]
        self.i += 1
        out = []
        while self.s[self.i] != quote:
            if self.s[self.i] == '\\':
                self.i += 1
                out.append({'n': '\n', 't': '\t'}.get(self.s[self.i], self.s[self.i]))
            else:
                out.append(self.s[self.i])
            self.i += 1
        self.i += 1
        return ''.join(out)

    def number(self):
        start = self.i
        while self.i < len(self.s) and self.s[self.i] in '-+.0123456789eE':
            self.i += 1
        raw = self.s[start:self.i]
        if not raw:
            raise ValueError('expected a value at offset %d: %r'
                             % (start, self.s[start:start + 40]))
        return float(raw) if ('.' in raw or 'e' in raw or 'E' in raw) else int(raw)

    def arr(self):
        self.i += 1
        out = []
        while True:
            self.ws()
            if self.s[self.i] == ']':
                self.i += 1
                return out
            out.append(self.value())

    def obj(self):
        self.i += 1
        out = {}
        while True:
            self.ws()
            if self.s[self.i] == '}':
                self.i += 1
                return out
            if self.s[self.i] in '"\'':
                key = self.string()
            else:
                start = self.i
                while self.s[self.i] not in ': \t\r\n':
                    self.i += 1
                key = self.s[start:self.i]
            self.ws()
            assert self.s[self.i] == ':', 'expected : after key %r' % key
            self.i += 1
            out[key] = self.value()


def read_config(names):
    """Pull the named `export const` literals out of src/config.js."""
    with open(CONFIG, encoding='utf-8') as fh:
        src = fh.read()
    found = {}
    for name in names:
        marker = 'export const %s = ' % name
        at = src.find(marker)
        if at < 0:
            raise SystemExit('src/config.js has no export named %s' % name)
        found[name] = JSLiteral(src, at + len(marker)).value()
    return found


def atlas_place_names(path):
    """Every country name the world atlas carries, as data.js reads them."""
    with open(path, encoding='utf-8') as fh:
        src = fh.read()
    start = src.index('{', src.index('='))
    end = src.rindex('}') + 1
    topo = json.loads(src[start:end])
    names = set()
    for geom in topo['objects']['countries']['geometries']:
        name = (geom.get('properties') or {}).get('name')
        if name:
            names.add(name)
    return names


# ---------------------------------------------------------------- filter ---
def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--csv', help='input trade CSV (default: TRADE_CSV from config.js)')
    ap.add_argument('--atlas', default=DEFAULT_ATLAS,
                    help='world atlas JS the page loads (default: world50m.js)')
    ap.add_argument('-o', '--out', help='output path (default: alongside the input)')
    ap.add_argument('--rows', action='store_true',
                    help='write the surviving original rows instead of aggregated flows')
    ap.add_argument('--quiet', action='store_true', help='only print the summary line')
    args = ap.parse_args()

    cfg = read_config([
        'TRADE_CSV', 'FLOW_DIRECTION', 'VALUE_FIELD', 'INCLUDE_ESTIMATES', 'PURITY',
        'YEAR_RANGE', 'MIN_FLOW_VALUE', 'COMMODITY_GROUPS', 'ORE_BASKET_ORIGINS',
        'NON_COUNTRIES', 'COUNTRY_ALIASES', 'EXTRA_PLACES',
    ])

    src_path = args.csv or os.path.join(ROOT, cfg['TRADE_CSV'])
    if not os.path.exists(src_path):
        raise SystemExit('no such file: %s' % src_path)
    if args.out:
        out_path = args.out
    else:
        base, ext = os.path.splitext(src_path)
        out_path = base + ('.kept' if args.rows else '.flows') + ext

    places = atlas_place_names(args.atlas) | set(cfg['EXTRA_PLACES'])
    wanted = {g['key'] for g in cfg['COMMODITY_GROUPS']}
    drop = set(cfg['NON_COUNTRIES'])
    aliases = cfg['COUNTRY_ALIASES']
    ore_origins = cfg['ORE_BASKET_ORIGINS']
    value_field = cfg['VALUE_FIELD']
    min_value = cfg['MIN_FLOW_VALUE']
    min_year, max_year = cfg['YEAR_RANGE']
    keep_imports = cfg['FLOW_DIRECTION'] != 'export'
    keep_exports = cfg['FLOW_DIRECTION'] != 'import'

    if not args.quiet:
        print('reading   %s' % os.path.relpath(src_path, ROOT))
        print('config    direction=%s value=%s purity=%s estimates=%s years=%s min=%s'
              % (cfg['FLOW_DIRECTION'], value_field, cfg['PURITY'],
                 cfg['INCLUDE_ESTIMATES'], cfg['YEAR_RANGE'], min_value))
        print('groups    %s' % ', '.join(sorted(wanted)))
        print('places    %d on the map (%d from the atlas, %d added by hand)'
              % (len(places), len(places) - len(cfg['EXTRA_PLACES']),
                 len(cfg['EXTRA_PLACES'])))

    unknown = {}

    def resolve(label):
        """Trade label -> atlas name, or None if the row should be dropped."""
        if label in drop:
            return None
        name = aliases.get(label, label)
        if name in places:
            return name
        unknown[label] = unknown.get(label, 0) + 1
        return None

    read = kept = 0
    buckets = {}
    kept_rows = []

    with open(src_path, newline='', encoding='utf-8-sig') as fh:
        reader = csv.reader(fh)
        header = next(reader)
        header = [h.strip() for h in header]
        need = ['year', 'reporter_name', 'partner_name', 'flow_desc', 'li_group',
                'code_purity', 'is_reported', 'is_aggregate', value_field]
        col = {}
        for key in need:
            if key not in header:
                raise SystemExit('%s has no "%s" column' % (src_path, key))
            col[key] = header.index(key)
        # the other value columns are carried through when they exist, so the
        # flows file still works if VALUE_FIELD is switched later
        extra_values = [c for c in VALUE_COLUMNS if c in header]
        extra_at = {c: header.index(c) for c in extra_values}

        for f in reader:
            read += 1
            if len(f) < len(header):
                continue
            # the same nine tests as loadTrade, in the same order
            if f[col['is_aggregate']] == 'true':
                continue
            if not cfg['INCLUDE_ESTIMATES'] and f[col['is_reported']] == 'false':
                continue
            if cfg['PURITY'] != 'all' and f[col['code_purity']] != cfg['PURITY']:
                continue
            group = f[col['li_group']]
            if group not in wanted:
                continue
            try:
                year = int(f[col['year']])
            except ValueError:
                continue
            if not year:
                continue
            if (min_year and year < min_year) or (max_year and year > max_year):
                continue
            is_import = f[col['flow_desc']] == 'Import'
            if not (keep_imports if is_import else keep_exports):
                continue
            try:
                value = float(f[col[value_field]])
            except ValueError:
                continue
            if not value > min_value:
                continue
            # an import is filed by the buyer, so the goods moved partner -> reporter
            origin = resolve(f[col['partner_name']] if is_import else f[col['reporter_name']])
            if origin is None:
                continue
            # HS 2530.90 is a residual basket: only vetted origins count as
            # lithium. The destination is left alone -- anyone may buy ore.
            if group == 'ore_concentrate' and origin not in ore_origins:
                continue
            dest = resolve(f[col['reporter_name']] if is_import else f[col['partner_name']])
            if dest is None or dest == origin:
                continue

            kept += 1
            if args.rows:
                kept_rows.append(f)
            else:
                key = (year, group, origin, dest)
                bucket = buckets.get(key)
                if bucket is None:
                    bucket = buckets[key] = dict.fromkeys(extra_values, 0.0)
                for c in extra_values:
                    try:
                        bucket[c] += float(f[extra_at[c]])
                    except ValueError:
                        pass            # blank cell: lce_tonnes is sparse

    # ------------------------------------------------------------ write ----
    with open(out_path, 'w', newline='', encoding='utf-8') as fh:
        writer = csv.writer(fh)
        if args.rows:
            writer.writerow(header)
            writer.writerows(kept_rows)
        else:
            writer.writerow(['year', 'li_group', 'origin', 'destination'] + extra_values)
            for (year, group, origin, dest) in sorted(buckets):
                bucket = buckets[(year, group, origin, dest)]
                writer.writerow([year, group, origin, dest]
                                + [fmt(bucket[c]) for c in extra_values])

    # ----------------------------------------------------------- report ----
    if not args.quiet and unknown:
        worst = sorted(unknown.items(), key=lambda kv: -kv[1])[:10]
        print('\nlabels with no place on the map (the page drops these too; add them to '
              'COUNTRY_ALIASES\nor NON_COUNTRIES in src/config.js if any should count):')
        for label, n in worst:
            print('    %-34s %d rows' % (label, n))
        if len(unknown) > len(worst):
            print('    ... and %d more' % (len(unknown) - len(worst)))

    shown = os.path.relpath(out_path, ROOT)
    if shown.startswith('..'):
        shown = out_path                 # written outside the project
    before = os.path.getsize(src_path)
    after = os.path.getsize(out_path)
    if not args.quiet:
        print()
    print('%s rows read, %s kept, %s %s  ->  %s (%.1f MB -> %.1f MB, %.1f%% of the original)'
          % (f'{read:,}', f'{kept:,}',
             f'{len(kept_rows) if args.rows else len(buckets):,}',
             'rows written' if args.rows else 'flows',
             shown,
             before / 1048576, after / 1048576, 100 * after / before))
    if not args.quiet:
        print('the browser console logs "rows read / kept / flows" on every load; '
              'they should match')


def fmt(v):
    """Keep integers looking like integers, so the file stays readable."""
    if v == int(v):
        return int(v)
    return round(v, 6)


if __name__ == '__main__':
    sys.exit(main())
