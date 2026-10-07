// The morphing sheet: twenty gnomonic triangles that start as a sphere,
// harden into an icosahedron, and hinge open into the Dymaxion net.
//
//   vertex position = mix(sphere point, flat face point, uFacet)   [local]
//   face transform  = U(u) . A . G_f(s)
//
// where G_f(s) is the product of hinge rotations from the root face down the
// fold tree, A places the folded solid onto the globe, and U(u) turns the
// finished sheet to face the camera. At s = 1 the twenty faces weld into the
// icosahedron; at s = 0, u = 1 they lie exactly in the z = 0 plane in net
// coordinates, which is what everything drawn on top of the map assumes.
import * as THREE from 'three';
import { DYMAXION } from './dymaxion-data.js';
import { WARP_GLSL, borderHold } from './warp.js';
import { MESH_SUBDIVISION as SUBDIV, FACE_GRID, PEEL } from './config.js';

const VERTEX_SHADER = /* glsl */`
attribute vec3 aSphere;
attribute vec3 aSphereN;
attribute vec3 aBary;
attribute float aHold;
uniform float uFacet;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vBary;
${WARP_GLSL}
void main() {
  vec3 p = mix(aSphere, position, uFacet);
  vec3 n = normalize(mix(aSphereN, vec3(0.0, 0.0, 1.0), uFacet));
  vec4 world = modelMatrix * vec4(p, 1.0);
  world.xy += warpOffset(world.xy, aHold);
  vNormal = normalize(mat3(modelMatrix) * n);
  vUv = uv;
  vBary = aBary;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

// The grid drawn on the sheet is the icosahedron's own subdivision: lines of
// constant barycentric coordinate within each face, which is the triangular
// lattice the projection is actually built on. A graticule would sit at an
// angle to it and tell you nothing about the geometry.
const FRAGMENT_SHADER = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uEdgeColor;
uniform float uEdgeOpacity;
uniform vec3 uGridColor;
uniform float uGridOpacity;
uniform float uGrid;
uniform float uOpacity;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vBary;
void main() {
  vec3 base = texture2D(uMap, vUv).rgb;
  vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  float key  = max(dot(n, normalize(vec3(0.30, -0.55, 0.78))), 0.0);
  float fill = max(dot(n, normalize(vec3(-0.65, 0.25, 0.45))), 0.0);
  vec3 col = base * (0.80 + 0.22 * key + 0.10 * fill);

  if (uGridOpacity > 0.001) {
    vec3 g = vBary * uGrid;
    vec3 w = fwidth(g);
    vec3 f = abs(fract(g - 0.5) - 0.5) / max(w, vec3(1e-5));
    float line = 1.0 - smoothstep(0.0, 1.0, min(min(f.x, f.y), f.z));
    col = mix(col, uGridColor, line * uGridOpacity);
  }

  float edge = min(min(vBary.x, vBary.y), vBary.z);
  float d = edge / max(fwidth(edge), 1e-6);
  col = mix(col, uEdgeColor, (1.0 - smoothstep(0.0, 1.8, d)) * uEdgeOpacity);
  gl_FragColor = vec4(col, uOpacity);
  #include <colorspace_fragment>
}`;

function hingeMatrix(hinge, angle) {
  const ax = hinge[0][0], ay = hinge[0][1];
  const dir = new THREE.Vector3(hinge[1][0] - ax, hinge[1][1] - ay, 0).normalize();
  return new THREE.Matrix4().makeTranslation(ax, ay, 0)
    .multiply(new THREE.Matrix4().makeRotationAxis(dir, angle))
    .multiply(new THREE.Matrix4().makeTranslation(-ax, -ay, 0));
}

/** Net triangle -> a grid of (barycentric) sample points and triangle indices. */
function subdivide(n) {
  const rows = [];
  let k = 0;
  for (let i = 0; i <= n; i++) {
    const row = [];
    for (let j = 0; j <= i; j++) row.push(k++);
    rows.push(row);
  }
  const bary = [];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= i; j++) {
      // corner 0 at the apex row 0, corners 1 and 2 along the last row
      const b2 = i === 0 ? 0 : j / i;
      const b1 = i === 0 ? 0 : (i - j) / i;
      bary.push([1 - i / n, (i / n) * b1, (i / n) * b2]);
    }
  }
  const tris = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      tris.push([rows[i][j], rows[i + 1][j], rows[i + 1][j + 1]]);
      if (j < i) tris.push([rows[i][j], rows[i + 1][j + 1], rows[i][j + 1]]);
    }
  }
  return { bary, tris };
}

