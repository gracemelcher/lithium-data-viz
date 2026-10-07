#!/usr/bin/env python3
"""Generate src/dymaxion-data.js: the Fuller-oriented icosahedron and an
unfolded net whose cut edges run through ocean instead of continents.

Everything downstream (the 3-D morph, the flat map, the hit testing) is derived
from this one file, so it is worth regenerating rather than hand-editing.

    python3 python_scripts/build_dymaxion.py

Needs data/land-110m.json (Natural Earth land at 1:110m, TopoJSON):

    curl -sSL -o data/land-110m.json https://unpkg.com/world-atlas@2.0.2/land-110m.json
"""

import itertools
import json
import math
import os
import random
import sys

random.seed(11)
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LAND = os.path.join(HERE, "data", "land-110m.json")
OUT = os.path.join(HERE, "src", "dymaxion-data.js")

D2R = math.pi / 180
EDGE = math.atan(2.0)                       # 63.4349deg, icosahedron edge arc
DIHEDRAL = math.acos(-math.sqrt(5) / 3)     # 138.1897deg
ALPHA = math.pi - DIHEDRAL                  # fold angle from flat


def vec(lat, lon):
    la, lo = lat * D2R, lon * D2R
    return (math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la))


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def sub(a, b):
    return tuple(x - y for x, y in zip(a, b))


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def nrm(a):
    n = math.sqrt(dot(a, a))
    return tuple(x / n for x in a)


def ang(a, b):
    return math.acos(max(-1.0, min(1.0, dot(a, b))))


# --------------------------------------------------------------------------
# 1. the icosahedron, in Fuller's Dymaxion orientation
#    (discreteglobalgrids.org: vertex 0 at 5.245390W / 2.3008820N, with an
#    adjacent vertex at azimuth 7.46658deg -- the only known orientation with
#    no icosahedron vertex on land.)
# --------------------------------------------------------------------------
def icosahedron():
    v0 = vec(2.3008820, -5.245390)
    north = nrm(sub((0, 0, 1), tuple(v0[i] * dot(v0, (0, 0, 1)) for i in range(3))))
    east = nrm(cross(north, v0))
    probe = nrm(tuple(v0[i] + east[i] * 0.01 for i in range(3)))
    if math.atan2(probe[1], probe[0]) < math.atan2(v0[1], v0[0]):
        east = tuple(-x for x in east)

    verts = [v0]
    for k in range(5):
        az = 7.46658 * D2R + k * 2 * math.pi / 5
        d = tuple(north[i] * math.cos(az) + east[i] * math.sin(az) for i in range(3))
        verts.append(nrm(tuple(v0[i] * math.cos(EDGE) + d[i] * math.sin(EDGE) for i in range(3))))
    verts += [tuple(-x for x in v) for v in verts[:6]]
    verts = [nrm(v) for v in verts]

    for i, a in enumerate(verts):
        assert sum(1 for j, b in enumerate(verts) if j != i and abs(ang(a, b) - EDGE) < 1e-9) == 5

    faces = []
    for a, b, c in itertools.combinations(range(12), 3):
        if all(abs(ang(verts[i], verts[j]) - EDGE) < 1e-9 for i, j in ((a, b), (b, c), (a, c))):
            n = cross(sub(verts[b], verts[a]), sub(verts[c], verts[a]))
            if dot(n, tuple(verts[a][i] + verts[b][i] + verts[c][i] for i in range(3))) < 0:
                a, b, c = a, c, b                   # keep CCW seen from outside
            faces.append((a, b, c))
    assert len(faces) == 20
    return verts, faces


# --------------------------------------------------------------------------
# 2. a 1-degree land mask, used to score where the net may be cut
# --------------------------------------------------------------------------
def land_cells():
    topo = json.load(open(LAND))
    tr = topo["transform"]
    sx, sy = tr["scale"]
    dx, dy = tr["translate"]

    def decode(arc):
        x = y = 0
        out = []
        for p in arc:
            x += p[0]
            y += p[1]
            out.append((x * sx + dx, y * sy + dy))
        return out

    arcs = [decode(a) for a in topo["arcs"]]

    def ring(idx):
        pts = []
        for i in idx:
            a = arcs[~i][::-1] if i < 0 else arcs[i]
            pts.extend(a if not pts else a[1:])
        return pts

    polys = []
    for g in topo["objects"]["land"]["geometries"]:
        if g["type"] == "Polygon":
            polys.append([ring(r) for r in g["arcs"]])
        else:
            for p in g["arcs"]:
                polys.append([ring(r) for r in p])

    # Antarctica's ring is the true coastline, traced from the antimeridian all
    # the way round and back, so it sweeps the full 360 degrees of longitude.
    # Closed in the plane that makes a straight edge back across the map at
    # about 84.7S: point-in-polygon then reports the pole as sea, and the map
    # gets a false coast drawn through the interior. Closing it down through
    # the pole instead gives the continent its real shape. src/texture.js does
    # the same thing to the canvas it paints, and the two have to agree or the
    # map and the net's scoring disagree about where the land is.
    def unwrap(r):
        out = [list(r[0])]
        for q in r[1:]:
            lon, prev = q[0], out[-1][0]
            while lon - prev > 180:
                lon -= 360
            while prev - lon > 180:
                lon += 360
            out.append([lon, q[1]])
        return out

    closed = 0
    for pl in polys:
        pts = unwrap(pl[0])
        lons = [q[0] for q in pts]
        if max(lons) - min(lons) > 350:
            pts.append([pts[-1][0], -90.0])
            pts.append([pts[0][0], -90.0])
            pl[0] = [tuple(q) for q in pts]
            closed += 1
    assert closed == 1, "expected exactly one globe-sweeping ring, got %d" % closed

    def bbox(r):
        xs = [p[0] for p in r]
        ys = [p[1] for p in r]
        return min(xs), min(ys), max(xs), max(ys)

    boxed = [(bbox(p[0]), p) for p in polys]

    def inside(x, y, r):
        c = False
        n = len(r)
        for i in range(n):
            x1, y1 = r[i]
            x2, y2 = r[(i + 1) % n]
            if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
                c = not c
        return c

    cells = []
    lat = -89.5
    while lat < 90:
        # Two separate things, which must not be multiplied together and then
        # used as a presence test: `area` is how much ground a 1 degree cell
        # covers, and the Antarctic factor is editorial — Fuller's own net cuts
        # Antarctica to pieces and keeps the inhabited continents whole, so the
        # weights let the search do the same. Folding them into one number and
        # then skipping cells below a threshold punched a hole in the mask
        # within 10 degrees of the South Pole, because cos(80.4) * 0.06 drops
        # under the cutoff while the ground there is still solid land.
        area = math.cos(math.radians(lat))
        w = area * (0.06 if lat < -60 else 1.0)
        lon = -179.5
        while lon < 180:
            if area > 1e-4:                    # skip only the degenerate pole cell
                for b, p in boxed:
                    if b[0] <= lon <= b[2] and b[1] <= lat <= b[3] and inside(lon, lat, p[0]) \
                            and not any(inside(lon, lat, h) for h in p[1:]):
                        cells.append((lon, lat, w))
                        break
            lon += 1.0
        lat += 1.0

    return cells


