import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PropInstance, PropType } from '@shared/world';
import { TOON_RAMP } from './materials';

// Placeholder stylized props built from primitives with baked vertex colours.
// Each type has a full mesh (near/mid rings) and a very cheap far version.

function colorize(geo: THREE.BufferGeometry, hex: string, jitter = 0): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 3) {
    const j = 1 + (Math.sin(i * 12.9898) * 43758.5453 % 1) * jitter;
    for (let k = 0; k < 3 && i + k < n; k++) {
      arr[(i + k) * 3] = c.r * j;
      arr[(i + k) * 3 + 1] = c.g * j;
      arr[(i + k) * 3 + 2] = c.b * j;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  return g;
}

function pine(lod: 'full' | 'far'): THREE.BufferGeometry {
  const seg = lod === 'full' ? 7 : 5;
  const parts = [colorize(new THREE.CylinderGeometry(0.18, 0.28, 2.2, 5).translate(0, 1.1, 0), '#6b4a2f')];
  const tiers = lod === 'full' ? 3 : 1;
  for (let t = 0; t < tiers; t++) {
    const r = lod === 'full' ? 2.2 - t * 0.55 : 2.0;
    const h = lod === 'full' ? 3.2 - t * 0.5 : 6.5;
    const y = lod === 'full' ? 2.4 + t * 1.6 : 1.8;
    parts.push(colorize(new THREE.ConeGeometry(r, h, seg).translate(0, y + h / 2, 0), t % 2 ? '#2f6b3a' : '#2a5f35', 0.15));
  }
  return mergeGeometries(parts)!;
}

function broadleaf(lod: 'full' | 'far'): THREE.BufferGeometry {
  const parts = [colorize(new THREE.CylinderGeometry(0.22, 0.32, 2.6, 5).translate(0, 1.3, 0), '#7a5534')];
  if (lod === 'full') {
    parts.push(colorize(new THREE.IcosahedronGeometry(2.1, 0).translate(0, 4.0, 0), '#5f9e3c', 0.2));
    parts.push(colorize(new THREE.IcosahedronGeometry(1.5, 0).translate(1.1, 3.3, 0.6), '#6daa42', 0.2));
    parts.push(colorize(new THREE.IcosahedronGeometry(1.4, 0).translate(-1.0, 3.5, -0.5), '#579336', 0.2));
  } else {
    parts.push(colorize(new THREE.IcosahedronGeometry(2.4, 0).translate(0, 3.8, 0), '#5f9e3c'));
  }
  return mergeGeometries(parts)!;
}

function bush(): THREE.BufferGeometry {
  return mergeGeometries([
    colorize(new THREE.IcosahedronGeometry(0.8, 0).scale(1.2, 0.8, 1.2).translate(0, 0.45, 0), '#4f8a34', 0.2),
    colorize(new THREE.IcosahedronGeometry(0.55, 0).translate(0.5, 0.5, 0.3), '#5c9a3a', 0.2),
  ])!;
}

function rock(): THREE.BufferGeometry {
  return colorize(new THREE.DodecahedronGeometry(1, 0).scale(1.3, 0.75, 1.1).translate(0, 0.35, 0), '#8d877c', 0.18);
}

interface PropKind {
  full: THREE.BufferGeometry;
  far: THREE.BufferGeometry | null;
  castShadow: boolean;
}

let kinds: Record<PropType, PropKind> | null = null;
let material: THREE.MeshToonNodeMaterial | null = null;

function getKinds(): Record<PropType, PropKind> {
  kinds ??= {
    pine: { full: pine('full'), far: pine('far'), castShadow: true },
    broadleaf: { full: broadleaf('full'), far: broadleaf('far'), castShadow: true },
    bush: { full: bush(), far: null, castShadow: false },
    rock: { full: rock(), far: null, castShadow: true },
  };
  return kinds;
}

export type PropLod = 'near' | 'mid' | 'far';

/** One InstancedMesh per prop type present in the chunk. */
export function buildPropMeshes(props: PropInstance[], lod: PropLod, density: number): THREE.InstancedMesh[] {
  const k = getKinds();
  material ??= new THREE.MeshToonNodeMaterial({ vertexColors: true, gradientMap: TOON_RAMP });
  const byType = new Map<PropType, PropInstance[]>();
  const keepEvery = density >= 1 ? 1 : 1 / Math.max(density, 0.05);
  let idx = 0;
  for (const p of props) {
    idx++;
    if (keepEvery > 1 && idx % Math.round(keepEvery) !== 0 && p.t !== 'pine' && p.t !== 'broadleaf') continue;
    if (lod === 'far' && !k[p.t].far) continue;
    let arr = byType.get(p.t);
    if (!arr) byType.set(p.t, (arr = []));
    arr.push(p);
  }
  const out: THREE.InstancedMesh[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const sc = new THREE.Vector3();
  for (const [t, list] of byType) {
    const kind = k[t];
    const geo = lod === 'far' ? kind.far! : kind.full;
    const mesh = new THREE.InstancedMesh(geo, material, list.length);
    list.forEach((p, i) => {
      q.setFromAxisAngle(up, p.r);
      pos.set(p.p[0], p.p[1], p.p[2]);
      sc.setScalar(p.s);
      m.compose(pos, q, sc);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = kind.castShadow && lod === 'near';
    mesh.receiveShadow = lod !== 'far';
    mesh.name = `prop:${t}`;
    out.push(mesh);
  }
  return out;
}