export function buildSheet(map, warpUniforms, colors) {
  const PIECES = DYMAXION.pieces;
  const N = PIECES.length;
  const A = new THREE.Matrix4();
  const R = DYMAXION.align.R, t = DYMAXION.align.t;
  A.set(R[0][0], R[0][1], R[0][2], t[0],
        R[1][0], R[1][1], R[1][2], t[1],
        R[2][0], R[2][1], R[2][2], t[2],
        0, 0, 0, 1);
  const Ainv = A.clone().invert();

  // Breadth-first over the fold tree so parents are always resolved first.
  const order = [];
  const queue = [DYMAXION.root];
  const children = new Map();
  PIECES.forEach((pc, i) => {
    if (pc.parent >= 0) {
      if (!children.has(pc.parent)) children.set(pc.parent, []);
      children.get(pc.parent).push(i);
    }
  });
  while (queue.length) {
    const f = queue.shift();
    order.push(f);
    for (const c of children.get(f) || []) queue.push(c);
  }

  // Per-hinge timing. Folding every hinge in lockstep means a piece at depth d
  // travels through d compound rotations at once, so the far end of the net
  // whips around and sweeps through its neighbours. Letting the hinges near
  // the root lead, and the outer ones follow, turns that into a peel: each
  // hinge still travels the full angle, just over its own slice of the window.
  const maxDepth = DYMAXION.maxDepth || 1;
  const LEAD = PEEL * (maxDepth > 0 ? 1 / maxDepth : 0);
  const span = 1 - PEEL;
  // Eased inside the window, not clamped-linear. A bare clamp gives every
  // hinge a corner at each end of its slice — it snaps into motion and snaps
  // to a halt — and with six depths that reads as a run of small jerks
  // through the unfold. Smoothstep starts and ends each hinge at zero rate,
  // so the whole fold is smooth in velocity as well as position. The caller
  // passes a linear fold for this reason; easing both would just compress
  // each hinge's travel into the middle of its slice and speed it up.
  const ease = (x) => x * x * (3 - 2 * x);
  const localS = (s, depth) =>
    ease(THREE.MathUtils.clamp((s - (maxDepth - depth) * LEAD) / span, 0, 1));

  const G = new Array(N).fill(null).map(() => new THREE.Matrix4());
  function updateFold(s) {
    for (const i of order) {
      const pc = PIECES[i];
      if (pc.parent < 0) G[i].identity();
      else {
        // Linear inside the window on purpose: the caller already eases the
        // fold as a whole, and easing again here would compress each hinge's
        // travel into the middle of its slice and speed it up.
        G[i].multiplyMatrices(G[pc.parent],
          hingeMatrix(pc.hinge, localS(s, pc.depth) * DYMAXION.foldAngle));
      }
    }
  }
  updateFold(1);
  const folded = G.map((m) => A.clone().multiply(m));

  const uniforms = {
    uMap: { value: map },
    uFacet: { value: 0 },
    uEdgeColor: { value: new THREE.Color(colors.edge) },
    uEdgeOpacity: { value: 0 },
    uGridColor: { value: new THREE.Color(colors.grid) },
    uGridOpacity: { value: FACE_GRID.opacity },
    uGrid: { value: FACE_GRID.divisions },
    uOpacity: { value: 1 },
    ...warpUniforms,
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    side: THREE.DoubleSide,
  });

  // A wedge is a sixth of a face, so it needs fewer steps to match the
  // sampling density the whole-face subdivision used to give.
  const WSUB = Math.max(3, Math.round(SUBDIV / Math.sqrt(6)));
  const { bary, tris } = subdivide(WSUB);
  const group = new THREE.Group();
  const meshes = [];
  const tmp = new THREE.Vector3();

  for (let pi = 0; pi < N; pi++) {
    const piece = PIECES[pi];
    const M1 = folded[pi];
    const M1inv = M1.clone().invert();
    const N1inv = new THREE.Matrix3().setFromMatrix4(M1inv);

    const count = piece.tris.length * tris.length * 3;
    const aPos = new Float32Array(count * 3);
    const aSph = new Float32Array(count * 3);
    const aSphN = new Float32Array(count * 3);
    const aUv = new Float32Array(count * 2);
    const aBary = new Float32Array(count * 3);
    const aHold = new Float32Array(count);
    let v = 0;

    for (const wedge of piece.tris) {
      const corners = wedge.p;             // net-space corners of this wedge
      const fb = wedge.b;                  // the same corners, as face barycentrics
      // Half the net's pieces are mirrored — 11 wind one way and 11 the other,
      // which is a property of the net, not a mistake in it. Emitting their
      // triangles in lattice order would wind them backwards, so the sheet
      // renders as two populations: DoubleSide draws them either way, but
      // gl_FrontFacing comes out false for the mirrored ones, the fragment
      // shader flips their normal to face away from both lights, and those
      // pieces shade at 0.80 against 1.02 for the rest. That is visible as
      // whole triangles of the map being a darker grey. Flipping the winding
      // here keeps every triangle facing the same way.
      const mirrored = (corners[1][0] - corners[0][0]) * (corners[2][1] - corners[0][1])
                     - (corners[1][1] - corners[0][1]) * (corners[2][0] - corners[0][0]) < 0;
      const flat = [], sph = [], sphN = [], uvs = [], faceBary = [];
      for (const b of bary) {
        const x = b[0] * corners[0][0] + b[1] * corners[1][0] + b[2] * corners[2][0];
        const y = b[0] * corners[0][1] + b[1] * corners[1][1] + b[2] * corners[2][1];
        flat.push([x, y, 0]);
        // The folded transform lands the flat point on its face's plane in 3D,
        // so normalising it gives the sphere point this pixel came from.
        const dir = tmp.set(x, y, 0).applyMatrix4(M1).normalize().clone();
        const local = dir.clone().applyMatrix4(M1inv);
        const localN = dir.clone().applyMatrix3(N1inv).normalize();
        sph.push([local.x, local.y, local.z]);
        sphN.push([localN.x, localN.y, localN.z]);
        uvs.push([
          Math.atan2(dir.y, dir.x) / (2 * Math.PI) + 0.5,
          Math.asin(THREE.MathUtils.clamp(dir.z, -1, 1)) / Math.PI + 0.5,
        ]);
        // Barycentric on the whole face, so the drawn grid stays the face's
        // own subdivision rather than the wedge's.
        faceBary.push([0, 1, 2].map((j) =>
          b[0] * fb[0][j] + b[1] * fb[1][j] + b[2] * fb[2][j]));
      }
      const hold = flat.map((p) => borderHold(p[0], p[1]));

      for (const tri of tris) {
        const wound = mirrored ? [tri[0], tri[2], tri[1]] : tri;
        // Keep each triangle's longitudes on one side of the seam.
        const u = wound.map((i) => uvs[i][0]);
        if (Math.max(...u) - Math.min(...u) > 0.5) {
          for (let i = 0; i < 3; i++) if (u[i] < 0.5) u[i] += 1;
        }
        for (let i = 0; i < 3; i++) {
          const idx = wound[i];
          aPos.set(flat[idx], v * 3);
          aSph.set(sph[idx], v * 3);
          aSphN.set(sphN[idx], v * 3);
          aUv[v * 2] = u[i];
          aUv[v * 2 + 1] = uvs[idx][1];
          aBary.set(faceBary[idx], v * 3);
          aHold[v] = hold[idx];
          v++;
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(aPos, 3));
    geo.setAttribute('aSphere', new THREE.BufferAttribute(aSph, 3));
    geo.setAttribute('aSphereN', new THREE.BufferAttribute(aSphN, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(aUv, 2));
    geo.setAttribute('aBary', new THREE.BufferAttribute(aBary, 3));
    geo.setAttribute('aHold', new THREE.BufferAttribute(aHold, 1));

    const mesh = new THREE.Mesh(geo, material);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    group.add(mesh);
    meshes.push(mesh);
  }

  const U = new THREE.Matrix4();
  const spin = new THREE.Matrix4();
  const head = new THREE.Matrix4();
  const scratch = new THREE.Matrix4();
  const qI = new THREE.Quaternion();
  const qT = new THREE.Quaternion();
  const pT = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const junk = new THREE.Vector3();

  const identity = new THREE.Quaternion();

  /**
   * The sheet stops turning wherever the globe had been turned to, so U has to
   * undo that orientation as well as the alignment to land square to the
   * camera.
   * @param {THREE.Quaternion} rot  the globe's orientation when it settles
   */
  function setSpinTarget(rot) {
    scratch.makeRotationFromQuaternion(rot).multiply(A).invert().decompose(pT, qT, junk);
  }
  setSpinTarget(identity);

  /**
   * @param {number} s   1 = folded onto the globe, 0 = flat
   * @param {number} u   0 = sheet left where it folded, 1 = square to the camera
   * @param {THREE.Quaternion} rot  how the globe is turned — any orientation,
   *                                not just a spin about the pole
   */
  function setPose(s, u, rot = identity) {
    updateFold(s);
    q.copy(qI).slerp(qT, u);
    p.set(0, 0, 0).lerp(pT, u);
    U.compose(p, q, one);
    head.multiplyMatrices(U, spin.makeRotationFromQuaternion(rot)).multiply(A);
    for (let i = 0; i < N; i++) {
      meshes[i].matrix.multiplyMatrices(head, G[i]);
      meshes[i].matrixWorldNeedsUpdate = true;
    }
  }

  setPose(1, 0, identity);

  return { group, meshes, material, uniforms, setPose, setSpinTarget, align: A, alignInverse: Ainv };
}