# --------------------------------------------------------------------------
# 3. pick the fold tree: cheap cuts = cuts that stay at sea
# --------------------------------------------------------------------------
def edge_costs(verts, faces, cells):
    edges = {}
    for fi, f in enumerate(faces):
        for a, b in ((f[0], f[1]), (f[1], f[2]), (f[2], f[0])):
            edges.setdefault((min(a, b), max(a, b)), []).append(fi)
    assert len(edges) == 30

    pts = [(vec(c[1], c[0]), c[2]) for c in cells]
    sigma = 5.0 * D2R

    def arc_dist(p, a, b):
        n = nrm(cross(a, b))
        d = abs(math.asin(max(-1, min(1, dot(p, n)))))
        pp = nrm(tuple(p[i] - dot(p, n) * n[i] for i in range(3)))
        if abs(ang(a, pp) + ang(pp, b) - ang(a, b)) < 1e-6:
            return d
        return min(ang(p, a), ang(p, b))

    cost = {}
    for k in edges:
        a, b = verts[k[0]], verts[k[1]]
        s = 0.0
        for p, w in pts:
            d = arc_dist(p, a, b)
            if d < 3 * sigma:
                s += w * math.exp(-(d / sigma) ** 2)
        cost[k] = s
    return edges, cost


def unfold(faces, parent, root, side):
    """Lay the 20 triangles flat. Returns {face: {vertex_id: (x, y)}}."""
    h = side * math.sqrt(3) / 2
    kids = {}
    for c, p in parent.items():
        if p is not None:
            kids.setdefault(p, []).append(c)

    def third(a, b, away):
        mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        dx, dy = (b[0] - a[0]) / side, (b[1] - a[1]) / side
        n1, n2 = (mx - dy * h, my + dx * h), (mx + dy * h, my - dx * h)
        far = (n1[0] - away[0]) ** 2 + (n1[1] - away[1]) ** 2
        near = (n2[0] - away[0]) ** 2 + (n2[1] - away[1]) ** 2
        return n1 if far > near else n2

    f = faces[root]
    pos = {root: {f[0]: (0.0, 0.0), f[1]: (side, 0.0), f[2]: (side / 2, h)}}
    order, i = [root], 0
    while i < len(order):
        p = order[i]
        i += 1
        for c in kids.get(p, []):
            shared = [v for v in faces[c] if v in faces[p]]
            u, w = shared
            t = [v for v in faces[c] if v not in shared][0]
            apex = pos[p][[v for v in faces[p] if v not in shared][0]]
            pos[c] = {u: pos[p][u], w: pos[p][w], t: third(pos[p][u], pos[p][w], apex)}
            order.append(c)
    return pos


def overlaps(faces, pos):
    def tri(f):
        t = [pos[f][v] for v in faces[f]]
        cx, cy = sum(p[0] for p in t) / 3, sum(p[1] for p in t) / 3
        return [(cx + (p[0] - cx) * 0.965, cy + (p[1] - cy) * 0.965) for p in t]

    def hit(t1, t2):
        for t in (t1, t2):
            for i in range(3):
                ax, ay = t[(i + 1) % 3][1] - t[i][1], t[i][0] - t[(i + 1) % 3][0]
                r1 = [ax * p[0] + ay * p[1] for p in t1]
                r2 = [ax * p[0] + ay * p[1] for p in t2]
                if max(r1) < min(r2) or max(r2) < min(r1):
                    return False
        return True

    t = [tri(i) for i in range(20)]
    return any(hit(t[i], t[j]) for i in range(20) for j in range(i + 1, 20))


ASPECT = 2.7                     # Fuller's net is a long horizontal strip


def orient_sheet(verts, faces, normals, pos, cells):
    """
    Turn the sheet in its own plane. The band of ten faces is the long axis of
    the net, so lay it flat first: the widest rotation is the one that has the
    band horizontal. Only then choose between the two ways up, by which one
    puts the northern hemisphere at the top.

    Scoring north-up and outline shape together (as this used to) lets a tilt
    win on the north term and hands back a diagonal staircase, which is not
    the packed strip Fuller's map is. The cells carry their own weight, or the
    thousands of Antarctic ones outvote the inhabited world and flip the map.
    """
    sample = [(vec(c[1], c[0]), c[1] * c[2]) for c in cells[::20]]
    flat = [(gnomonic(verts, faces, normals, pos, p), lat) for p, lat in sample]
    corner = [p for f in pos for p in pos[f].values()]

    turn, best = 0.0, -1e18
    for deg in range(180):
        t = deg * D2R
        ct, st = math.cos(t), math.sin(t)
        xs = [p[0] * ct - p[1] * st for p in corner]
        ys = [p[0] * st + p[1] * ct for p in corner]
        aspect = (max(xs) - min(xs)) / (max(ys) - min(ys))
        if aspect > best:
            best, turn = aspect, t

    # y after rotating the sheet by +turn, which is what gets applied below
    if sum(lat * (x * math.sin(turn) + y * math.cos(turn)) for (x, y), lat in flat) < 0:
        turn += math.pi
    c, s = math.cos(turn), math.sin(turn)
    return {f: {v: (p[0] * c - p[1] * s, p[0] * s + p[1] * c) for v, p in d.items()}
            for f, d in pos.items()}, turn


