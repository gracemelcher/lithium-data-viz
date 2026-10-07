// Scene, timeline and interaction.
//
// The whole thing is one 30-second shot: globe -> icosahedron -> unfolded
// Dymaxion net -> grid deformed by the trade data. When the shot ends the
// camera is overhead, the sheet is exactly the z = 0 plane in net coordinates,
// and the page becomes an ordinary interactive map.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildBaseMap } from './texture.js';
import { buildSheet } from './mesh.js';
import {
  makeWarpUniforms, setWarpSources, setWarpBlend, advanceWarpSlot, warpPoint, borderHold,
} from './warp.js';
import { Overlay, countryVectors, HEAT_MAX_CATS } from './flows.js';
import {
  loadWorld, loadTrade, loadCaseStudies, slice, sliceUnion, topFlows, totals, formatValue,
} from './data.js';
import { lonLatToNet, latLonToVec, PIECE_PTS, BOUNDARY } from './geo.js';
import { buildOrbits } from './orbits.js';
import {
  COMMODITY_GROUPS, PHASES, SPIN_RATE, CAMERA_FOV, NODE_SIZE, HEAT, WARP, LANDING, ROLODEX,
  TIMELINE, CATEGORIES, TITLE, VALUE_FIELD, VALUE_FORMAT,
  DEFAULT_YEAR, DEFAULT_METRIC, DEFAULT_DEFORMATION, TRADE_CSV, MAX_FLOWS_PER_GROUP_YEAR,
} from './config.js';

const FOV = CAMERA_FOV;
const POINT_REF = 6.0;            // distance at which a node's size is in CSS px
const SPIN_UNTIL = PHASES[0][1] + PHASES[1][1];

const starts = [];
let acc = 0;
for (const [, d] of PHASES) { starts.push(acc); acc += d; }
const TOTAL = acc;
const phaseAt = (id) => PHASES.findIndex((p) => p[0] === id);

/**
 * How far the title has faded at time t, 0 to 1. Measured against a phase
 * rather than against the clock: with absolute seconds, shortening the opening
 * phases leaves the title still up well into the unfold.
 */
function titleFade(t) {
  const u = (localOf(t, TITLE.fadePhase) - TITLE.fadeStart)
    / Math.max(1e-6, TITLE.fadeEnd - TITLE.fadeStart);
  return smooth(u < 0 ? 0 : u > 1 ? 1 : u);
}
const localOf = (t, id) => {
  const i = phaseAt(id);
  return THREE.MathUtils.clamp((t - starts[i]) / PHASES[i][1], 0, 1);
};
const local = localOf;
const smooth = (x) => x * x * (3 - 2 * x);

/**
 * How long before the settle phase its camera move starts easing in, in
 * seconds, so it overlaps the end of the unfold instead of beginning where
 * that one stops. Capped at 40% of the unfold so a short unfold cannot have
 * the settle running through most of it.
 */
const SETTLE_LEAD = 1.4;
const mixN = (a, b, t) => a + (b - a) * t;
/** Case-study prose comes straight from a CSV, so it never reaches the DOM raw. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const spinAt = (t) => {
  const u = THREE.MathUtils.clamp(t / SPIN_UNTIL, 0, 1);
  return SPIN_RATE * SPIN_UNTIL * (u - u * u / 2);
};
const SPIN_END = spinAt(SPIN_UNTIL);

/**
 * Which category supplies a study's colour. Most studies carry several
 * impacts, so the choice answers to the highlight: with nothing selected it is
 * the first category the study lists, and with a filter on it is the first
 * *selected* category the study matches — otherwise filtering for Cultural
 * would light Thacker Pass in the Water Use blue it happens to list first.
 * Shared by the map markers and heat blobs, the timeline dashes and the tiles,
 * so the three never disagree about what colour a study is.
 */
function studyCategory(study, state) {
  const has = (c) => study && study.impacts && study.impacts.includes(c.key);
  return (state.cats.size && CATEGORIES.find((c) => has(c) && state.cats.has(c.key)))
    || CATEGORIES.find(has)
    || null;
}

/**
 * Every category a site should currently be shown in, in CATEGORIES order.
 *
 * With a filter on, that is all of the selected categories the site matches —
 * a site that answers to two of them is in two, and gets a share of each
 * colour rather than being silently reduced to whichever came first. With
 * nothing selected it is the single leading category, which is the resting
 * look: showing every site in all of its colours at once would make the map a
 * fruit salad before the reader has asked a question of it.
 *
 * Capped at HEAT_MAX_CATS, which is what the blob shader carries.
 */
function studyCategories(study, state) {
  const has = (c) => study && study.impacts && study.impacts.includes(c.key);
  if (!state.cats.size) {
    const one = CATEGORIES.find(has);
    return one ? [one] : [];
  }
  const hit = CATEGORIES.filter((c) => has(c) && state.cats.has(c.key));
  return hit.slice(0, HEAT_MAX_CATS);
}

/** That category's colour, or null if the study has none. */
function categoryHex(study, state) {
  const hit = studyCategory(study, state);
  return hit ? hit.color : null;
}

/** Every colour the site is currently shown in, in CATEGORIES order. */
function categoryHexes(study, state) {
  return studyCategories(study, state).map((c) => c.color);
}

function tokens() {
  const s = getComputedStyle(document.documentElement);
  const t = (n) => s.getPropertyValue(n).trim();
  return {
    surface: t('--surface'), ocean: t('--ocean'), land: t('--land'),
    coast: t('--land-edge'), graticule: t('--land-edge'), equator: t('--text-muted'),
    equatorOpacity: 0.55, grid: t('--land-edge'),
    ink: t('--ink'), node: t('--node'), accent: t('--accent'), focus: t('--focus'),
    salt: t('--salt'), study: '#ffffff',
    exportHue: t('--export'), importHue: t('--import'),
    edge: t('--land-edge'),
  };
}