# --------------------------------------------------------------------------
# 3a. Fuller's own net
#
# This is not a net a search found, and it is not the "canonical" band-and-
# caps net every paper icosahedron uses either. It is the arrangement off
# Fuller's published Dymaxion map, read back off the map itself: the map's
# triangular lattice was measured from its silhouette (edge, row lines), each
# filled cell's land compared against all 20 gnomonic faces, and one anchor
# then fixes every other cell by rolling the solid along the shared edges.
# The winning anchor agreed 92%, against 73% for the runner-up; it is not
# 100% because Fuller's projection is not quite gnomonic.
#
# The table below is that result. Each entry is a face -> (row, column,
# points_down, (v0, v1, v2)) where the vertex triple says which icosahedron
# vertex sits at which corner of that lattice cell, so the layout, the fold
# tree and the hinges all follow from it.
#
# One honest caveat. Fuller's published map is NOT a net of 20 whole
# triangles: it cuts two faces along their medians and places the pieces in
# different cells, which is what gives the real map its stepped outline. A
# sheet of 20 rigid triangles cannot do that, so those two faces are placed
# whole, at cells the published map does use. Everything else - the
# left-to-right order of the continents, which face carries which landmass -
# matches. Set FULLER_NET = False to fall back to the constructed
# band-and-caps net instead.
# --------------------------------------------------------------------------
FULLER_NET = True

FULLER_CELLS = {
     0: (0,  1, False, ( 0,  2,  1)),
     1: (0,  2, True,  ( 1,  0,  5)),
     2: (0,  1, True,  ( 2,  3,  0)),
     3: (0,  4, False, ( 0,  4,  3)),
     4: (0,  3, False, ( 0,  5,  4)),
     5: (1,  1, True,  (10,  2,  1)),
     6: (1,  2, True,  ( 9,  1,  5)),
     7: (1,  2, False, ( 1, 10,  9)),
     8: (1,  0, True,  (11,  3,  2)),
     9: (1,  1, False, ( 2, 11, 10)),
    10: (1,  4, True,  ( 7,  4,  3)),
    11: (1,  0, False, ( 3,  7, 11)),
    12: (1,  3, True,  ( 8,  5,  4)),
    13: (1,  4, False, ( 4,  8,  7)),
    14: (1,  3, False, ( 5,  9,  8)),
    15: (2,  3, False, ( 8,  6,  7)),
    16: (2,  0, False, (11,  7,  6)),
    17: (2,  3, True,  ( 6,  9,  8)),
    18: (2,  2, True,  ( 6, 10,  9)),
    19: (2,  1, True,  ( 6, 11, 10)),
}


# --------------------------------------------------------------------------
# 3b. Fuller's exact net, as 22 pieces
#
# The published map is not a net of 20 whole triangles. Its outline turns at
# triangle centroids and edge midpoints, which means every cut runs along a
# median - so two of the faces are cut and their pieces placed in different
# cells. Splitting each lattice cell by its three medians into six wedges
# represents the map exactly: 120 wedges, 6 per face, no remainder.
#
# This table came from Fuller's own outline (the vector version of the
# published map), read as wedge occupancy, with each cell's face then fixed by
# rolling the solid along the shared half-edges from a single anchor. The
# anchor was picked by land agreement against the published raster: 93%
# against 72% for the runner-up, short of 100% only because Fuller's
# projection is not quite gnomonic.
#
# Each entry is (row, column, points_down), the wedges of that cell that are
# present, and which icosahedron vertex sits at which corner of the cell.
# Wedge 2k touches cell corner k along the edge to corner k+1; wedge 2k+1
# touches corner k+1 along that same edge.
# --------------------------------------------------------------------------
FULLER_PIECES = (
    ((0,  1, False), (0, 1, 2, 3, 4, 5), ( 0,  2,  1)),
    ((0,  1, True),  (0, 1, 2, 3, 4, 5), ( 2,  3,  0)),
    ((0,  2, True),  (0, 1, 2, 3, 4, 5), ( 1,  0,  5)),
    ((0,  3, False), (0, 1, 2, 3, 4, 5), ( 0,  5,  4)),
    ((0,  4, False), (0, 1, 2, 3, 4, 5), ( 0,  4,  3)),
    ((1,  0, True),  (0, 1, 2, 3, 4, 5), (11,  3,  2)),
    ((1,  1, False), (0, 1, 2, 3, 4, 5), ( 2, 11, 10)),
    ((1,  1, True),  (0, 1, 2, 3, 4, 5), (10,  2,  1)),
    ((1,  2, False), (0, 1, 2, 3, 4, 5), ( 1, 10,  9)),
    ((1,  2, True),  (0, 1, 2, 3, 4, 5), ( 9,  1,  5)),
    ((1,  3, False), (0, 1, 2, 3, 4, 5), ( 5,  9,  8)),
    ((1,  3, True),  (0, 1, 2, 3, 4, 5), ( 8,  5,  4)),
    ((1,  4, False), (0, 1, 2, 3, 4, 5), ( 4,  8,  7)),
    ((1,  4, True),  (0, 1, 2, 3, 4, 5), ( 7,  4,  3)),
    ((1,  5, False), (0, 1, 2),          ( 3,  7, 11)),   # face 11, half
    ((2,  0, False), (0, 1, 2, 3, 4, 5), (11,  7,  6)),
    ((2,  0, True),  (2, 3, 4),          ( 7,  3, 11)),   # face 11, other half
    ((2,  1, False), (4, 5),             (10, 11,  6)),   # face 19, one third
    ((2,  1, True),  (0, 1, 2, 3),       ( 6, 11, 10)),   # face 19, two thirds
    ((2,  2, True),  (0, 1, 2, 3, 4, 5), ( 6, 10,  9)),
    ((2,  3, False), (0, 1, 2, 3, 4, 5), ( 8,  6,  7)),
    ((2,  3, True),  (0, 1, 2, 3, 4, 5), ( 6,  9,  8)),
)

ROW_H = math.sqrt(3) / 2                     # lattice row height, in edges


def lattice_cell(r, c, down):
    """Cell corners in lattice units, y already flipped so north is up."""
    yt, yb = -float(r), -float(r + 1)
    s = 0.5 * (r % 2)
    s2 = 0.5 * ((r + 1) % 2)
    if down:
        return [(s + c + 0.5, yb * ROW_H), (s + c, yt * ROW_H), (s + c + 1.0, yt * ROW_H)]
    return [(s2 + c + 0.5, yt * ROW_H), (s2 + c, yb * ROW_H), (s2 + c + 1.0, yb * ROW_H)]


def wedge_barys():
    """The six medial wedges as barycentric corner triples, in cell order."""
    g = (1 / 3, 1 / 3, 1 / 3)
    o = []
    for k in range(3):
        a, b = k, (k + 1) % 3
        m = [0.0, 0.0, 0.0]; m[a] = m[b] = 0.5
        ea = [0.0, 0.0, 0.0]; ea[a] = 1.0
        eb = [0.0, 0.0, 0.0]; eb[b] = 1.0
        o.append((tuple(ea), tuple(m), g))
        o.append((tuple(m), tuple(eb), g))
    return o


WEDGES = wedge_barys()


def fuller_exact(verts, faces, edges, cost, side):
    """
    Build the 22-piece net: positions, the fold tree, hinges and silhouette.

    Returns (pieces, root, boundary, aspect, cut_cost) where each piece is a
    dict with its face, parent, hinge and wedge triangles. Both pieces of a
    split face fold onto that one face, from different directions.
    """
    def xy(cs, b):
        return (b[0]*cs[0][0] + b[1]*cs[1][0] + b[2]*cs[2][0],
                b[0]*cs[0][1] + b[1]*cs[1][1] + b[2]*cs[2][1])

    def key(p):
        return (round(p[0] / side, 5), round(p[1] / side, 5))

    pieces = []
    for cell, wl, tv in FULLER_PIECES:
        r, c, down = cell
        cs = [(p[0] * side, p[1] * side) for p in lattice_cell(r, c, down)]
        f = next(i for i, ff in enumerate(faces) if frozenset(ff) == frozenset(tv))
        # face barycentric, ordered as faces[f], for a point given in cell bary
        order = [tv.index(v) for v in faces[f]]
        tris = []
        for k in wl:
            wb = WEDGES[k]
            tris.append({
                "p": [list(xy(cs, b)) for b in wb],
                "b": [[b[order[j]] for j in range(3)] for b in wb],
            })
        pieces.append({"cell": cell, "wedges": list(wl), "f": f, "tv": list(tv),
                       "P": {tv[i]: cs[i] for i in range(3)}, "cs": cs, "tris": tris})

    # Wedges meet across a cell edge where their outer half-edges coincide.
    outer = {}
    for i, pc in enumerate(pieces):
        for k in pc["wedges"]:
            wb = WEDGES[k]
            e = tuple(sorted((key(xy(pc["cs"], wb[0])), key(xy(pc["cs"], wb[1])))))
            outer.setdefault(e, []).append(i)
    adj = {i: set() for i in range(len(pieces))}
    for e, ps in outer.items():
        if len(ps) == 2 and ps[0] != ps[1]:
            adj[ps[0]].add(ps[1]); adj[ps[1]].add(ps[0])
    links = sum(len(v) for v in adj.values()) // 2
    assert links == len(pieces) - 1, "expected a tree, got %d gluings" % links

    # Root at the tree's centre, so no piece is dragged through a long chain of
    # hinges. A root at one end gives depth 8 and the unfold reads as chaos.
    def depths(root):
        d, q = {root: 0}, [root]
        while q:
            n = q.pop(0)
            for m in adj[n]:
                if m not in d:
                    d[m] = d[n] + 1; q.append(m)
        return d

    root = min(range(len(pieces)), key=lambda i: max(depths(i).values()))
    d = depths(root)
    assert len(d) == len(pieces), "the net is not connected"
    print("fold tree: root piece %d (face %d), max depth %d (was %d at piece 0)"
          % (root, pieces[root]["f"], max(d.values()), max(depths(0).values())))

    parent = {root: None}
    for n in sorted(d, key=lambda i: d[i]):
        if n == root:
            continue
        parent[n] = min((m for m in adj[n] if d[m] == d[n] - 1), key=lambda m: m)
    for i, pc in enumerate(pieces):
        pc["parent"] = -1 if i == root else parent[i]
        pc["depth"] = d[i]

    # Hinges: the shared icosahedron edge, wound to match the child's face so
    # a rotation of +ALPHA lifts it the right way.
    for i, pc in enumerate(pieces):
        if pc["parent"] < 0:
            pc["hinge"] = None
            continue
        pf = pieces[pc["parent"]]
        shared = [v for v in faces[pc["f"]] if v in faces[pf["f"]]]
        assert len(shared) == 2, "pieces %d and %d do not share an edge" % (i, pc["parent"])
        idx = {v: k for k, v in enumerate(faces[pc["f"]])}
        u, w = shared
        if (idx[w] - idx[u]) % 3 != 1:
            u, w = w, u
        pc["hingeV"] = (u, w)
        pc["hinge"] = [list(pc["P"][u]), list(pc["P"][w])]

    # Silhouette: wedge edges that only one wedge owns.
    seen = {}
    for pc in pieces:
        for k in pc["wedges"]:
            wb = WEDGES[k]
            pts = [xy(pc["cs"], b) for b in wb]
            for a in range(3):
                e = tuple(sorted((key(pts[a]), key(pts[(a + 1) % 3]))))
                seen.setdefault(e, []).append((pts[a], pts[(a + 1) % 3]))
    boundary = [[list(v[0][0]), list(v[0][1])] for e, v in seen.items() if len(v) == 1]

    xs = [p[0] for pc in pieces for t in pc["tris"] for p in t["p"]]
    ys = [p[1] for pc in pieces for t in pc["tris"] for p in t["p"]]
    folds = {frozenset((pieces[i]["f"], pieces[pieces[i]["parent"]]["f"]))
             for i in range(len(pieces)) if pieces[i]["parent"] >= 0}
    cut_cost = sum(c for k, c in cost.items() if frozenset(edges[k]) not in folds)
    return (pieces, root, boundary,
            (max(xs) - min(xs)) / (max(ys) - min(ys)), cut_cost)