export async function start() {
  const colors = tokens();
  const loadingEl = document.getElementById('loading');
  const say = (msg) => { loadingEl.textContent = msg; };

  say('reading the world outline…');
  const { features, positions } = await loadWorld();

  const short = TRADE_CSV.split('/').pop();
  const data = await loadTrade(positions, (read, total) => {
    const mb = (read / 1048576).toFixed(0);
    say(total ? `reading ${short} — ${mb} of ${(total / 1048576).toFixed(0)} MB`
              : `reading ${short} — ${mb} MB`);
  });
  if (!data.years.length) throw new Error(`${TRADE_CSV} produced no usable flows`);
  say('drawing the map…');

  const studies = await loadCaseStudies(positions);

  const netPos = new Map();
  for (const [name, ll] of positions) netPos.set(name, lonLatToNet(ll[0], ll[1]));
  const vecs = countryVectors(positions);
  const catColor = new Map(COMMODITY_GROUPS.map((c) => [c.key, new THREE.Color(
    getComputedStyle(document.documentElement).getPropertyValue(c.token).trim())]));
  const fmt = (v) => formatValue(v, data.format);

  /* ---------------------------------------------------------- scene ---- */

  const canvas = document.getElementById('stage');
  // Transparent clear, onto the body's own background in the same colour. It
  // costs nothing visually and it lets the title sit on the page *behind* the
  // canvas, so the globe can cover it.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(new THREE.Color(colors.surface), 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 100);

  const warpUniforms = makeWarpUniforms();
  const map = buildBaseMap(features, colors,
    renderer.capabilities.maxTextureSize);
  const sheet = buildSheet(map, warpUniforms, colors);
  sheet.setSpinTarget(new THREE.Quaternion());
  scene.add(sheet.group);

  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(1.07, 64, 48),
    new THREE.ShaderMaterial({
      transparent: true, side: THREE.BackSide, depthWrite: false,
      uniforms: { uColor: { value: new THREE.Color(colors.edge) }, uOpacity: { value: 1 } },
      vertexShader: `varying vec3 vN; varying vec3 vP;
        void main(){ vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position,1.0); vP = mv.xyz;
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uColor; uniform float uOpacity; varying vec3 vN; varying vec3 vP;
        void main(){ float f = pow(1.0 - abs(dot(normalize(vN), normalize(-vP))), 3.0);
          gl_FragColor = vec4(uColor, f * 0.5 * uOpacity); }`,
    }));
  scene.add(halo);

  // The map's own outline: the net's 46 cut edges, drawn as one thin ink line
  // so the sheet reads as a cut piece of paper rather than as wherever the
  // land happens to stop. It needs no warp — the deformation is zero along
  // these edges by construction, whichever mode is running (the elastic solve
  // pins them; the analytic field holds them) — so the geometry is built once
  // and never touched again.
  const borderPts = [];
  for (const [a, b] of BOUNDARY) borderPts.push(a[0], a[1], 0.03, b[0], b[1], 0.03);
  const borderGeo = new THREE.BufferGeometry();
  borderGeo.setAttribute('position', new THREE.Float32BufferAttribute(borderPts, 3));
  const mapBorder = new THREE.LineSegments(borderGeo, new THREE.LineBasicMaterial({
    color: new THREE.Color(colors.ink),
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
  }));
  mapBorder.renderOrder = 30;      // over the routes and the markers
  mapBorder.frustumCulled = false;
  mapBorder.visible = false;
  // Driven from the sheet, not left in world space. `setPose` carries the
  // whole sheet on a transform that only reaches its resting value when
  // `present` hits 1 at the very end of the settle — so an outline fixed in
  // the z = 0 plane is in the wrong place for the whole of the settle and
  // snaps into alignment at the last moment, which is what the fade looked
  // wrong. Once the fold is open every piece's matrix is that same transform,
  // so copying one of them is enough.
  mapBorder.matrixAutoUpdate = false;
  scene.add(mapBorder);

  /** The outline only means anything once the sheet is flat. */
  function setBorder(v) {
    mapBorder.material.opacity = v;
    mapBorder.visible = v > 0.002;
    if (mapBorder.visible) {
      mapBorder.matrix.copy(sheet.meshes[0].matrix);
      mapBorder.matrixWorldNeedsUpdate = true;
    }
  }

  const overlay = new Overlay(scene, warpUniforms, colors);
  overlay.pointUniforms.uScale.value = POINT_REF * renderer.getPixelRatio();
  overlay.dotUniforms.uScale.value = POINT_REF * renderer.getPixelRatio();
  overlay.heatUniforms.uCoreGain.value = HEAT.coreGain;

  const controls = new OrbitControls(camera, canvas);
  controls.enableRotate = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.screenSpacePanning = true;
  controls.minDistance = 1.6;
  controls.maxDistance = 14;
  controls.enabled = false;

  let settled = false;
  let orbitScale = null;    // set once the orbits exist; resize() may run first
  const enterQuat = new THREE.Quaternion();   // how the globe was turned at Enter
  const poseQuat = new THREE.Quaternion();    // scratch: enterQuat then the shot's spin
  const spinQuat = new THREE.Quaternion();
  const ZAXIS_ = new THREE.Vector3(0, 0, 1);
  /** The globe's orientation t seconds into the shot. */
  const shotRotation = (t) => poseQuat.copy(enterQuat)
    .multiply(spinQuat.setFromAxisAngle(ZAXIS_, spinAt(t)));
  function resize() {
    const w = innerWidth, h = innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    overlay.pointUniforms.uScale.value = POINT_REF * renderer.getPixelRatio();
    overlay.dotUniforms.uScale.value = POINT_REF * renderer.getPixelRatio();
    if (orbitScale) orbitScale(POINT_REF * renderer.getPixelRatio());
    fitDist = null;                 // the framing depends on the aspect
    measureMasthead();              // the heading is clamp()-sized and rewraps
    placePanel();
    if (settled) restCamera();
  }
  addEventListener('resize', resize);

  // The sheet swings a long way while it opens, so rather than keyframing
  // camera positions, every frame solves for the distance that just contains
  // every piece's corners. Only the viewing direction is animated.
  const CORNERS = PIECE_PTS.map((pts) =>
    pts.map((p) => new THREE.Vector3(p[0], p[1], 0)));
  const POINTS = CORNERS.flat().map(() => new THREE.Vector3());
  const dir = new THREE.Vector3(), up = new THREE.Vector3(), right = new THREE.Vector3();
  const mid = new THREE.Vector3(), target = new THREE.Vector3();
  // The globe is viewed from -Y, not +Y, and that sign is not cosmetic.
  // `right` is cross(dir, up); with the globe's pole up (+Z) that makes
  // right.x = dir.y, while the finished flat map — seen front-on with its own
  // north up — needs right.x = +1. Put the globe camera on the +Y side and
  // the two ends of the swing are exactly 180 degrees apart, so `right`
  // collapses to zero partway through (at k = 0.536) and the whole view
  // mirrors in a single frame. That was the flip in the middle of the
  // unfolding. From -Y the swing is a smooth 70 degree tilt with no
  // singularity, and GLOBE_LON below keeps the same face of the Earth toward
  // the camera as before.
  const DIR_A = new THREE.Vector3(0, 0.94, 0.34).normalize();
  // The flat sheet's front faces +Z, and the camera is placed at
  // target - dir * d, so this has to be -Z: with +Z we ended up behind the
  // sheet and the whole map read mirrored.
  const DIR_B = new THREE.Vector3(0, 0, -1);
  const UP_A = new THREE.Vector3(0, 0, 1);
  const UP_B = new THREE.Vector3(0, 1, 0);
  // Offsets are a fraction of the viewport's width: +0.25 pushes what we are
  // looking at a quarter-screen to the left, whatever the distance ends up.
  // Nudge the sheet right so the control panel does not sit on top of it.
  // Fuller's net puts Australia at the left end and the crowded part of the
  // map centre-right, so this needs far less offset than a net with the
  // Americas on the left did.
  const OFFSET_X = -0.085;
  // The timeline sits in the bottom ~74px and its tiles stand on top of that,
  // 84px tall at 84px up — so this much of the screen bottom is theirs, and
  // the map is framed above it. In pixels rather than a fraction because the
  // strip it clears is a fixed size.
  // The bottom band the map keeps out of: the timeline, its tiles, and the
  // total-trade graph beneath the axis, which grows the block upward.
  const KEEP_CLEAR_PX = 184 + TIMELINE.chartHeight;
  const keepClear = () => KEEP_CLEAR_PX / Math.max(400, innerHeight);

  // The landing's masthead — the lithium tile, the heading and Enter — owns the
  // left column, and the globe is sized from the viewport HEIGHT, so a tall
  // narrow window grows it straight through the type. Measured from the
  // elements rather than fixed, because the heading is clamp()-sized and the
  // wrap changes with the viewport; re-measured on resize, never per frame,
  // since reading a rect forces layout.
  const LEFT_GUTTER_PX = 34;        // air between the masthead and the globe
  // The globe stays centred; the reserve only caps how large it may grow
  // before it reaches the type. Capped in turn so a very wide masthead cannot
  // shrink it away to nothing.
  const KEEP_LEFT_MAX = 0.30;
  let keepLeftPx = 0;
  function measureMasthead() {
    let right = 0;
    for (const sel of ['#title h1', '#title .mark', '#enterBar']) {
      const el = document.querySelector(sel);
      if (el) right = Math.max(right, el.getBoundingClientRect().right);
    }
    keepLeftPx = right ? right + LEFT_GUTTER_PX : 0;
  }
  const keepLeft = () =>
    Math.min(KEEP_LEFT_MAX, keepLeftPx / Math.max(600, innerWidth));

  // Where the key sits down the page, as a fraction: its middle lands on this
  // line. 1/2 is centred; 1/3 carries it up into the top third.
  const PANEL_AT = 1 / 3;
  // Measured rather than expressed in CSS, because the panel's own height
  // changes with the viewport — the heading rewraps — and a percentage `top`
  // with a translate cannot know about the timeline strip below, which a
  // column this tall will run into on a short window.
  function placePanel() {
    const el = document.getElementById('panel');
    if (!el) return;
    const h = el.offsetHeight;
    const floor = innerHeight - KEEP_CLEAR_PX;     // the strip the map clears too
    const want = innerHeight * PANEL_AT - h / 2;
    el.style.top = Math.round(Math.max(24, Math.min(want, floor - h))) + 'px';
  }
  const LANDING_MARGIN = 1.52;      // room for the orbiting routes around the globe
  const LANDING_OFFSET = 0;         // centred on the page
  const STUDY_OFFSET = 0.25;        // globe to the left half while a case study is open
  // Barely smaller: the globe's diameter on screen is viewport height /
  // margin, and once it has slid left it already clears the panel.
  const STUDY_MARGIN = 1.15;

  // Solved exactly: the distance that just contains every piece's corners.
  // The intro does not call this per frame — see buildIntroPath — because the
  // exact fit is not monotonic and following it judders. The landing and the
  // resting map are static poses, so the exact fit is right for them.
  /**
   * @param {number} k           0 = globe framing, 1 = flat-map framing
   * @param {number} margin      how much slack around the subject
   * @param {number} offsetFrac  sideways shift, as a fraction of the width
   * @param {number} keepClear   fraction of the viewport HEIGHT to leave free
   *                             along the bottom, so the timeline and its
   *                             tiles do not sit on top of the map
   * @param {number} keepLeft    a band along the left edge, as a fraction of
   *                             the viewport WIDTH, that the subject must stay
   *                             out of, so the landing's masthead has the
   *                             column to itself. Unlike `keepClear` this only
   *                             tightens the limit — it does not re-centre, so
   *                             the globe stays in the middle of the page and
   *                             simply stops growing when it reaches the type.
   */
  function frameCamera(k, margin, offsetFrac, keepClear = 0, keepLeft = 0) {
    let i = 0;
    for (let f = 0; f < CORNERS.length; f++) {
      for (const c of CORNERS[f]) POINTS[i++].copy(c).applyMatrix4(sheet.meshes[f].matrix);
    }
    dir.copy(DIR_A).lerp(DIR_B, k).normalize();
    up.copy(UP_A).lerp(UP_B, k).normalize();
    right.crossVectors(dir, up).normalize();
    up.crossVectors(right, dir).normalize();

    mid.set(0, 0, 0);
    for (const p of POINTS) mid.add(p);
    mid.divideScalar(POINTS.length);

    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of POINTS) {
      const x = p.dot(right) - mid.dot(right), y = p.dot(up) - mid.dot(up);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const tan = Math.tan((FOV * Math.PI) / 360);

    // Offsetting pushes the far side of the subject further off-axis, which
    // needs more distance, which widens the frustum, which changes what the
    // offset is worth — and reserving a band along the bottom does the same in
    // the other axis. Iterate until they agree.
    //
    // `keepClear` drops the target below the subject's centre, which is what
    // lifts the map clear of the strip along the bottom. The vertical limits
    // then have to be one-sided: the top edge is the full half-height away,
    // the bottom edge only as far as the band leaves. Using one symmetric
    // limit measured from the lowered target counts the offset twice and
    // leaves the map about a third smaller than it needs to be.
    const floorFrac = Math.max(0.2, 1 - 2 * keepClear);
    const leftFrac = Math.max(0.2, 1 - 2 * keepLeft);
    let offset = 0, lift = 0, d = 2.0;
    for (let pass = 0; pass < 6; pass++) {
      const cx = (x0 + x1) / 2 + offset, cy = (y0 + y1) / 2 - lift;
      target.copy(mid).addScaledVector(right, cx).addScaledVector(up, cy);
      d = 2.0;
      for (const p of POINTS) {
        const xs = p.dot(right) - target.dot(right);     // signed, no slack
        const x = Math.abs(xs) * margin;
        const y = (p.dot(up) - target.dot(up)) * margin;
        const z = p.dot(dir) - target.dot(dir);
        d = Math.max(d, x / (tan * camera.aspect) - z,
          y / tan - z,                      // clears the top of the screen
          -y / (tan * floorFrac) - z);      // clears the reserved band below
        // The left band is a hard edge, not slack, so it is measured on the
        // raw extent. Multiplying it by `margin` as well counts the same
        // allowance twice and shrinks the subject far below what the band
        // actually demands — the globe came out smaller than with no reserve
        // at all.
        if (keepLeft > 0) d = Math.max(d, -xs / (tan * camera.aspect * leftFrac) - z);
      }
      if (!offsetFrac && !keepClear) break;
      const nextOffset = offsetFrac * 2 * d * tan * camera.aspect;
      const nextLift = keepClear * d * tan;
      if (Math.abs(nextOffset - offset) < 1e-3 && Math.abs(nextLift - lift) < 1e-3) break;
      offset = nextOffset; lift = nextLift;
    }

    camera.up.copy(up);
    camera.position.copy(target).addScaledVector(dir, -d);
    camera.lookAt(target);
    return d;
  }

  /**
   * Everything about the intro's framing at time t, in one place, so the live
   * loop and the precomputed camera path cannot drift apart.
   *
   * `fold` is linear because mesh.js eases each hinge across its own slice;
   * easing here as well would double up. `present` turns the sheet to face
   * the camera and swings the camera round to meet it — tied to the fold,
   * because on its own slower ramp it left the sheet nearly flat while the
   * camera was only a third of the way round, so the map was seen almost
   * edge-on and collapsed to a sliver partway through.
   */
  function introShot(t) {
    const opened = local(t, 'unfold');                // 0 folded, 1 flat
    // The settle term is given a head start so that it is already moving when
    // the unfold finishes. Both halves are smoothstepped, so meeting them end
    // to end puts a zero-rate instant between them: the shot eases out, stands
    // still for a beat, then eases in again. That reads as a hitch right
    // before the map comes to rest, and it gets worse the more the two phases
    // differ in length. Overlapping them leaves no seam to see.
    const settleSecs = PHASES[phaseAt('settle')][1];
    const lead = Math.min(SETTLE_LEAD, PHASES[phaseAt('unfold')][1] * 0.4);
    const u = THREE.MathUtils.clamp(
      (t - starts[phaseAt('settle')] + lead) / (settleSecs + lead), 0, 1);
    // Ease *out*, not in-out. A smoothstep peaks in the middle of its own
    // window, which lands well after the fold has finished: the sheet eases to
    // a near stop as the last hinge closes and then picks up a second,
    // accelerating turn, which reads as a glitch right at the end of the
    // unfold. An ease-out is fastest where the fold is still carrying the
    // motion and decays from there, so the two hand over without the sheet
    // ever stopping and restarting. It still arrives at rest, since its rate
    // is zero at the end.
    const settleRamp = 1 - (1 - u) * (1 - u);
    const present = Math.min(1, 0.85 * smooth(opened) + 0.15 * settleRamp);
    const settleIn = smooth(THREE.MathUtils.clamp(t / 2.6, 0, 1));
    const push = smooth(THREE.MathUtils.clamp(t / SPIN_UNTIL, 0, 1));
    return {
      fold: 1 - opened,
      present,
      margin: mixN(LANDING_MARGIN, 1.30 - 0.12 * push - 0.13 * present, settleIn),
      offsetFrac: mixN(LANDING_OFFSET, OFFSET_X * present, settleIn),
      keepClear: keepClear() * present,
      // The masthead's column is still reserved as the shot begins, and is
      // released exactly as the title fades. Without this the globe jumps left
      // the instant Enter is pressed, because the landing holds the column and
      // the first frame of the intro would not.
      keepLeft: keepLeft() * (1 - titleFade(t)),
    };
  }

  // The exact per-frame fit is not monotonic — as the pieces swing the
  // silhouette grows and shrinks again — so following it dollies the camera
  // in, back out and in again. No causal filter fixes that: damping it
  // smoothly lags and clips the sheet, and snapping outward to avoid clipping
  // puts a corner in the motion every time it switches. But the intro is
  // deterministic in t, so the whole path is solved up front and smoothed
  // with an envelope: for each sample take the largest fit over a window,
  // then average over that same window. Every value averaged in is at least
  // the fit at that sample, so the result can never clip, and averaging
  // leaves no corners. Rebuilt whenever the viewport changes.
  const FIT_STEP = 0.05;            // seconds between samples
  const FIT_WIN = 4;                // samples either side, per smoothing pass
  const FIT_PASSES = 2;             // two passes, so acceleration is smooth too
  let fitDist = null, fitTarget = null;

  const clampIdx = (i, n) => (i < 0 ? 0 : i > n - 1 ? n - 1 : i);

  function smoothPass(src, n, stride) {
    const out = new Float64Array(src.length);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < stride; c++) {
        let sum = 0;
        for (let j = i - FIT_WIN; j <= i + FIT_WIN; j++) sum += src[clampIdx(j, n) * stride + c];
        out[i * stride + c] = sum / (2 * FIT_WIN + 1);
      }
    }
    return out;
  }

  function buildIntroPath() {
    const n = Math.ceil(TOTAL / FIT_STEP) + 1;
    const need = new Float64Array(n);
    const tg = new Float64Array(n * 3);
    const keep = state.t;
    for (let i = 0; i < n; i++) {
      const t = Math.min(i * FIT_STEP, TOTAL);
      const sh = introShot(t);
      sheet.setPose(sh.fold, sh.present, shotRotation(t));
      need[i] = frameCamera(sh.present, sh.margin, sh.offsetFrac, sh.keepClear, sh.keepLeft);
      tg[i * 3] = target.x; tg[i * 3 + 1] = target.y; tg[i * 3 + 2] = target.z;
    }
    // The envelope spans everything the smoothing passes can reach, so every
    // sample averaged in is at least the fit at the sample being written —
    // which is what makes clipping impossible however much this is smoothed.
    const reach = FIT_WIN * FIT_PASSES;
    let env = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let hi = 0;
      for (let j = i - reach; j <= i + reach; j++) hi = Math.max(hi, need[clampIdx(j, n)]);
      env[i] = hi;
    }
    let tgt = tg;
    for (let p = 0; p < FIT_PASSES; p++) {
      env = smoothPass(env, n, 1);
      tgt = smoothPass(tgt, n, 3);
    }
    fitDist = env;
    fitTarget = tgt;
    state.t = keep;
  }

  /** Put the camera on the precomputed path at time t. */
  function introCamera(t) {
    if (!fitDist) buildIntroPath();
    const u = THREE.MathUtils.clamp(t / FIT_STEP, 0, fitDist.length - 1);
    const i = Math.min(fitDist.length - 2, Math.floor(u)), f = u - i;
    const sh = introShot(t);
    dir.copy(DIR_A).lerp(DIR_B, sh.present).normalize();
    up.copy(UP_A).lerp(UP_B, sh.present).normalize();
    right.crossVectors(dir, up).normalize();
    up.crossVectors(right, dir).normalize();
    target.set(
      mixN(fitTarget[i * 3], fitTarget[(i + 1) * 3], f),
      mixN(fitTarget[i * 3 + 1], fitTarget[(i + 1) * 3 + 1], f),
      mixN(fitTarget[i * 3 + 2], fitTarget[(i + 1) * 3 + 2], f));
    camera.up.copy(up);
    camera.position.copy(target).addScaledVector(dir, -mixN(fitDist[i], fitDist[i + 1], f));
    camera.lookAt(target);
  }

  /** Park the camera on the finished flat map and hand over to OrbitControls. */
  function restCamera() {
    sheet.setPose(0, 1, shotRotation(SPIN_UNTIL));
    frameCamera(1, 1.05, OFFSET_X, keepClear());
    controls.target.copy(target);
    controls.update();
  }

  resize();

  /* ----------------------------------------------------------- state --- */

  const state = {
    t: 0,
    mode: 'landing',                 // 'landing' -> 'intro' -> 'map'
    interactive: false,
    year: data.years.includes(DEFAULT_YEAR) ? DEFAULT_YEAR : data.years[data.years.length - 1],
    enabled: new Set(COMMODITY_GROUPS.map((c) => c.key)),
    metric: DEFAULT_METRIC,
    strength: DEFAULT_DEFORMATION,
    focus: null,
    cats: new Set(),                 // highlighted categories; empty = all equal
    nodes: [],
    maxTotal: 1,
  };

  function metricValue(v) {
    if (state.metric === 'out') return v.out;
    if (state.metric === 'in') return v.in;
    if (state.metric === 'total') return v.total;
    if (state.metric === 'net') return v.net;
    return 0;
  }

  // True when the last rebuild left a solved year sitting in the destination
  // grid — that is, when it was a year-pair rebuild from the timeline. Any
  // other rebuild (a new metric, a layer toggled, a changed highlight) solves
  // the sheet afresh into both slots, and what the last glide left behind no
  // longer describes what is on screen, so the next glide must not inherit it.
  let warpChained = false;

  /**
   * Rebuild everything the year governs.
   *
   * Normally this covers a single year. While the timeline is playing it spans
   * the pair the playhead is travelling between: the geometry is built once
   * for the union of the two, and each route and country carries its value at
   * both ends, so crossing from one to the other is a per-frame lerp rather
   * than another trip through here. That matters because the elastic solve
   * inside this function costs tens of milliseconds and could not run per
   * frame — see `setBlend` for what does.
   *
   * `toYear` is the year being travelled towards, or null when the map is
   * sitting on one year and nothing is in motion.
   */
  function rebuild(toYear = null, reuseA = false) {
    const yA = state.year;
    const yB = toYear === null ? yA : toYear;
    const pair = yB !== yA;
    const rows = pair
      ? sliceUnion(data, yA, yB, state.enabled)
      : slice(data, yA, state.enabled);
    const tot = totals(rows);
    const totA = pair ? totals(rows, 'vA') : tot;
    const totB = pair ? totals(rows, 'vB') : tot;
    state.maxTotal = Math.max(1, ...[...tot.values()].map((v) => v.total));
    // Each end is scaled against its own year's busiest country, exactly as a
    // single year always has been. Normalising both against a shared maximum
    // would be tidier to reason about, but it would mean a year arrived at by
    // playing the timeline drew its dots at a different size from the same
    // year clicked on the axis. The two ends are each the real picture of
    // their year, and the glide interpolates between them; the rescaling from
    // one year to the next was already there, it just happens smoothly now.
    const maxA = Math.max(1, ...[...totA.values()].map((v) => v.total));
    const maxB = Math.max(1, ...[...totB.values()].map((v) => v.total));
    // 0, not NODE_SIZE.min, for a country with no trade that year: the pair
    // covers every country in either year, and the ones belonging to only one
    // of them must be absent at the other end rather than drawn at the minimum
    // dot size. They grow out of nothing as the glide crosses.
    const sizeAt = (v, max) => (v > 0
      ? NODE_SIZE.min + NODE_SIZE.range * Math.sqrt(v / max)
      : 0);

    const nodeColor = new THREE.Color(colors.node);
    const focusColor = new THREE.Color(colors.focus);
    // The core of a case study is white on both themes, so it is the one mark
    // on the map that is never a shade of anything else — easy to find and aim
    // at inside its own wash. Outside the highlight it is pulled most of the
    // way toward the ordinary node colour instead of going fully neutral, so a
    // dimmed study is still visibly a clickable site.
    const studyColor = new THREE.Color(colors.study);
    const dimColor = new THREE.Color(colors.study).lerp(new THREE.Color(colors.node), 0.55);

    const nodes = [];
    for (const v of tot.values()) {
      const p = netPos.get(v.code);
      if (!p) continue;
      const node = {
        kind: 'country', code: v.code, x: p[0], y: p[1], data: v, hold: borderHold(p[0], p[1]),
        size: NODE_SIZE.min + NODE_SIZE.range * Math.sqrt(v.total / state.maxTotal),
        color: v.code === state.focus ? focusColor : nodeColor,
      };
      if (pair) {
        node.sizeA = sizeAt(totA.get(v.code)?.total || 0, maxA);
        node.sizeB = sizeAt(totB.get(v.code)?.total || 0, maxB);
        node.size = node.sizeA;
      }
      nodes.push(node);
    }
    const blobs = [];
    for (const s of studies) {
      const p = lonLatToNet(s.lon, s.lat);
      const lit = inHighlight(s);
      const hold = borderHold(p[0], p[1]);
      const color = s.country === state.focus ? focusColor
        : (lit ? studyColor : dimColor);
      nodes.push({
        kind: 'study', code: s.country, study: s, x: p[0], y: p[1], hold,
        size: NODE_SIZE.study * (lit ? (state.cats.size ? 1.25 : 1) : 0.7),
        color,
      });
      // The blob carries the same colour as its core, so the two read as one
      // mark; only the intensity answers to the highlight. A focused country
      // overrides the categories outright — that highlight is about the trade
      // partner, not about what the site is, so it stays a single colour.
      blobs.push({
        x: p[0], y: p[1], hold,
        color: s.country === state.focus ? focusColor : categoryColor(s),
        colors: s.country === state.focus ? [focusColor] : categoryColors(s),
        intensity: lit ? (state.cats.size ? HEAT.lift : 1) : HEAT.dim,
      });
    }
    overlay.setHeat(blobs);
    state.nodes = nodes;
    state.rows = rows;
    state.totals = tot;

    // warp sources: the strongest movers push the grid outward
    if (pair) {
      // Both ends of the transition get solved and baked, and the shader mixes
      // the two fields. `reuseA` is the whole reason playback stays affordable:
      // the year being left is the year the last step was heading for, already
      // sitting in the destination grid, so handing it over costs a pointer
      // swap and only the new year is actually solved — one solve per step,
      // the same as before any of this was interpolated.
      if (reuseA && warpChained) {
        advanceWarpSlot(warpUniforms);
      } else {
        setWarpSources(warpUniforms, warpSourcesFor(totA), 'both');
      }
      setWarpSources(warpUniforms, warpSourcesFor(totB), 'B');
    } else {
      setWarpSources(warpUniforms, warpSourcesFor(tot), 'both');
    }

    overlay.setFlows(topFlows(rows), vecs, catColor, data.maxFlow, state.focus);
    overlay.setNodes(nodes);
    refreshNodeWarp();
    ui.syncCounts(rows);
    warpChained = pair;
    if (!pair) ui.invalidateGlide();
  }

  /**
   * The countries that push the sheet around, strongest first. Empty under the
   * 'none' metric, which is how the deformation is switched off.
   */
  function warpSourcesFor(tot) {
    if (state.metric === 'none') return [];
    const vals = [...tot.values()]
      .map((v) => ({ code: v.code, v: metricValue(v) }))
      .filter((d) => netPos.has(d.code) && Math.abs(d.v) > 0)
      .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
      .slice(0, WARP.maxSources);
    const max = Math.max(1, ...vals.map((d) => Math.abs(d.v)));
    return vals.map((d) => {
      const n = Math.sqrt(Math.abs(d.v) / max);
      const p = netPos.get(d.code);
      return {
        x: p[0], y: p[1],
        radius: WARP.minRadius + WARP.radiusRange * n,
        scale: 1 + (d.v < 0 ? -WARP.shrink : WARP.grow) * n,
      };
    });
  }

  function refreshNodeWarp() {
    for (const n of state.nodes) {
      const [x, y] = warpPoint(warpUniforms, n.x, n.y, n.hold);
      n.wx = x; n.wy = y;
    }
  }

  /* ------------------------------------------------ turning the globe --- */

  // The globe's orientation is a free quaternion, not just an angle about the
  // pole: it drifts on its own, the pointer can spin it any way, and opening a
  // case study turns that place to face the camera.
  // Half a turn about the pole, so moving the camera to -Y (see DIR_A) still
  // presents the same meridian it used to.
  const GLOBE_LON = Math.PI;
  const globeQuat = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 0, 1), GLOBE_LON);
  const faceQuat = new THREE.Quaternion();       // where a case study wants it
  let facing = false;                            // are we easing toward faceQuat
  const ZAXIS = new THREE.Vector3(0, 0, 1);
  const qTmp = new THREE.Quaternion();
  const vTmp = new THREE.Vector3();
  const vTmp2 = new THREE.Vector3();

  /**
   * The orientation that brings a point on the globe round to face the camera,
   * as a yaw about the pole followed by a tilt in the plane that holds the
   * pole — so the axis stays upright instead of rolling.
   */
  function orientationFacing(lon, lat) {
    const p0 = vTmp.fromArray(latLonToVec(lat, lon));        // earth coordinates
    const cam = vTmp2.copy(camera.position).normalize();     // globe centre -> camera
    const yaw = Math.atan2(cam.y, cam.x) - Math.atan2(p0.y, p0.x);
    const q1 = new THREE.Quaternion().setFromAxisAngle(ZAXIS, yaw);
    const p1 = p0.clone().applyQuaternion(q1);
    const axis = new THREE.Vector3().crossVectors(p1, cam);
    if (axis.lengthSq() < 1e-12) return q1;                  // already pointing at us
    const angle = Math.acos(THREE.MathUtils.clamp(p1.dot(cam), -1, 1));
    return new THREE.Quaternion().setFromAxisAngle(axis.normalize(), angle).multiply(q1);
  }

  const leaderEl = document.getElementById('leader');
  const leaderLine = document.getElementById('leaderLine');
  const leaderRing = document.getElementById('leaderRing');
  const leaderPin = document.getElementById('leaderPin');
  const drawerEl = document.getElementById('drawer');

  const leadPt = new THREE.Vector3();

  /**
   * Run a dashed line from a point on screen to the left edge of a panel.
   * @param {number} sx  screen x of the place
   * @param {number} sy  screen y of the place
   * @param {Element} panel  what the line runs to
   */
  function drawLeader(sx, sy, panel) {
    const r = panel.getBoundingClientRect();
    // Clamping the place's own screen position into the panel's box lands on
    // the nearest point of its edge, so the line meets whichever side it comes
    // from: the left edge of the wide panel out to the right, or the top edge
    // of a small card sitting below the map.
    const ex = Math.min(Math.max(sx, r.left + 14), r.right - 14);
    const ey = Math.min(Math.max(sy, r.top + 14), r.bottom - 14);
    leaderLine.setAttribute('x1', sx.toFixed(1));
    leaderLine.setAttribute('y1', sy.toFixed(1));
    leaderLine.setAttribute('x2', ex.toFixed(1));
    leaderLine.setAttribute('y2', ey.toFixed(1));
    leaderRing.setAttribute('cx', sx.toFixed(1));
    leaderRing.setAttribute('cy', sy.toFixed(1));
    leaderPin.setAttribute('cx', sx.toFixed(1));
    leaderPin.setAttribute('cy', sy.toFixed(1));
    leaderEl.classList.add('on');
  }

  /** The globe's version: the study's spot has to be on the near side. */
  function updateLeader(study) {
    if (!study) { leaderEl.classList.remove('on'); return; }
    const p0 = vTmp.fromArray(latLonToVec(study.lat, study.lon)).applyQuaternion(globeQuat);
    const cam = vTmp2.copy(camera.position).normalize();
    if (p0.dot(cam) < 0.06) { leaderEl.classList.remove('on'); return; }  // far side
    const s = p0.clone().multiplyScalar(1.015).project(camera);
    drawLeader((s.x * 0.5 + 0.5) * innerWidth, (-s.y * 0.5 + 0.5) * innerHeight, drawerEl);
  }

  /**
   * The flat map's version. At this stage the sheet lies in the world z = 0
   * plane and a node's warped net coordinates are its world coordinates, so
   * the marker the line points at is exactly the one the map draws.
   */
  function updateMapLeader(study) {
    if (!study) { leaderEl.classList.remove('on'); return; }
    const n = state.nodes.find((q) => q.kind === 'study' && q.study === study);
    if (!n) { leaderEl.classList.remove('on'); return; }
    const s = leadPt.set(n.wx, n.wy, 0).project(camera);
    // The wide panel, when open, is what the line should reach; otherwise it
    // runs to that study's own tile above the timeline.
    const panel = drawerEl.classList.contains('on') ? drawerEl : ui.tileFor(study);
    if (!panel) { leaderEl.classList.remove('on'); return; }
    drawLeader((s.x * 0.5 + 0.5) * innerWidth, (-s.y * 0.5 + 0.5) * innerHeight, panel);
  }

  /** Drag anywhere on the globe to turn it, trackball style. */
  let turning = null;
  canvas.addEventListener('pointerdown', (ev) => {
    if (state.mode !== 'landing' || ev.button) return;
    turning = { x: ev.clientX, y: ev.clientY };
  });
  addEventListener('pointermove', (ev) => {
    if (!turning) return;
    const dx = ev.clientX - turning.x, dy = ev.clientY - turning.y;
    turning.x = ev.clientX; turning.y = ev.clientY;
    facing = false;                                          // the user has taken over
    globeQuat.premultiply(qTmp.setFromAxisAngle(up, dx * 0.006));
    globeQuat.premultiply(qTmp.setFromAxisAngle(right, dy * 0.006));
  });
  addEventListener('pointerup', () => { turning = null; });
  addEventListener('pointercancel', () => { turning = null; });

  /* --------------------------------------------------------- landing --- */

  // The globe waits inside a cage of dotted trade routes until Enter.
  const orbits = buildOrbits(
    slice(data, state.year, state.enabled), positions, data.maxFlow,
    { export: new THREE.Color(colors.exportHue), import: new THREE.Color(colors.importHue) });
  scene.add(orbits.points);
  orbitScale = (v) => { orbits.uniforms.uScale.value = v; };
  orbitScale(POINT_REF * renderer.getPixelRatio());
  let landingStart = performance.now();

  /* -------------------------------------------------------------- ui --- */

  /**
   * Opening a case study on the landing page swings the globe round to that
   * place, slides it into the left half, and runs a line from the spot to the
   * panel. Closing it lets the globe drift again.
   */
  let studyOpen = null;
  let landingOffset = LANDING_OFFSET;
  let landingMargin = LANDING_MARGIN;
  // How much of the masthead is showing, 0..1. It drives the left reserve as
  // well as the fade, so the globe takes the column back as the type leaves.
  let mastheadLevel = 1;
  function onStudy(study) {
    studyOpen = state.mode === 'landing' ? study : null;
    facing = !!studyOpen;
    if (!studyOpen) leaderEl.classList.remove('on');
    // The title and the Enter button step aside while a study has the stage:
    // the globe is swinging left and a panel is opening on the right, and
    // Enter would take you off the page in the middle of reading. Both come
    // back when it closes. The CSS transitions do the easing, so this only has
    // to name the state.
    if (state.mode === 'landing') {
      titleEl.style.opacity = studyOpen ? String(TITLE.studyDim) : '1';
      enterBar.classList.toggle('away', !!studyOpen);
    }
  }

  // A study raised by the timeline needs a leader line on the flat map, which
  // only main.js can draw — it owns the camera and the warped node positions.
  let mapStudy = null;
  // Arguments forwarded, not swallowed: the timeline calls this with the year
  // it is travelling to, and whether the last step's field can be inherited.
  const ui = buildUI(state, data, fmt, (...a) => rebuild(...a), () => toLanding(), onStudy,
    studies, (study) => { mapStudy = study; if (!study) leaderEl.classList.remove('on'); });
  ui.buildRolodex(studies, (study) => ui.openDrawer(study, state));

  /* ------------------------------------------- case-study categories --- */
  // A study's colour comes from the palette, in whichever theme is showing.
  // Most studies carry several impacts, so which one supplies the colour has to
  // answer to the highlight: with nothing selected it is the first category the
  // study lists, but with a filter on it is the first *selected* category the
  // study matches. Otherwise filtering for Cultural would light up Thacker Pass
  // in the Water Use blue it happens to list first, which reads as a bug rather
  // than as a site that is both. Studies outside the highlight step back rather
  // than vanish, so the map keeps its shape.
  const catColorCache = new Map();
  const hexColor = (hex) => {
    let c = catColorCache.get(hex);
    if (!c) { c = new THREE.Color(hex); catColorCache.set(hex, c); }
    return c;
  };
  function categoryColor(study) {
    return hexColor(categoryHex(study, state) || colors.study);
  }
  /**
   * Every colour the site should currently be shown in. One entry at rest or
   * when only one of the selected categories matches; several when the site
   * answers to several, which the blob divides itself between.
   */
  function categoryColors(study) {
    const hit = studyCategories(study, state);
    return hit.length ? hit.map((c) => hexColor(c.color)) : [hexColor(colors.study)];
  }
  const inHighlight = (study) => !state.cats.size
    || (study.impacts || []).some((k) => state.cats.has(k));

  /* --------------------------------------------------------- picking --- */

  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const hitPoint = new THREE.Vector3();
  const tip = document.getElementById('tip');

  function pick(ev) {
    if (state.mode !== 'map') return null;
    const ndc = new THREE.Vector2(
      (ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    if (!ray.ray.intersectPlane(plane, hitPoint)) return null;
    const dist = camera.position.distanceTo(hitPoint);
    const wpp = (2 * Math.tan((FOV * Math.PI) / 360) * dist) / innerHeight;
    const constant = POINT_REF * Math.tan((FOV * Math.PI) / 360) / innerHeight;
    let best = null, bestD = Infinity;
    for (const n of state.nodes) {
      const d = Math.hypot(hitPoint.x - n.wx, hitPoint.y - n.wy);
      const r = Math.max(n.size * constant, 7 * wpp) * (n.kind === 'study' ? 1.1 : 1);
      if (d < r && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  canvas.addEventListener('pointermove', (ev) => {
    const n = pick(ev);
    canvas.style.cursor = n ? 'pointer' : 'default';
    if (!n) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.style.left = Math.min(ev.clientX + 14, innerWidth - 250) + 'px';
    tip.style.top = (ev.clientY + 16) + 'px';
    if (n.kind === 'study') {
      tip.innerHTML = `<b>${esc(n.study.name)}</b>`
        + `<div class="m">${esc(n.study.location)} · case study</div>`;
    } else {
      tip.innerHTML = `<b>${esc(n.code)}</b><div class="m">out ${fmt(n.data.out)} · `
        + `in ${fmt(n.data.in)}</div>`;
    }
  });
  canvas.addEventListener('pointerleave', () => { tip.hidden = true; });

  addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    state.focus = null;
    ui.closeDrawer();
    rebuild();
  });

  canvas.addEventListener('click', (ev) => {
    const n = pick(ev);
    tip.hidden = true;
    if (!n) { state.focus = null; ui.closeDrawer(); rebuild(); return; }
    state.focus = n.code;
    rebuild();
    if (n.kind === 'study') ui.openDrawer(n.study, state);
    else ui.closeDrawer();
  });

  /* ----------------------------------------------------------- loop ---- */

  const progressEl = document.querySelector('#progress i');

  const titleEl = document.getElementById('title');
  const enterBar = document.getElementById('enterBar');
  const landingEl = document.getElementById('landing');
  const transportEl = document.getElementById('transport');

  /** Leave the landing page and start the shot. */
  function enter() {
    if (state.mode !== 'landing') return;
    state.mode = 'intro';
    state.t = 0;
    ui.rewindToStart();                     // unfold into the year we play from
    enterQuat.copy(globeQuat);              // pick the globe up mid-turn
    sheet.setSpinTarget(shotRotation(SPIN_UNTIL));
    landingEl.classList.add('gone');
    transportEl.style.opacity = 1;
    titleEl.style.opacity = 1;
  }

  /**
   * Back to the very start: the landing page, with its own Enter button, not
   * the first frame of the shot. Replaying from the map should give you the
   * piece from the top, rolodex and all.
   *
   * The landing branch of the frame loop reasserts the pose, the facet, the
   * halo, the orbits and the warp every frame, so the only things to undo
   * here are the ones `enter()` and `finish()` set once.
   */
  function toLanding() {
    state.mode = 'landing';
    state.t = 0;
    state.interactive = false;
    state.focus = null;
    settled = false;
    controls.enabled = false;
    landingEl.classList.remove('gone');
    transportEl.style.opacity = 0;          // the landing has no Skip
    titleEl.style.opacity = 1;
    document.getElementById('panel').classList.remove('on');
    document.getElementById('skip').textContent = 'Skip';
    landingStart = performance.now();       // let the routes fade back in
    landingOffset = LANDING_OFFSET;         // and the globe sit where it began
    landingMargin = LANDING_MARGIN;
    mastheadLevel = 1;
    onStudy(null);                          // drop any study the rolodex had open
    ui.hideTimeline();
    ui.closeDrawer();
    mapStudy = null;
    leaderEl.classList.remove('on');
    rebuild();                              // clears the focused country
  }
  const enterBtn = document.getElementById('enter');
  if (enterBtn) enterBtn.addEventListener('click', enter);
  else enter();                             // no landing markup: go straight in

  function finish() {
    state.mode = 'map';
    state.interactive = true;
    settled = true;
    restCamera();
    controls.enabled = true;
    document.getElementById('panel').classList.add('on');
    placePanel();
    document.getElementById('skip').textContent = 'Replay';
    titleEl.style.opacity = 0;
    transportEl.style.opacity = 0;
    ui.showTimeline();
    ui.playFromHere();
  }
  document.getElementById('skip').addEventListener('click', () => {
    if (state.interactive) toLanding(); else { state.t = TOTAL; }
  });

  rebuild();
  measureMasthead();
  placePanel();
  // The heading is set in a webfont; its width changes when that arrives, and
  // the reserve is measured from it.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { measureMasthead(); placePanel(); });
  }
  const params = new URLSearchParams(location.search);
  if (params.has('flat')) { enter(); state.t = TOTAL; }        // straight to the map
  else if (params.has('intro')) enter();                       // skip the landing page
  // dev hooks: scrub with __atlas.state.t, step one frame with __atlas.frame(now)
  window.__atlas = { state, PHASES, TOTAL, scene, camera, sheet, overlay, globeQuat };
  loadingEl.style.opacity = 0;
  setTimeout(() => loadingEl.remove(), 600);

  let last = performance.now();
  const frame = (now) => {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    // Where the timeline sits between two years, 0..1. Advanced before
    // anything else reads it: it moves the deformation, and the node warp and
    // the hit-test positions further down are computed against that field.
    const blend = ui.advanceGlide();
    setWarpBlend(warpUniforms, blend);

    if (state.mode === 'landing') {
      if (facing && studyOpen) {
        // recomputed each frame: the camera is still sliding left underneath us
        faceQuat.copy(orientationFacing(studyOpen.lon, studyOpen.lat));
        globeQuat.slerp(faceQuat, 1 - Math.pow(0.0015, dt));
      } else if (!document.hidden && !turning && !studyOpen) {
        globeQuat.multiply(qTmp.setFromAxisAngle(ZAXIS, LANDING.spinRate * dt));
      }
      sheet.setPose(1, 0, globeQuat);
      sheet.uniforms.uFacet.value = 0;
      sheet.uniforms.uEdgeOpacity.value = 0.10;
      halo.visible = true;
      halo.material.uniforms.uOpacity.value = 1;
      warpUniforms.uWarpAmount.value = 0;
      overlay.opacity = 0;
      setBorder(0);
      orbits.points.visible = true;
      orbits.points.quaternion.copy(globeQuat);
      orbits.uniforms.uTime.value = now / 1000;
      // wall clock, not accumulated dt: a throttled tab clamps dt and would
      // otherwise leave the routes stuck half-faded
      orbits.uniforms.uOpacity.value = Math.min(1, (now - landingStart) / 1400);
      const ease = 1 - Math.pow(0.004, dt);
      landingOffset += ((studyOpen ? STUDY_OFFSET : LANDING_OFFSET) - landingOffset) * ease;
      landingMargin += ((studyOpen ? STUDY_MARGIN : LANDING_MARGIN) - landingMargin) * ease;
      mastheadLevel += ((studyOpen ? 0 : 1) - mastheadLevel) * ease;
      frameCamera(0, landingMargin, landingOffset, 0, keepLeft() * mastheadLevel);
      updateLeader(studyOpen);
    } else if (state.mode === 'intro') {
      // A hidden tab throttles rAF, which would otherwise play the intro in
      // slow motion in the background; hold the clock instead.
      if (!document.hidden) state.t = Math.min(state.t + dt, TOTAL);
      const t = state.t;
      const facet = smooth(local(t, 'facet'));
      const { fold, present, margin, offsetFrac } = introShot(t);

      sheet.setPose(fold, present, shotRotation(t));
      sheet.uniforms.uFacet.value = facet;

      // the landing's orbits let go of the globe as it starts to facet
      const fade = Math.max(0, 1 - t / 2.6);
      orbits.uniforms.uOpacity.value = fade;
      orbits.uniforms.uTime.value = now / 1000;
      orbits.points.quaternion.copy(shotRotation(t));
      orbits.points.visible = fade > 0.01;

      sheet.uniforms.uEdgeOpacity.value =
        0.10 + 0.5 * facet * (1 - smooth(local(t, 'settle')));
      halo.material.uniforms.uOpacity.value = 1 - facet;
      halo.visible = facet < 0.999;

      warpUniforms.uWarpAmount.value = smooth(local(t, 'scale')) * state.strength;
      overlay.opacity = smooth(local(t, 'reveal'));
      setBorder(smooth(local(t, 'settle')));
      refreshNodeWarp();

      introCamera(t);

      progressEl.style.width = (100 * t / TOTAL).toFixed(1) + '%';
      titleEl.style.opacity = String(1 - titleFade(t));

      if (t >= TOTAL) finish();
    } else {
      controls.update();
      warpUniforms.uWarpAmount.value = state.strength;
      overlay.opacity = 1;
      sheet.setPose(0, 1, shotRotation(SPIN_UNTIL));
      sheet.uniforms.uFacet.value = 1;
      halo.visible = false;
      orbits.points.visible = false;
      setBorder(1);
      refreshNodeWarp();
      updateMapLeader(mapStudy);
      progressEl.style.width = '100%';
    }

    overlay.pointUniforms.uTime.value = now / 1000;
    overlay.blendNodes(blend);
    overlay.advanceDots(now / 1000, blend);
    renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(frame);
  window.__atlas.frame = frame;
  // Dev check: walk the intro and compare the precomputed framing against the
  // exact fit at every sample. Negative slack anywhere would mean clipping.
  window.__atlas.checkFit = () => {
    if (!fitDist) buildIntroPath();
    const keep = state.t;
    let worst = Infinity, at = 0;
    for (let t = 0; t <= TOTAL; t += FIT_STEP) {
      const sh = introShot(t);
      sheet.setPose(sh.fold, sh.present, shotRotation(t));
      const need = frameCamera(sh.present, sh.margin, sh.offsetFrac, sh.keepClear, sh.keepLeft);
      introCamera(t);
      const slack = camera.position.distanceTo(target) - need;
      if (slack < worst) { worst = slack; at = t; }
    }
    state.t = keep;
    return { worstSlack: worst, atT: at };
  };
}

/* ================================================================== ui === */

function buildUI(state, data, fmt, rebuild, replay, onStudy, studyList, onRaise) {
  const root = document.documentElement;
  const tok = (n) => getComputedStyle(root).getPropertyValue(n).trim();

  const note = document.getElementById('drawNote');
  note.className = 'val note';
  note.textContent = `top ${MAX_FLOWS_PER_GROUP_YEAR} routes drawn`;

  /* --------------------------------------------------- layer picker --- */
  // Every product layer is on to begin with; the menu is for narrowing down.
  // No colour per layer any more — the map's one colour distinction is the
  // direction of trade — so the rows carry their value and route count
  // instead, which is what the old coloured chips were really for.
  const layerBtn = document.getElementById('layerBtn');
  const layerMenu = document.getElementById('layerMenu');
  const laySummary = document.getElementById('layerSummary');
  const rowEls = new Map();

  // One layer always stays on, or the map would have nothing to draw and the
  // only way back would be the menu the reader just emptied. The one kept is
  // whichever currently carries the most value, so it is never the layer with
  // no flows in it — Cells & batteries has none in this file.
  let busiest = COMMODITY_GROUPS[0].key;

  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'all';
  layerMenu.appendChild(allBtn);
  allBtn.addEventListener('click', () => {
    if (state.enabled.size === COMMODITY_GROUPS.length) {
      state.enabled.clear();
      state.enabled.add(busiest);
    } else {
      for (const c of COMMODITY_GROUPS) state.enabled.add(c.key);
    }
    syncLayers();
    rebuild();
  });

  for (const c of COMMODITY_GROUPS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<span class="tick">\u2713</span><span>${c.label}</span>`
      + `<span class="n" data-n>HS ${c.hs}</span>`;
    b.addEventListener('click', () => {
      if (state.enabled.has(c.key)) state.enabled.delete(c.key);
      else state.enabled.add(c.key);
      if (!state.enabled.size) state.enabled.add(busiest);
      syncLayers();
      rebuild();
    });
    layerMenu.appendChild(b);
    rowEls.set(c.key, b);
  }

  function syncLayers() {
    const on = COMMODITY_GROUPS.filter((c) => state.enabled.has(c.key));
    laySummary.textContent = on.length === COMMODITY_GROUPS.length
      ? 'All products'
      : (on.length === 1 ? on[0].label : `${on.length} of ${COMMODITY_GROUPS.length} products`);
    allBtn.textContent = on.length === COMMODITY_GROUPS.length ? 'Clear all' : 'Select all';
    for (const c of COMMODITY_GROUPS) {
      rowEls.get(c.key).setAttribute('aria-pressed', String(state.enabled.has(c.key)));
    }
  }

  const openMenu = (open) => {
    layerMenu.hidden = !open;
    layerBtn.setAttribute('aria-expanded', String(open));
  };
  layerBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openMenu(layerMenu.hidden);
  });
  layerMenu.addEventListener('click', (ev) => ev.stopPropagation());
  addEventListener('click', () => openMenu(false));
  addEventListener('keydown', (ev) => { if (ev.key === 'Escape') openMenu(false); });
  syncLayers();

  // Declared up here because the category controls below touch the tiles, and
  // they are built further down.
  let tiles = [];

  /* ---------------------------------------- category highlight controls --- */
  const catRow = document.getElementById('catRow');
  const catNote = document.getElementById('catNote');
  const catEls = new Map();
  for (const c of CATEGORIES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<i class="sw"></i>${c.key}`;
    b.addEventListener('click', () => {
      if (state.cats.has(c.key)) state.cats.delete(c.key);
      else state.cats.add(c.key);
      syncCats();
      rebuild();                      // marker colours and sizes
      drawAxis();                     // dash colours
      paintTiles();
    });
    catRow.appendChild(b);
    catEls.set(c.key, b);
  }
  function syncCats() {
    for (const c of CATEGORIES) {
      const el = catEls.get(c.key);
      el.style.setProperty('--cat', c.color);
      el.setAttribute('aria-pressed', String(state.cats.has(c.key)));
    }
    // Blank rather than 'all' when nothing is picked: the rows below already
    // show every category lit, so the word only restated what was visible.
    catNote.textContent = state.cats.size ? `${state.cats.size} selected` : '';
  }

  syncCats();

  /* ------------------------------------------------------- timeline --- */
  // The year axis lives along the bottom of the finished map. Case studies sit
  // on it as dashes at the year their conflict starts, and playing the axis
  // raises each one in turn beside the map.
  const tl = document.getElementById('timeline');
  const tlTrack = document.getElementById('tlTrack');
  const tlAxis = document.getElementById('tlAxis');
  const tlHead = document.getElementById('tlHead');
  const tlYear = document.getElementById('tlYear');
  const tlPlay = document.getElementById('tlPlay');
  const years = data.years;
  document.getElementById('tlFrom').textContent = years[0];
  document.getElementById('tlTo').textContent = years[years.length - 1];

  // Studies that carry a start year; the rest stay clickable on the map only.
  const dated = [];
  for (const st of (studyList || [])) {
    const y = TIMELINE.studyYear(st);
    if (y === null) continue;
    // snap to the nearest year the trade data actually covers
    const yr = years.reduce((a, b) => (Math.abs(b - y) < Math.abs(a - y) ? b : a), years[0]);
    dated.push({ study: st, year: yr });
  }
  dated.sort((a, b) => a.year - b.year);
  // Several studies can start in the same year (2017 and 2024 both hold two),
  // so keep them grouped: the dashes are nudged apart to stay separately
  // clickable, and playback shows each in turn before moving on.
  const byYear = new Map();
  for (const d of dated) {
    if (!byYear.has(d.year)) byYear.set(d.year, []);
    d.slot = byYear.get(d.year).length;
    byYear.get(d.year).push(d);
  }
  for (const d of dated) d.of = byYear.get(d.year).length;

  const frac = (y) => (years.length < 2 ? 0 : (years.indexOf(y)) / (years.length - 1));
  let dashEls = [];

  /* ------------------------------- total trade per year, under the axis --- */
  // A plain line of the whole dataset summed by year, on the same x scale as
  // the axis above it, so a tick and a point in the graph are the same year.
  // It answers the question the year axis cannot: the timeline shows when the
  // case studies happen, this shows what the trade was doing while they did.
  document.documentElement.style.setProperty('--tlchart', `${TIMELINE.chartHeight}px`);
  const chartEl = document.getElementById('tlChart');
  const chartCap = document.getElementById('tlChartCap');
  const chartNow = chartEl && chartEl.querySelector('.now');
  // Which number the graph plots, and how to write it. `t` is the second
  // measure the loader carried for exactly this purpose; without one the line
  // falls back to the same value the rest of the page is sized by.
  const chartUses = data.secondField ? 't' : 'v';
  const chartUnit = VALUE_FORMAT[data.secondField || VALUE_FIELD] || {};
  const chartFmt = chartUses === 'v' ? fmt : (n) => {
    const u = chartUnit.unit === 'kg' ? 't' : 't';
    const x = chartUnit.unit === 'kg' ? n / 1000 : n;    // kg reads better as tonnes
    if (x >= 1e6) return `${(x / 1e6).toFixed(1)}m ${u}`;
    if (x >= 1e3) return `${Math.round(x / 1e3)}k ${u}`;
    return `${Math.round(x)} ${u}`;
  };

  const chartCapLabel = (chartUses === 'v' ? 'TOTAL TRADE' : 'LITHIUM SHIPPED');
  const CHART_PAD = 3;                       // headroom so the peak is not clipped
  let chartPts = [];                         // one [x, y] per year, in px
  let chartValues = [];                      // the totals those points came from

  /** The plotted total in each year, across the layers currently switched on. */
  function totalsByYear() {
    return years.map((y) => (data.byYear.get(y) || [])
      .reduce((sum, f) => (state.enabled.has(f.cat) ? sum + f[chartUses] : sum), 0));
  }

  function drawChart() {
    if (!chartEl || !TIMELINE.chartHeight) return;
    const w = chartEl.clientWidth, h = chartEl.clientHeight;
    if (!w || !h) return;
    const vals = totalsByYear();
    const max = Math.max(1, ...vals);
    const n = vals.length;
    // Shares the axis's x mapping exactly: year i sits at the same fraction of
    // the width as its tick does, so the playhead above lines up with the
    // point below at every year.
    chartPts = vals.map((v, i) => [
      n < 2 ? w / 2 : (i / (n - 1)) * w,
      h - 1 - (v / max) * (h - 1 - CHART_PAD),
    ]);
    chartEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const line = chartPts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    chartEl.querySelector('.line').setAttribute('points', line);
    chartEl.querySelector('.area').setAttribute('d',
      `M0,${h} L${line.split(' ').join(' L')} L${w},${h} Z`);
    chartValues = vals;
    placeChartHead();
  }

  /**
   * Put the marker where the playhead is — including part way between two
   * years while the timeline glides, so the dot travels along the line rather
   * than hopping from point to point.
   */
  function placeChartHead() {
    if (!chartNow || !chartPts.length) return;
    const i = years.indexOf(state.year);
    if (i < 0) return;
    const moving = glide.to !== null;
    const j = moving ? years.indexOf(glide.to) : i;
    const u = moving && j >= 0 ? glide.u : 0;
    const a = chartPts[i], b = chartPts[j >= 0 ? j : i];
    chartNow.setAttribute('cx', (a[0] + (b[0] - a[0]) * u).toFixed(1));
    chartNow.setAttribute('cy', (a[1] + (b[1] - a[1]) * u).toFixed(1));
    const va = chartValues[i] || 0;
    const vb = chartValues[j >= 0 ? j : i] || 0;
    if (chartCap) {
      chartCap.textContent = `${chartCapLabel} · ${chartFmt(va + (vb - va) * u)}`;
    }
  }

  // While the timeline plays, the map travels from one year to the next
  // instead of cutting to it. `state.year` is the year being left and `to` the
  // year being approached; `u` is how far along, and every per-frame quantity
  // — playhead, route dots, country dots, the deformation — reads that one
  // number. The structural rebuild happened once when the glide started and
  // does not run again until it lands.
  //
  // `u` deliberately stays at 1 after arriving rather than resetting. The two
  // ends of the transition are still the two baked fields, and the year just
  // reached is the far one; dropping to 0 would snap the map back to the year
  // it came from. It returns to 0 only when the next rebuild re-bases the
  // pair. `to === null` is what says nothing is in motion — not `u === 0`.
  //
  // Declared up here because placeHead and setYear below both read it.
  const glide = { to: null, u: 0, ms: 0, t0: 0, ready: null, prepared: null };

  function drawAxis() {
    const w = tlTrack.clientWidth, h = tlTrack.clientHeight;
    if (!w) return;
    const base = h - 12;                       // baseline sits low, labels below
    const parts = [`<line class="base" x1="0" y1="${base}" x2="${w}" y2="${base}"/>`];
    years.forEach((y, i) => {
      const x = (i / (years.length - 1)) * w;
      const len = y % 5 === 0 ? TIMELINE.tickMajor : TIMELINE.tick;
      parts.push(`<line class="tick${y % 5 === 0 ? ' major' : ''}" x1="${x.toFixed(1)}"`
        + ` y1="${base}" x2="${x.toFixed(1)}" y2="${base - len}"/>`);
    });
    dated.forEach((d, i) => {
      const x = frac(d.year) * w + (d.slot - (d.of - 1) / 2) * TIMELINE.dashGap;
      const lit = !state.cats.size
        || (d.study.impacts || []).some((k) => state.cats.has(k));
      // One segment per category the site is currently shown in, stacked up
      // the dash, so a site answering to two of the selected categories reads
      // as both here too rather than only on the map.
      const hexes = categoryHexes(d.study, state);
      const strokes = hexes.length ? hexes : ['currentColor'];
      parts.push(`<line class="hit" data-i="${i}" x1="${x.toFixed(1)}" y1="${base}"`
        + ` x2="${x.toFixed(1)}" y2="${base - TIMELINE.dash}"/>`);
      strokes.forEach((stroke, k) => {
        const seg = TIMELINE.dash / strokes.length;
        const y0 = base - k * seg, y1 = base - (k + 1) * seg;
        parts.push(`<line class="dash" data-i="${i}" x1="${x.toFixed(1)}" y1="${y0.toFixed(1)}"`
          + ` x2="${x.toFixed(1)}" y2="${y1.toFixed(1)}"`
          + ` style="stroke:${stroke};opacity:${lit ? 1 : 0.28}"/>`);
      });
    });
    drawChart();
    tlAxis.setAttribute('viewBox', `0 0 ${w} ${h}`);
    tlAxis.innerHTML = parts.join('');
    dashEls = [...tlAxis.querySelectorAll('.dash')];
    for (const el of tlAxis.querySelectorAll('.dash, .hit')) {
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const d = dated[+el.dataset.i];
        stopPlay();
        setYear(d.year);
        raise(d.study);
        openDrawer(d.study, state);
      });
    }
    placeHead();
  }

  /**
   * The playhead's position as a fractional index into `years`, so that it can
   * sit between two of them while the timeline is gliding.
   */
  const fracAt = (i) => (years.length < 2 ? 0 : i / (years.length - 1));

  function placeHead() {
    const moving = glide.to !== null;
    const i = years.indexOf(state.year);
    const f = fracAt((i < 0 ? 0 : i) + (moving ? glide.u : 0));
    tlHead.style.left = (f * 100) + '%';
    tlHead.classList.toggle('flip', f > 0.86);
    // The label names the year the map is nearest to, so it changes once, at
    // the midpoint, rather than flickering between the two as it crosses.
    const shown = moving && glide.u > 0.5 ? glide.to : state.year;
    tlYear.textContent = shown;
    dashEls.forEach((el) => el.classList.toggle(
      'live', dated[+el.dataset.i].year === shown));
    placeChartHead();
  }

  function setYear(y) {
    if (y === state.year) { placeHead(); return; }
    state.year = y;
    glide.to = null; glide.u = 0; glide.ms = 0;
    glide.ready = null; glide.prepared = null;
    placeHead();
    rebuild();                // solves into both slots, so the blend is moot
    if (drawer.classList.contains('on') && current) openDrawer(current, state);
  }

  /**
   * Build the pair for the next step while the current year is being held.
   *
   * This is what keeps the glide smooth. Rebuilding a pair costs about 70ms —
   * route geometry for the union of two years, and an elastic solve — which is
   * four or five dropped frames. Done at the moment the glide starts, that
   * lands as a stutter right at the top of the motion, exactly where the eye
   * is following it. Done here, it falls inside the hold, where the map is
   * standing still and a dropped frame has nothing to interrupt.
   *
   * By the time `step` asks to move, everything is already baked and the glide
   * is nothing but a uniform and two lerps.
   */
  function prepareNext() {
    if (!timer || glide.to !== null) return;     // paused, or already moving
    const i = years.indexOf(state.year);
    if (i < 0 || i >= years.length - 1) return;  // the wrap cuts, nothing to bake
    const next = years[i + 1];
    if (glide.prepared === next) return;
    rebuild(next, glide.ready === state.year);
    glide.ready = null;
    glide.prepared = next;
    glide.u = 0;               // the pair is re-based: this year is the near end
  }

  /** Start travelling towards `y`. `ms` of 0 arrives immediately. */
  function glideTo(y, ms) {
    if (y === state.year) return;
    // Normally prepareNext already did this during the hold. The rebuild here
    // is the fallback for a step that was not anticipated — the first one after
    // Play, or one whose preparation was invalidated. The second argument asks
    // to inherit the field the last step solved rather than solving this year
    // twice; rebuild grants it only if nothing else has re-solved the sheet.
    if (glide.prepared !== y) {
      rebuild(y, glide.ready === state.year);
      glide.ready = null;
    }
    glide.prepared = null;
    glide.to = y;
    glide.u = 0;
    glide.ms = Math.max(0, Math.min(ms, TIMELINE.yearMs));
    glide.t0 = performance.now();
    if (glide.ms === 0) landGlide();
  }

  /**
   * Arrive. The destination becomes the year, and `u` is left at 1 — the far
   * end of the pair is exactly what should now be on screen, and it stays that
   * way until the next rebuild re-bases the two fields.
   */
  function landGlide() {
    const y = glide.to;
    if (y === null) return;
    state.year = y;
    glide.to = null;
    glide.u = 1;
    glide.ready = y;          // this year's field is sitting in the B slot
    placeHead();
    if (drawer.classList.contains('on') && current) openDrawer(current, state);
    // Out of this frame, so the landing itself stays cheap.
    setTimeout(prepareNext, 0);
  }

  /**
   * Advance the glide. Called once a frame from the render loop; returns the
   * blend the rest of the frame should draw at, which the caller hands to the
   * deformation, the route dots and the country dots.
   *
   * The easing is a smoothstep, so the map leaves one year and reaches the
   * next at rest. A linear ramp would arrive at full speed and stop dead,
   * which reads as a jolt at exactly the moment the old code cut.
   */
  function advanceGlide() {
    if (glide.to === null) return glide.u;
    const k = glide.ms <= 0 ? 1
      : Math.min(1, (performance.now() - glide.t0) / glide.ms);
    glide.u = k * k * (3 - 2 * k);
    placeHead();
    if (k >= 1) { landGlide(); return 1; }
    return glide.u;
  }

  // scrubbing
  const yearAt = (clientX) => {
    const r = tlTrack.getBoundingClientRect();
    const u = THREE.MathUtils.clamp((clientX - r.left) / r.width, 0, 1);
    return years[Math.round(u * (years.length - 1))];
  };
  let scrubbing = false;
  tlTrack.addEventListener('pointerdown', (ev) => {
    scrubbing = true;
    stopPlay(); slot = 0; setYear(yearAt(ev.clientX)); showForYear();
    // Capture keeps the drag alive off the track, but it throws if the pointer
    // is not active — which must not take the scrub down with it.
    try { tlTrack.setPointerCapture(ev.pointerId); } catch { /* not captured */ }
  });
  tlTrack.addEventListener('pointermove', (ev) => {
    if (scrubbing) { slot = 0; setYear(yearAt(ev.clientX)); showForYear(); }
  });
  tlTrack.addEventListener('pointerup', () => { scrubbing = false; });
  tlTrack.addEventListener('keydown', (ev) => {
    const i = years.indexOf(state.year);
    if (ev.key === 'ArrowLeft' && i > 0) { stopPlay(); setYear(years[i - 1]); showForYear(); }
    else if (ev.key === 'ArrowRight' && i < years.length - 1) { stopPlay(); setYear(years[i + 1]); showForYear(); }
    else return;
    ev.preventDefault();
  });
  addEventListener('resize', () => { drawAxis(); layoutCards(); });

  // Pushed from the config rather than read from the markup, so the two cannot
  // drift — which matters while these controls are hidden and nobody would see
  // the disagreement.
  const metricEl = document.getElementById('metric');
  metricEl.value = state.metric;
  document.getElementById('metric').addEventListener('change', (e) => {
    state.metric = e.target.value;
    rebuild();
  });
  const strengthEl = document.getElementById('strength');
  const strengthVal = document.getElementById('strengthVal');
  strengthEl.value = String(Math.round(state.strength * 100));
  strengthVal.textContent = strengthEl.value + '%';
  strengthEl.addEventListener('input', () => {
    state.strength = +strengthEl.value / 100;
    strengthVal.textContent = strengthEl.value + '%';
  });

  /* ------------------------------------------------ timeline playback --- */
  // A chain of timeouts rather than one interval, because a year a case study
  // starts in holds longer so the card can be read.
  let timer = null;

  function stopPlay() {
    if (timer) { clearTimeout(timer); timer = null; }
    // Land wherever the glide had got to rather than freezing part-way between
    // two years, which would leave the map showing a blend of both and the
    // playhead between ticks.
    if (glide.to !== null) landGlide();
    tlPlay.textContent = 'Play';
  }

  let slot = 0;                    // which study of the current year is showing

  function step() {
    const here = byYear.get(state.year) || [];
    if (slot + 1 < here.length) {         // another study in this same year
      slot += 1;
      raise(here[slot].study);
      timer = setTimeout(step, TIMELINE.studyDwellMs);
      return;
    }
    const i = years.indexOf(state.year);
    const next = years[i >= years.length - 1 ? 0 : i + 1];
    // Wrapping back to the first year is a jump across the whole axis, not a
    // step to the neighbour, so it cuts rather than gliding the playhead the
    // length of the track.
    if (next < state.year) setYear(next);
    else glideTo(next, TIMELINE.glideMs);
    slot = 0;
    timer = setTimeout(step, showForYear() ? TIMELINE.studyDwellMs : TIMELINE.yearMs);
  }

  function startPlay() {
    if (timer) return;
    tlPlay.textContent = 'Pause';
    slot = 0;
    timer = setTimeout(step, showForYear() ? TIMELINE.studyDwellMs : TIMELINE.yearMs);
    // Bake the first step too, rather than letting it be the one that stutters.
    setTimeout(prepareNext, 0);
  }

  /**
   * Put the map on the earliest year on record.
   *
   * Called as the unfold begins, not when it ends. The overlay fades in during
   * the last phase of the intro, so by the time the sheet settles the reader
   * is already looking at the data — and rewinding at that moment would snap
   * the flows and the cartogram from the latest year to the earliest in one
   * frame, right where the eye has just come to rest. Doing it up front means
   * the map unfolds into the year it is about to play from, and the solve the
   * rewind costs lands during the unfold where there is slack for it.
   */
  function rewindToStart() {
    stopPlay();
    setYear(years[0]);
  }

  /** Begin playback from wherever the playhead is. */
  function playFromHere() {
    showForYear();
    startPlay();
  }

  tlPlay.addEventListener('click', () => {
    if (timer) { stopPlay(); return; }
    startPlay();
  });

  /* ------------------------------------------------ the study tiles --- */
  // One tile per dated study, always on. They can't each sit exactly over
  // their own dash — the studies cluster in 2017-2024 and the tiles are wider
  // than the gaps — so they are laid out in dash order, overlapping
  // neighbours are pushed apart, and a connector runs from each down to its
  // own dash.
  const cardsEl = document.getElementById('cards');
  const linksEl = document.getElementById('tlLinks');
  const CARD_W = 124, CARD_GAP = 9, EDGE = 24;
  let raised = null;

  function buildCards() {
    cardsEl.innerHTML = '';
    tiles = dated.map((d) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'scard';
      // Shortened here and here only; the panel and the rolodex keep the full
      // name. The subtitle is the tail of `location` — see TIMELINE.
      const title = TIMELINE.shortNames[d.study.name] || d.study.name;
      // Zimbabwe's place is its own name; showing it twice says nothing, so
      // the year stands in.
      const place = TIMELINE.shortPlace(d.study, TIMELINE.countryShort);
      const sub = place && place.toLowerCase() !== title.toLowerCase()
        ? place : String(d.year);
      el.innerHTML = '<img alt="">'
        + `<div class="nm">${esc(title)}</div>`
        + `<div class="pl">${esc(sub)}</div>`;
      const img = el.querySelector('img');
      if (d.study.image) {
        // Listener first: a cached 404 fires its error before a listener
        // attached after `src` would exist. The photo's box stays either way,
        // because every tile has to be the same height — a study whose photo
        // is not in yet shows an empty frame rather than a shorter tile.
        img.addEventListener('error', () => {
          img.removeAttribute('src');          // no broken-image icon
          img.classList.add('empty');
        });
        img.src = encodeURI(d.study.image);
      } else {
        img.removeAttribute('src');
        img.classList.add('empty');
      }
      el.addEventListener('click', () => {
        stopPlay();
        setYear(d.year);
        raise(d.study);
        openDrawer(d.study, state);
      });
      el.addEventListener('pointerenter', () => raise(d.study));
      el.addEventListener('focus', () => raise(d.study));
      cardsEl.appendChild(el);
      return { el, d };
    });
    layoutCards();
  }

  /** Lay the tiles out in dash order, without overlaps, and wire the links. */
  function layoutCards() {
    if (!tiles.length) return;
    const r = tlTrack.getBoundingClientRect();
    const dashX = (d) => r.left + r.width * frac(d.year)
      + (d.slot - (d.of - 1) / 2) * TIMELINE.dashGap;

    // start each where its dash is, then relax the overlaps outward
    const want = tiles.map((t) => dashX(t.d) - CARD_W / 2);
    const lo = EDGE, hi = Math.max(EDGE, innerWidth - CARD_W - EDGE);
    const x = want.slice();
    for (let i = 1; i < x.length; i++) {
      x[i] = Math.max(x[i], x[i - 1] + CARD_W + CARD_GAP);
    }
    // if that ran off the right edge, push the whole run back left
    const over = x[x.length - 1] - hi;
    if (over > 0) for (let i = x.length - 1; i >= 0; i--) {
      x[i] = Math.min(x[i], hi - (x.length - 1 - i) * (CARD_W + CARD_GAP));
    }
    for (let i = 1; i < x.length; i++) x[i] = Math.max(x[i], x[i - 1] + CARD_W + CARD_GAP);
    for (let i = 0; i < x.length; i++) x[i] = Math.max(x[i], lo);

    const parts = [];
    tiles.forEach((t, i) => {
      t.el.style.left = Math.round(x[i]) + 'px';
      t.x = x[i];
      const cx = x[i] + CARD_W / 2;
      const h = t.el.offsetHeight || 110;
      // tiles sit on this line, lifted by the graph under the axis
      const y0 = innerHeight - 84 - TIMELINE.chartHeight;
      const y1 = tlTrack.getBoundingClientRect().top + tlTrack.clientHeight - 12;
      parts.push(`<line data-i="${i}" x1="${cx.toFixed(1)}" y1="${y0.toFixed(1)}"`
        + ` x2="${dashX(t.d).toFixed(1)}" y2="${y1.toFixed(1)}"/>`);
    });
    linksEl.setAttribute('viewBox', `0 0 ${innerWidth} ${innerHeight}`);
    linksEl.innerHTML = parts.join('');
    markLive();
  }

  /** Category colour as a stripe on each tile, dimmed outside the highlight. */
  function paintTiles() {
    for (const t of tiles) {
      const hexes = categoryHexes(t.d.study, state);
      const lit = !state.cats.size
        || (t.d.study.impacts || []).some((k) => state.cats.has(k));
      t.el.style.borderTopWidth = hexes.length ? '3px' : '';
      t.el.style.opacity = lit ? '' : '0.4';
      if (hexes.length > 1) {
        // border-image paints the stripe from a gradient, which border-color
        // cannot do. Hard stops, not a blend: at three pixels tall there is no
        // room for a transition, and a blurred one would just look muddy.
        const n = hexes.length;
        const stops = hexes
          .map((h, i) => `${h} ${((i / n) * 100).toFixed(1)}% ${(((i + 1) / n) * 100).toFixed(1)}%`)
          .join(', ');
        t.el.style.borderTopColor = '';
        t.el.style.borderImage = `linear-gradient(90deg, ${stops}) 1`;
      } else {
        t.el.style.borderImage = '';
        t.el.style.borderTopColor = hexes[0] || '';
      }
    }
  }

  function markLive() {
    tiles.forEach((t) => t.el.classList.toggle('live', t.d.study === raised));
    for (const ln of linksEl.querySelectorAll('line')) {
      ln.classList.toggle('live', tiles[+ln.dataset.i]?.d.study === raised);
    }
  }

  /** Make a study the active one: highlight it and point the map line at it. */
  function raise(study) {
    raised = study;
    markLive();
    if (onRaise) onRaise(study);
  }

  /** Raise whichever study starts in the current year, if any. */
  function showForYear() {
    const here = byYear.get(state.year) || [];
    raise(here.length ? here[0].study : null);
    return here.length > 0;
  }

  function showTimeline() {
    tl.classList.add('on');
    tl.setAttribute('aria-hidden', 'false');
    drawAxis();
    buildCards();
    paintTiles();
    cardsEl.classList.add('on');
    linksEl.classList.add('on');
  }

  function hideTimeline() {
    stopPlay();
    raise(null);
    tl.classList.remove('on');
    tl.setAttribute('aria-hidden', 'true');
    cardsEl.classList.remove('on');
    linksEl.classList.remove('on');
  }
  document.getElementById('replay').addEventListener('click', replay);

  const drawer = document.getElementById('drawer');
  const drawerBody = document.getElementById('drawerBody');
  let current = null;
  document.getElementById('closeDrawer').addEventListener('click', () => {
    closeDrawer();
    state.focus = null;          // stop isolating that country's flows
    rebuild();
  });

  function closeDrawer() {
    drawer.classList.remove('on');
    drawer.setAttribute('aria-hidden', 'true');
    current = null;
    if (onStudy) onStudy(null);
  }

  /**
   * Who said the quote, under it: the name, the description of who they are,
   * or whichever one of the two the row actually has. Blank if neither.
   */
  function attribution(study) {
    const name = (study.speaker || '').trim();
    const title = (study.speakerTitle || '').trim();
    if (!name && !title) return '';
    return '<footer>'
      + (name ? `<span class="who">${esc(name)}</span>` : '')
      + (name && title ? '<br>' : '')
      + (title ? `<span class="role">${esc(title)}</span>` : '')
      + '</footer>';
  }

  function links(list) {
    return list.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">`
      + `${esc(s.host)}</a></li>`).join('');
  }

  /* ------------------------------------ primary source documents --- */
  // Files kept in documents/ and registered in DOCUMENTS, shown in the page
  // rather than opened on someone else's site. Everything here is driven by
  // that mapping; nothing reads the folder, because a static page cannot.
  const docView = document.getElementById('docView');
  const docSheet = document.getElementById('docSheet');
  const docFrame = document.getElementById('docFrame');
  const docTitle = document.getElementById('docTitle');
  const docMeta = document.getElementById('docMeta');
  const docOpen = document.getElementById('docOpen');
  let docReturn = null;              // what to put focus back on

  function docList(docs) {
    return docs.map((d, i) => {
      const ext = (d.file.split('.').pop() || '').toUpperCase();
      return `<li><button type="button" data-doc="${i}">`
        + `<span class="ext">${esc(ext)}</span>`
        + `<span>${esc(d.label)}</span></button></li>`;
    }).join('');
  }

  function openDocument(doc, returnTo) {
    docReturn = returnTo || null;
    docTitle.textContent = doc.label;
    docMeta.textContent = doc.file;
    docOpen.href = encodeURI(doc.url);
    const src = encodeURI(doc.url);
    if (doc.kind === 'pdf' || doc.kind === 'page') {
      docFrame.innerHTML = `<iframe src="${esc(src)}" title="${esc(doc.label)}"></iframe>`;
    } else if (doc.kind === 'image') {
      docFrame.innerHTML = `<img src="${esc(src)}" alt="${esc(doc.label)}">`;
    } else if (doc.kind === 'text') {
      docFrame.innerHTML = '<pre>loading…</pre>';
      fetch(src).then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
        .then((text) => { docFrame.innerHTML = `<pre>${esc(text)}</pre>`; })
        .catch(() => fallback(doc, 'That file could not be read.'));
    } else {
      // .docx, .xlsx and the like: no browser renders them, so offer the file
      fallback(doc, 'This format cannot be previewed in a browser.');
    }
    docView.hidden = false;
    docView.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => docView.classList.add('on'));
    document.getElementById('docClose').focus();
  }

  function fallback(doc, why) {
    docFrame.innerHTML = `<div class="fallback"><p>${esc(why)}</p>`
      + `<a class="ghost" href="${esc(encodeURI(doc.url))}" download>Download ${esc(doc.file)}</a>`
      + '</div>';
  }

  function closeDocument() {
    docView.classList.remove('on');
    docView.setAttribute('aria-hidden', 'true');
    // Emptied on the way out, or a PDF keeps its plugin alive behind the page
    // and a video would go on playing.
    setTimeout(() => { if (!docView.classList.contains('on')) {
      docView.hidden = true; docFrame.innerHTML = '';
    } }, 260);
    if (docReturn && docReturn.isConnected) docReturn.focus();
    docReturn = null;
  }

  document.getElementById('docClose').addEventListener('click', closeDocument);
  docView.addEventListener('click', (ev) => { if (ev.target === docView) closeDocument(); });
  // Capture, and stopImmediatePropagation rather than stopPropagation: the
  // drawer has its own Escape handler on window, and plain stopPropagation
  // does not stop another listener on the *same* target, so Escape closed the
  // viewer and the case study behind it in one press.
  addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || docView.hidden) return;
    ev.stopImmediatePropagation();
    closeDocument();
  }, true);

  /**
   * One value per year for each of `partners`, as this country's exports to
   * them. The drawer otherwise shows a single year, throwing away the series
   * the rest of the page is built on; this is what the sparklines draw.
   *
   * One pass over every year rather than a filter per partner, and gated by
   * the same enabled layers as the bars so the two cannot disagree.
   */
  function partnerSeries(country, partners, enabled) {
    const want = new Set(partners);
    const out = new Map([...want].map((k) => [k, new Array(data.years.length).fill(0)]));
    data.years.forEach((y, i) => {
      for (const f of (data.byYear.get(y) || [])) {
        if (f.a !== country || !want.has(f.b) || !enabled.has(f.cat)) continue;
        out.get(f.b)[i] += f.v;
      }
    });
    return out;
  }

  /**
   * A trend line for one partner across the whole record, with the year the
   * map is showing marked. Scaled to its own maximum: the question it answers
   * is whether this relationship is growing or collapsing, not how it compares
   * with the partner above — the bar beside it already says that.
   */
  function sparkline(vals, atIndex, w = 58, h = 16) {
    const max = Math.max(...vals);
    if (!(max > 0) || vals.length < 2) return '';
    const n = vals.length;
    const px = (i) => (i / (n - 1)) * (w - 2) + 1;
    const py = (v) => h - 1.5 - (v / max) * (h - 3);
    const pts = vals.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
    const i = Math.max(0, Math.min(n - 1, atIndex));
    const dot = vals[i] > 0
      ? `<circle cx="${px(i).toFixed(1)}" cy="${py(vals[i]).toFixed(1)}" r="1.9"/>` : '';
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"`
      + ` aria-hidden="true"><polyline points="${pts}"/>${dot}</svg>`;
  }

  function openDrawer(study, st) {
    current = study;
    const rows = (st.rows || []).filter((f) => f.a === study.country);
    // Per partner, the total and the split by commodity group: a country that
    // ships ore and one that ships refined chemical are telling different
    // stories, and a single bar per partner cannot say which.
    const byPartner = new Map();
    for (const f of rows) {
      let e = byPartner.get(f.b);
      if (!e) byPartner.set(f.b, e = { total: 0, cats: new Map() });
      e.total += f.v;
      e.cats.set(f.cat, (e.cats.get(f.cat) || 0) + f.v);
    }
    const top = [...byPartner.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 6);
    const max = Math.max(1, ...top.map((t) => t[1].total));
    const out = rows.reduce((s, f) => s + f.v, 0);
    const series = top.length
      ? partnerSeries(study.country, top.map(([name]) => name), st.enabled)
      : new Map();
    const atIndex = data.years.indexOf(st.year);
    // Only the groups this country actually ships, so the key never lists a
    // commodity that is not on screen.
    const groupsHere = COMMODITY_GROUPS.filter(
      (g) => top.some(([, e]) => (e.cats.get(g.key) || 0) > 0));

    const facts = [
      ['Years', study.years],
      ['Area', study.area],
      ['Impacts', study.impacts.join(', ')],
    ].filter(([, v]) => v);

    drawerBody.innerHTML = `
      <div class="badge">Case study</div>
      <h2>${esc(study.name)}</h2>
      <p class="place">${esc(study.location)}</p>
      ${study.image ? `<img class="hero" src="${encodeURI(study.image)}" alt="">` : ''}
      ${study.testimonial ? `
        <blockquote class="quote">${esc(study.testimonial.replace(/^["“]|["”]\s*$/g, ''))}
          ${attribution(study)}
        </blockquote>` : ''}
      ${study.testimonial && study.summary ? '<hr class="quoteRule">' : ''}
      ${study.summary ? `<div class="body"><p>${esc(study.summary)}</p></div>` : ''}
      ${facts.length ? `<div class="facts">${facts.map(([k, v]) => `
        <div class="fact"><span class="k">${esc(k)}</span>
        <span class="v">${esc(v)}</span></div>`).join('')}</div>` : ''}
      ${study.country && top.length ? `
        <h3>${esc(study.country)} exports · ${st.year} · ${fmt(out)}</h3>
        ${groupsHere.length > 1 ? `<div class="gkey">${groupsHere.map((g) => `
          <span><i style="background:${tok(g.token)}"></i>${esc(g.label)}</span>`).join('')}</div>` : ''}
        ${top.map(([name, e]) => {
          let acc = 0;
          const segs = groupsHere.map((g) => {
            const v = e.cats.get(g.key) || 0;
            if (!v) return '';
            const left = (100 * acc / max).toFixed(2);
            const wide = (100 * v / max).toFixed(2);
            acc += v;
            return `<i style="left:${left}%;width:${wide}%;background:${tok(g.token)}"></i>`;
          }).join('');
          return `
          <div class="bar">
            <span class="t">${segs}<span>${esc(name)}</span></span>
            <span class="s">${sparkline(series.get(name) || [], atIndex)}</span>
            <span class="v">${fmt(e.total)}</span>
          </div>`;
        }).join('')}
        ${series.size ? '<p class="sparknote">Trend lines show each partner across '
          + `${data.years[0]}–${data.years[data.years.length - 1]}, `
          + 'each to its own scale; the dot marks the year shown.</p>' : ''}` : ''}
      ${study.documents.length ? `<h3>Primary sources</h3>
        <ul class="docs">${docList(study.documents)}</ul>` : ''}
      ${study.primarySources.length ? `<h3>Primary sources on the web</h3>
        <ul class="sources">${links(study.primarySources)}</ul>` : ''}
      ${study.sources.length ? `<h3>Reporting</h3>
        <ul class="sources">${links(study.sources)}</ul>` : ''}
    `;
    const hero = drawerBody.querySelector('.hero');
    if (hero) hero.addEventListener('error', () => hero.remove());
    for (const b of drawerBody.querySelectorAll('.docs button')) {
      b.addEventListener('click', () => openDocument(study.documents[+b.dataset.doc], b));
    }
    drawer.classList.add('on');
    drawer.setAttribute('aria-hidden', 'false');
    drawer.scrollTop = 0;
    if (onStudy) onStudy(study);
  }

  /**
   * The landing page's rolodex: the case studies on a drum you can scroll,
   * wheel or drag through. The card at the front is the one a click opens;
   * clicking any other card brings it to the front first.
   */
  function buildRolodex(studies, onPick) {
    const drum = document.getElementById('rolodex');
    if (!drum) return;                      // page without a landing section
    drum.innerHTML = '';
    drum.style.setProperty('--persp', `${ROLODEX.perspective}px`);
    const n = studies.length;
    if (!n) return;

    const cards = studies.map((study, i) => {
      const card = document.createElement('button');
      card.className = 'rcard';
      card.style.setProperty('--cw', `${ROLODEX.card[0]}px`);
      card.style.setProperty('--ch', `${ROLODEX.card[1]}px`);
      card.setAttribute('aria-label', `${study.name}, ${study.location}`);
      card.innerHTML = '<span class="plate">'
        + (study.image ? `<img class="shot" src="${encodeURI(study.image)}" alt="">` : '')
        + '<span class="veil"></span>'
        + `<span class="meta"><b>${esc(study.name)}</b>`
        + `<em>${esc(study.location)}</em></span></span>`;
      const img = card.querySelector('.shot');
      if (img) {
        img.addEventListener('error', () => {
          console.warn(`case study "${study.name}": no image at ${study.image}`);
          img.remove();
        });
      }
      drum.appendChild(card);
      return card;
    });

    const hint = document.createElement('div');
    hint.id = 'rolodexHint';
    hint.textContent = n > 1 ? 'scroll' : '';
    drum.appendChild(hint);

    let pos = Math.floor((n - 1) / 2), target = pos, raf = null;   // open in the middle
    const clamp = (v) => Math.max(0, Math.min(n - 1, v));

    function layout() {
      cards.forEach((card, i) => {
        const deg = (i - pos) * ROLODEX.step;
        const face = Math.cos((deg * Math.PI) / 180);
        card.style.transform = `rotateX(${-deg}deg) translateZ(${ROLODEX.radius}px)`;
        card.style.opacity = face > 0.06 ? (0.18 + 0.82 * face).toFixed(3) : '0';
        card.style.zIndex = String(100 + Math.round(face * 100));
        card.style.pointerEvents = face > 0.4 ? 'auto' : 'none';
        card.classList.toggle('focused', Math.abs(i - pos) < 0.5);
      });
    }

    function run() {
      pos += (target - pos) * 0.18;
      if (Math.abs(target - pos) < 0.0015) { pos = target; raf = null; layout(); return; }
      layout();
      raf = requestAnimationFrame(run);
    }
    function glide(to) {
      target = clamp(to);
      if (raf === null) raf = requestAnimationFrame(run);
    }
    layout();

    let settle = null;
    drum.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      glide(target + ev.deltaY * ROLODEX.wheelSensitivity);
      clearTimeout(settle);
      settle = setTimeout(() => glide(Math.round(target)), 110);   // snap to a card
    }, { passive: false });

    // Dragging listens on the window rather than capturing the pointer, so
    // that clicks on the cards still behave like clicks.
    let dragging = null;
    let lastDrag = 0;
    const onMove = (ev) => {
      if (!dragging) return;
      const dy = ev.clientY - dragging.y;
      dragging.moved = Math.max(dragging.moved, Math.abs(dy));
      glide(dragging.from - dy * ROLODEX.dragSensitivity);
    };
    const onUp = () => {
      if (!dragging) return;
      lastDrag = dragging.moved;
      dragging = null;
      drum.classList.remove('dragging');
      glide(Math.round(target));
    };
    drum.addEventListener('pointerdown', (ev) => {
      if (ev.button) return;
      dragging = { y: ev.clientY, from: target, moved: 0 };
      lastDrag = 0;
      drum.classList.add('dragging');
    });
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
    addEventListener('pointercancel', onUp);

    drum.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown') { glide(Math.round(target) + 1); ev.preventDefault(); }
      if (ev.key === 'ArrowUp') { glide(Math.round(target) - 1); ev.preventDefault(); }
    });

    cards.forEach((card, i) => {
      card.addEventListener('click', () => {
        if (lastDrag > 4) return;                          // that was a drag, not a click
        if (Math.abs(pos - i) < 0.4) onPick(studies[i]);   // already at the front
        else glide(i);
      });
    });
  }

  function syncCounts(rows) {
    const n = new Map();
    const v = new Map();
    for (const f of rows) {
      n.set(f.cat, (n.get(f.cat) || 0) + 1);
      v.set(f.cat, (v.get(f.cat) || 0) + f.v);
    }
    let best = 0;
    for (const [k, val] of v) if (val > best) { best = val; busiest = k; }
    for (const c of COMMODITY_GROUPS) {
      const el = rowEls.get(c.key).querySelector('[data-n]');
      el.textContent = n.get(c.key)
        ? `${fmt(v.get(c.key))} · ${n.get(c.key)}`
        : 'no flows';
    }
  }

  return { openDrawer, closeDrawer, syncCounts, buildRolodex,
           showTimeline, hideTimeline, raise, showForYear, stopPlay, syncCats,
           // Driven once a frame by the render loop, which owns the warp
           // uniforms this scope cannot see; it returns the blend and applies
           // it on this scope's behalf.
           advanceGlide, rewindToStart, playFromHere,
           // Called by rebuild whenever it solves a single year, from wherever:
           // a new metric, a layer toggled, a changed highlight. Anything the
           // timeline had baked ahead describes a map that is no longer on
           // screen, so it must not be reused.
           invalidateGlide: () => { glide.prepared = null; glide.ready = null; },
           tileFor: (st) => (tiles.find((t) => t.d.study === st) || {}).el || null };
}