def fuller_net(verts, faces, edges, cost, side, cells):
    """Lay out FULLER_CELLS on the triangular lattice and glue it into a tree."""
    row = math.sqrt(3) / 2                      # cell height, in edge lengths

    def corners(r, c, down):
        yt, yb = r * row, (r + 1) * row
        s = 0.5 * (r % 2)
        s2 = 0.5 * ((r + 1) % 2)
        if down:
            return [(s + c + 0.5, yb), (s + c, yt), (s + c + 1.0, yt)]
        return [(s2 + c + 0.5, yt), (s2 + c, yb), (s2 + c + 1.0, yb)]

    pos = {}
    for f, (r, c, down, tv) in FULLER_CELLS.items():
        cs = corners(r, c, down)
        assert sorted(tv) == sorted(faces[f]), "cell %d is not face %d" % (r, f)
        # image y runs down, the sheet's y runs up
        pos[f] = {tv[i]: (cs[i][0] * side, -cs[i][1] * side) for i in range(3)}

    # Glue: two faces are hinged where their cells share an edge. For this
    # layout that is exactly 19 pairs, so the net is a spanning tree already.
    def shared(a, b):
        pa, pb = pos[a], pos[b]
        return [v for v in pa if v in pb
                and abs(pa[v][0] - pb[v][0]) < 1e-6 * side
                and abs(pa[v][1] - pb[v][1]) < 1e-6 * side]

    adj = {f: [] for f in range(20)}
    links = 0
    for a in range(20):
        for b in range(a + 1, 20):
            if len(shared(a, b)) == 2:
                adj[a].append(b); adj[b].append(a); links += 1
    assert links == 19, "expected a spanning tree, got %d gluings" % links

    root = 0
    parent, queue = {root: None}, [root]
    while queue:
        n = queue.pop(0)
        for m in adj[n]:
            if m not in parent:
                parent[m] = n
                queue.append(m)
    assert len(parent) == 20, "the layout is not connected"

    folds = {frozenset((f, p)) for f, p in parent.items() if p is not None}
    cut_cost = sum(c for k, c in cost.items() if frozenset(edges[k]) not in folds)
    xs = [p[0] for f in pos for p in pos[f].values()]
    ys = [p[1] for f in pos for p in pos[f].values()]
    aspect = (max(xs) - min(xs)) / (max(ys) - min(ys))
    # The lattice already carries Fuller's orientation, so the sheet is not
    # re-turned here; orient_sheet would only rotate it away from the map.
    return (0.0, cut_cost, 0.0, aspect, parent, root, pos, 0.0)
NET_AXIS = (3, 9)
NET_CUT = 4


def canonical_net(faces, edges, axis=NET_AXIS, cut=NET_CUT):
    """Fold tree for the standard band-and-caps net. Returns {face: parent}."""
    north, south = axis
    adj = {i: set() for i in range(20)}
    for (a, b), (f, g) in edges.items():
        adj[f].add(g)
        adj[g].add(f)

    ncap = [i for i, f in enumerate(faces) if north in f]
    scap = [i for i, f in enumerate(faces) if south in f]
    band = [i for i in range(20) if i not in ncap and i not in scap]
    assert len(ncap) == 5 and len(scap) == 5 and len(band) == 10, "axis is not a vertex pair"

    order = [band[0]]                                  # walk the band's 10-cycle
    while len(order) < 10:
        nxt = [g for g in adj[order[-1]] if g in band and g not in order]
        if not nxt:
            break
        order.append(nxt[0])
    assert len(order) == 10 and order[0] in adj[order[-1]], "band is not a cycle"

    chain = order[cut:] + order[:cut]                  # cut it once -> a row
    parent = {chain[0]: None}
    for a, b in zip(chain, chain[1:]):
        parent[b] = a
    for cap in ncap + scap:                            # caps hang off the row
        parent[cap] = next(g for g in adj[cap] if g in band)
    assert len(parent) == 20
    return parent


def pinned_net(verts, faces, normals, edges, cost, side, cells):
    """Lay out the canonical net and report the numbers the search would."""
    parent = canonical_net(faces, edges)
    root = next(f for f, p in parent.items() if p is None)
    pos = unfold(faces, parent, root, side)
    assert not overlaps(faces, pos), "the canonical net overlaps itself"
    pos, turn = orient_sheet(verts, faces, normals, pos, cells)
    folds = {frozenset((f, p)) for f, p in parent.items() if p is not None}
    cut_cost = sum(c for k, c in cost.items() if frozenset(edges[k]) not in folds)
    xs = [p[0] for f in pos for p in pos[f].values()]
    ys = [p[1] for f in pos for p in pos[f].values()]
    aspect = (max(xs) - min(xs)) / (max(ys) - min(ys))
    return (0.0, cut_cost, 0.0, aspect, parent, root, pos, turn)


def pick_net(verts, faces, normals, edges, cost, side, cells, tries=45000, keep=1800):
    """
    Search unfoldings for one that reads as a world map: cheap cuts, land
    gathered near the middle of the sheet, and a screen-shaped outline.

    Depth-first spanning trees of the dual graph give the long zig-zag strips
    that Fuller's net is made of; half the draws break off early, which adds
    the side flaps. Bushy trees (a random MST, say) unfold into pinwheels.
    """
    dual = {i: [] for i in range(20)}
    for k, (a, b) in edges.items():
        dual[a].append((b, k))
        dual[b].append((a, k))

    def draw(root, stop):
        parent, used, stack = {root: None}, set(), [root]
        while stack:
            n = stack[-1]
            nb = [(m, k) for m, k in dual[n] if m not in parent]
            if not nb or (len(stack) > 1 and random.random() < stop):
                stack.pop()
                continue
            m, k = random.choice(nb)
            parent[m] = n
            used.add(k)
            stack.append(m)
        while len(parent) < 20:                  # reattach anything abandoned
            opts = [(n, m, k) for n in parent for m, k in dual[n] if m not in parent]
            n, m, k = random.choice(opts)
            parent[m] = n
            used.add(k)
        return parent, used

    pool, seen = [], set()
    for i in range(tries):
        parent, used = draw(random.randrange(20), 0.0 if i % 2 else 0.22)
        key = frozenset(used)
        if key in seen:
            continue
        seen.add(key)
        pool.append((sum(cost[k] for k in edges if k not in key), parent))
    pool.sort(key=lambda x: x[0])
    floor = max(1.0, pool[0][0])

    land = [(vec(c[1], c[0]), c[2]) for c in cells[::10] if c[2] > 0.05]
    ranked = []
    for cut, parent in pool[:keep]:
        root = next(f for f, p in parent.items() if p is None)
        pos = unfold(faces, parent, root, side)
        if overlaps(faces, pos):
            continue
        pos, turn = orient_sheet(verts, faces, normals, pos, cells)
        pts = [(gnomonic(verts, faces, normals, pos, p), w) for p, w in land]
        tw = sum(w for _, w in pts)
        cx = sum(p[0] * w for p, w in pts) / tw
        cy = sum(p[1] * w for p, w in pts) / tw
        spread = math.sqrt(sum(((p[0] - cx) ** 2 + (p[1] - cy) ** 2) * w for p, w in pts) / tw)
        xs = [p[0] for f in pos for p in pos[f].values()]
        ys = [p[1] for f in pos for p in pos[f].values()]
        aspect = (max(xs) - min(xs)) / (max(ys) - min(ys))
        score = cut / floor + 0.55 * spread + 1.3 * abs(math.log(aspect / ASPECT))
        ranked.append((score, cut, spread, aspect, parent, root, pos, turn))
    ranked.sort(key=lambda r: r[0])
    for r in ranked[:6]:
        print("  candidate: score %.2f cut %.0f spread %.2f aspect %.2f" % (r[0], r[1], r[2], r[3]))
    return ranked[0]


# --------------------------------------------------------------------------
# 4. orient the net north-up, then verify it folds back into the icosahedron
# --------------------------------------------------------------------------
def gnomonic(verts, faces, normals, pos, p):
    best, bd = 0, -9.0
    for i, n in enumerate(normals):
        d = dot(p, n)
        if d > bd:
            bd, best = d, i
    f = faces[best]
    n = normals[best]
    q = tuple(x * (dot(verts[f[0]], n) / dot(p, n)) for x in p)
    a, b, c = verts[f[0]], verts[f[1]], verts[f[2]]
    v0, v1, v2 = sub(b, a), sub(c, a), sub(q, a)
    d00, d01, d11 = dot(v0, v0), dot(v0, v1), dot(v1, v1)
    d20, d21 = dot(v2, v0), dot(v2, v1)
    den = d00 * d11 - d01 * d01
    b1 = (d11 * d20 - d01 * d21) / den
    b2 = (d00 * d21 - d01 * d20) / den
    b0 = 1 - b1 - b2
    pa, pb, pc = pos[best][f[0]], pos[best][f[1]], pos[best][f[2]]
    return (b0 * pa[0] + b1 * pb[0] + b2 * pc[0], b0 * pa[1] + b1 * pb[1] + b2 * pc[1])


def rot_axis(o, d, a):
    ca, sa = math.cos(a), math.sin(a)

    def fn(p):
        q = sub(p, o)
        cd, dd = cross(d, q), dot(d, q)
        return tuple(o[i] + q[i] * ca + cd[i] * sa + d[i] * dd * (1 - ca) for i in range(3))
    return fn


def fold_chains(faces, parent, root, pos, sign):
    kids = {}
    for c, p in parent.items():
        if p is not None:
            kids.setdefault(p, []).append(c)
    chain, hinge = {root: []}, {}
    order, i = [root], 0
    while i < len(order):
        p = order[i]
        i += 1
        for c in kids.get(p, []):
            idx = {v: k for k, v in enumerate(faces[c])}
            shared = [v for v in faces[c] if v in faces[p]]
            u, w = shared
            if (idx[w] - idx[u]) % 3 != 1:          # direct along the child's winding
                u, w = w, u
            hinge[c] = (u, w)
            a, b = pos[c][u], pos[c][w]
            axis = nrm((b[0] - a[0], b[1] - a[1], 0.0))
            chain[c] = [rot_axis((a[0], a[1], 0.0), axis, sign * ALPHA)] + chain[p]
            order.append(c)
    return chain, hinge


def kabsch(p, q):
    n = len(p)
    cp = [sum(x[i] for x in p) / n for i in range(3)]
    cq = [sum(x[i] for x in q) / n for i in range(3)]
    s = [[sum((p[k][i] - cp[i]) * (q[k][j] - cq[j]) for k in range(n)) for j in range(3)] for i in range(3)]
    sxx, sxy, sxz = s[0]
    syx, syy, syz = s[1]
    szx, szy, szz = s[2]
    m = [[sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
         [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
         [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
         [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz]]
    v = [1, 0, 0, 0]
    for _ in range(3000):                            # power iteration for the top eigenvector
        nv = [sum(m[i][j] * v[j] for j in range(4)) + 2.0 * v[i] for i in range(4)]
        k = math.sqrt(sum(x * x for x in nv))
        v = [x / k for x in nv]
    q0, q1, q2, q3 = v
    r = [[q0 * q0 + q1 * q1 - q2 * q2 - q3 * q3, 2 * (q1 * q2 - q0 * q3), 2 * (q1 * q3 + q0 * q2)],
         [2 * (q1 * q2 + q0 * q3), q0 * q0 - q1 * q1 + q2 * q2 - q3 * q3, 2 * (q2 * q3 - q0 * q1)],
         [2 * (q1 * q3 - q0 * q2), 2 * (q2 * q3 + q0 * q1), q0 * q0 - q1 * q1 - q2 * q2 + q3 * q3]]
    t = [cq[i] - sum(r[i][j] * cp[j] for j in range(3)) for i in range(3)]
    rms = math.sqrt(sum(
        math.dist([sum(r[i][j] * p[k][j] for j in range(3)) + t[i] for i in range(3)], q[k]) ** 2
        for k in range(n)) / n)
    return r, t, rms


def preview(path, verts, faces, normals, pos, cells, width=900):
    """Write a PNG of the chosen net so the layout can be eyeballed."""
    import struct
    import zlib

    land = set((int(math.floor(c[0])), int(math.floor(c[1]))) for c in cells)
    xs = [p[0] for f in pos for p in pos[f].values()]
    ys = [p[1] for f in pos for p in pos[f].values()]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    sc = width / (x1 - x0) * 0.97
    height = int((y1 - y0) * sc) + 16
    ox, oy = (width - (x1 - x0) * sc) / 2, 8

    def hit(x, y):
        for f in range(20):
            a, b, c = [pos[f][v] for v in faces[f]]
            den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
            b1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / den
            b2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / den
            b0 = 1 - b1 - b2
            if b1 < 0 or b2 < 0 or b0 < 0:
                continue
            ia, ib, ic = faces[f]
            return nrm([b1 * verts[ia][i] + b2 * verts[ib][i] + b0 * verts[ic][i] for i in range(3)])
        return None

    rows = []
    for py in range(height):
        row = bytearray(b"\x12\x12\x11" * width)
        wy = y1 - (py - oy) / sc
        for px in range(width):
            v = hit(x0 + (px - ox) / sc, wy)
            if v is None:
                continue
            lat = math.degrees(math.asin(max(-1, min(1, v[2]))))
            lon = math.degrees(math.atan2(v[1], v[0]))
            if (int(math.floor(lon)), int(math.floor(lat))) in land:
                col = b"\xd8\xd4\xc6"
            elif abs(lon % 15) < 0.3 or abs(lat % 15) < 0.24:
                col = b"\x5b\x63\x6a"
            else:
                col = b"\x4a\x52\x58"
            row[px * 3:px * 3 + 3] = col
        rows.append(row)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))

    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n"
                 + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                 + chunk(b"IDAT", zlib.compress(raw, 6))
                 + chunk(b"IEND", b""))
    print("preview ->", path)


def preview_pieces(path, verts, faces, side, cells, width=900):
    """Write a PNG of the exact net, so the layout can be eyeballed."""
    import struct
    import zlib

    edges, cost = edge_costs(verts, faces, cells)
    pieces, _, _, _, _ = fuller_exact(verts, faces, edges, cost, side)
    land = set((int(math.floor(c[0])), int(math.floor(c[1]))) for c in cells)
    tris = []
    for pc in pieces:
        for t in pc["tris"]:
            tris.append((t["p"], t["b"], faces[pc["f"]]))

    xs = [p[0] for t in tris for p in t[0]]
    ys = [p[1] for t in tris for p in t[0]]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    sc = width / (x1 - x0) * 0.97
    height = int((y1 - y0) * sc) + 16
    ox, oy = (width - (x1 - x0) * sc) / 2, 8
    rows = [bytearray(b"\x12\x12\x11" * width) for _ in range(height)]

    for p, b, fv in tris:
        a, bb, c = [((q[0] - x0) * sc + ox, oy + (y1 - q[1]) * sc) for q in p]
        den = (bb[1] - c[1]) * (a[0] - c[0]) + (c[0] - bb[0]) * (a[1] - c[1])
        if abs(den) < 1e-9:
            continue
        for py in range(max(0, int(min(a[1], bb[1], c[1]))),
                        min(height, int(max(a[1], bb[1], c[1])) + 2)):
            for px in range(max(0, int(min(a[0], bb[0], c[0]))),
                            min(width, int(max(a[0], bb[0], c[0])) + 2)):
                w1 = ((bb[1]-c[1])*(px-c[0]) + (c[0]-bb[0])*(py-c[1])) / den
                w2 = ((c[1]-a[1])*(px-c[0]) + (a[0]-c[0])*(py-c[1])) / den
                w0 = 1 - w1 - w2
                if w1 < -0.002 or w2 < -0.002 or w0 < -0.002:
                    continue
                fb = [w1*b[0][j] + w2*b[1][j] + w0*b[2][j] for j in range(3)]
                v = nrm([sum(fb[j] * verts[fv[j]][q] for j in range(3)) for q in range(3)])
                lat = math.degrees(math.asin(max(-1, min(1, v[2]))))
                lon = math.degrees(math.atan2(v[1], v[0]))
                if (int(math.floor(lon)), int(math.floor(lat))) in land:
                    col = b"\xd8\xd4\xc6"
                elif abs(lon % 15) < 0.3 or abs(lat % 15) < 0.24:
                    col = b"\x5b\x63\x6a"
                else:
                    col = b"\x4a\x52\x58"
                rows[py][px*3:px*3+3] = col

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))

    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n"
                 + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                 + chunk(b"IDAT", zlib.compress(raw, 6))
                 + chunk(b"IEND", b""))
    print("preview ->", path)


def fold_chains_pieces(pieces, root, sign):
    """Hinge rotations from each piece up to the root, parent applied last."""
    kids = {}
    for i, pc in enumerate(pieces):
        if pc["parent"] >= 0:
            kids.setdefault(pc["parent"], []).append(i)
    chain = {root: []}
    order, i = [root], 0
    while i < len(order):
        p = order[i]; i += 1
        for c in kids.get(p, []):
            u, w = pieces[c]["hingeV"]
            a, b = pieces[c]["P"][u], pieces[c]["P"][w]
            axis = nrm((b[0] - a[0], b[1] - a[1], 0.0))
            chain[c] = [rot_axis((a[0], a[1], 0.0), axis, sign * ALPHA)] + chain[p]
            order.append(c)
    return chain


def emit_exact(verts, faces, side, cells, out_path):
    """Build, verify and write Fuller's exact 22-piece net."""
    edges, cost = edge_costs(verts, faces, cells)
    pieces, root, boundary, aspect, cut_cost = fuller_exact(verts, faces, edges, cost, side)

    xs = [p[0] for pc in pieces for t in pc["tris"] for p in t["p"]]
    ys = [p[1] for pc in pieces for t in pc["tris"] for p in t["p"]]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    for pc in pieces:
        pc["P"] = {v: (p[0] - cx, p[1] - cy) for v, p in pc["P"].items()}
        pc["cs"] = [(p[0] - cx, p[1] - cy) for p in pc["cs"]]
        for t in pc["tris"]:
            t["p"] = [[p[0] - cx, p[1] - cy] for p in t["p"]]
        if pc["hinge"]:
            pc["hinge"] = [[p[0] - cx, p[1] - cy] for p in pc["hinge"]]
    boundary = [[[a[0] - cx, a[1] - cy], [b[0] - cx, b[1] - cy]] for a, b in boundary]
    print("net: %d pieces, cut cost %.0f, %.2f x %.2f (aspect %.2f), %d silhouette edges"
          % (len(pieces), cut_cost, max(xs) - min(xs), max(ys) - min(ys), aspect, len(boundary)))

    verify_and_write(verts, faces, side, pieces, root, boundary, out_path,
                     "// The net is Fuller's own published arrangement, as 22 rigid pieces: 18\n"
                     "// whole faces plus two faces he cuts along a median, each in two parts.\n")


def pieces_from_faces(faces, parent, root, pos):
    """
    Wrap a plain 20-face net as pieces, so the older layouts still emit data
    the renderer can read. Each face becomes one whole-triangle piece.
    """
    depth = {}

    def d(f):
        if f not in depth:
            depth[f] = 0 if parent[f] is None else d(parent[f]) + 1
        return depth[f]

    pieces = []
    for f in range(20):
        tri = faces[f]
        ident = [[1.0 if j == i else 0.0 for j in range(3)] for i in range(3)]
        pc = {"f": f, "parent": -1 if f == root else parent[f], "depth": d(f),
              "P": {v: pos[f][v] for v in tri}, "cs": [pos[f][v] for v in tri],
              "tris": [{"p": [list(pos[f][v]) for v in tri], "b": ident}]}
        if f != root:
            idx = {v: k for k, v in enumerate(tri)}
            shared = [v for v in tri if v in faces[parent[f]]]
            u, w = shared
            if (idx[w] - idx[u]) % 3 != 1:
                u, w = w, u
            pc["hingeV"] = (u, w)
            pc["hinge"] = [list(pos[f][u]), list(pos[f][w])]
        else:
            pc["hinge"] = None
        pieces.append(pc)
    return pieces


def verify_and_write(verts, faces, side, pieces, root, boundary, out_path, note):
    """Check every piece folds back onto its face, then write the data module."""
    best = None
    for sign in (1, -1):
        chain = fold_chains_pieces(pieces, root, sign)
        src, dst = [], []
        for i, pc in enumerate(pieces):
            for v in faces[pc["f"]]:
                p = (pc["P"][v][0], pc["P"][v][1], 0.0)
                for fn in chain[i]:
                    p = fn(p)
                src.append(p); dst.append(verts[v])
        r, t, rms = kabsch(src, dst)
        print("  fold sign %+d -> alignment rms %.2e over %d corners" % (sign, rms, len(src)))
        if best is None or rms < best[0]:
            best = (rms, sign, r, t)
    rms, sign, r, t = best
    assert rms < 1e-9, "the net does not fold back onto the icosahedron"

    out = {
        "verts": [list(v) for v in verts],
        "faces": [list(f) for f in faces],
        "boundary": boundary,
        "pieces": [{"f": pc["f"], "parent": pc["parent"], "depth": pc["depth"],
                    "hinge": pc["hinge"], "tris": pc["tris"]} for pc in pieces],
        "root": root,
        "maxDepth": max(pc["depth"] for pc in pieces),
        "foldAngle": sign * ALPHA,
        "align": {"R": r, "t": t},
        "edgeLen": side,
    }
    with open(out_path, "w") as fh:
        fh.write("// GENERATED by python_scripts/build_dymaxion.py -- do not edit by hand.\n"
                 "// Icosahedron in R. Buckminster Fuller's Dymaxion orientation:\n"
                 "// vertex 0 at 2.3008820N 5.245390W, adjacent vertex at azimuth 7.46658 deg.\n"
                 + note
                 + "export const DYMAXION = " + json.dumps(out) + ";\n")
    print("wrote %s (%d pieces)" % (out_path, len(pieces)))


def main():
    verts, faces = icosahedron()
    side = math.dist(verts[faces[0][0]], verts[faces[0][1]])
    print("icosahedron: 12 vertices, 20 faces, side %.6f" % side)

    if "--whole" not in sys.argv and "--search" not in sys.argv and "--canonical" not in sys.argv:
        cells = land_cells()
        print("land mask: %d cells at 1deg" % len(cells))
        emit_exact(verts, faces, side, cells, OUT)
        if "--preview" in sys.argv:
            preview_pieces(sys.argv[sys.argv.index("--preview") + 1], verts, faces, side, cells)
        return

    cells = land_cells()
    print("land mask: %d cells at 1deg" % len(cells))
    edges, cost = edge_costs(verts, faces, cells)
    normals = [nrm(cross(sub(verts[f[1]], verts[f[0]]), sub(verts[f[2]], verts[f[0]]))) for f in faces]

    if "--search" in sys.argv:
        score, cut, spread, aspect, parent, root, pos, turn = pick_net(
            verts, faces, normals, edges, cost, side, cells)
    elif FULLER_NET and "--canonical" not in sys.argv:
        score, cut, spread, aspect, parent, root, pos, turn = fuller_net(
            verts, faces, edges, cost, side, cells)
    else:
        score, cut, spread, aspect, parent, root, pos, turn = pinned_net(
            verts, faces, normals, edges, cost, side, cells)
    xs = [p[0] for f in pos for p in pos[f].values()]
    ys = [p[1] for f in pos for p in pos[f].values()]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    pos = {f: {v: (p[0] - cx, p[1] - cy) for v, p in d.items()} for f, d in pos.items()}
    print("net: root %d, cut cost %.0f, land spread %.2f, %.2f x %.2f (aspect %.2f), turned %.0fdeg"
          % (root, cut, spread, max(xs) - min(xs), max(ys) - min(ys), aspect, math.degrees(turn)))
    if "--preview" in sys.argv:
        preview(sys.argv[sys.argv.index("--preview") + 1], verts, faces, normals, pos, cells)

    # The sheet's silhouette: triangle edges that are cut rather than folded.
    # The grid deformation is held to zero along these, so the outline stays a
    # true icosahedron net and could still be folded back into a globe.
    folded_pairs = set()
    for f in range(20):
        if f != root:
            folded_pairs.add(frozenset((f, parent[f])))
    boundary = []
    for f in range(20):
        tri = faces[f]
        for i in range(3):
            a, b = tri[i], tri[(i + 1) % 3]
            other = next((g for g in range(20) if g != f and a in faces[g] and b in faces[g]), None)
            if other is not None and frozenset((f, other)) in folded_pairs:
                continue                       # hinge, stays interior to the sheet
            boundary.append([list(pos[f][a]), list(pos[f][b])])
    assert len(boundary) == 22, len(boundary)
    print("net boundary: %d cut edges" % len(boundary))

    # Wrapped as pieces so the renderer reads one shape of data either way.
    parent_map = {f: (None if f == root else parent[f]) for f in range(20)}
    pieces = pieces_from_faces(faces, parent_map, root, pos)
    verify_and_write(verts, faces, side, pieces, root, boundary, OUT,
                     "// This is a net of 20 whole triangles, not Fuller's exact arrangement\n"
                     "// (he cuts two faces along a median); see FULLER_PIECES for that.\n")


if __name__ == "__main__":
    main()
