import * as THREE from 'three';
import { clamp, fbm, lerp, smoothstep } from './util.js';

export const EYE_HEIGHT = 1.6;

// Largura (m) que o painel da foto precisa ter para parecer a foto original vista do ponto de início.
export const reliefWidthM = r => 2 * r.distance * Math.tan(THREE.MathUtils.degToRad(r.fov / 2));

// Altura do terreno em (x, z). A MESMA função gera a malha, a colisão e o "pousar no chão" dos objetos.
export function makeHeightFn(env, relief, hasRelief) {
  const R = env.radius, bump = env.terrainBump, seed = env.seed | 0;
  const W = hasRelief && relief.enabled ? reliefWidthM(relief) : 0;
  return (x, z) => {
    if (!env.terrain || bump <= 0.0001) return 0;
    const r = Math.hypot(x, z);
    let m = smoothstep(4, 12, r);                       // plano ao redor do ponto de início
    if (W > 0) {                                        // e junto ao painel da foto
      const dx = Math.max(Math.abs(x) - (W / 2 + 6), 0);
      const dz = Math.max(Math.abs(z + relief.distance) - 10, 0);
      m = Math.min(m, smoothstep(0, 10, Math.hypot(dx, dz)));
    }
    m *= 1 - smoothstep(R - 12, R, r);                  // borda do mundo volta a 0 e emenda nas colinas
    const n = fbm(x / 22, z / 22, seed, 3) - 0.5;
    const broad = fbm(x / 70 + 9.1, z / 70 - 3.3, seed + 5, 2) - 0.5;
    return (n * 1.6 + broad * 2.4) * bump * 2 * m;
  };
}

// Malha polar: anéis x segmentos. Triângulos (a,c,b) e (b,c,d) ficam virados para cima.
function polarGrid(rings, segs, radiusAt, heightFn, colorFn, uvScale) {
  const n = (rings + 1) * (segs + 1);
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let p = 0, c = 0, u = 0;
  for (let i = 0; i <= rings; i++) {
    const r = radiusAt(i / rings);
    for (let j = 0; j <= segs; j++) {
      const th = (j / segs) * Math.PI * 2;
      const x = r * Math.cos(th), z = r * Math.sin(th);
      const y = heightFn(x, z, i / rings);
      pos[p++] = x; pos[p++] = y; pos[p++] = z;
      const cc = colorFn(x, z, i / rings, y);
      col[c++] = cc.r; col[c++] = cc.g; col[c++] = cc.b;
      uv[u++] = x / uvScale; uv[u++] = z / uvScale;
    }
  }
  const idx = [];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * (segs + 1) + j, b = (i + 1) * (segs + 1) + j;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function buildTerrain(env, heightFn, groundTexture) {
  const base = new THREE.Color(env.groundColor);
  const tmp = new THREE.Color();
  const geo = polarGrid(72, 144, t => env.radius * t, (x, z) => heightFn(x, z),
    (x, z) => {
      const v = 0.86 + 0.28 * fbm(x / 6, z / 6, env.seed + 99, 2);   // manchas de variação
      return tmp.copy(base).multiplyScalar(v);
    }, Math.max(1, env.textureTile));
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 1, metalness: 0,
    map: env.groundTexture ? groundTexture : null,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terreno';
  mesh.receiveShadow = true;
  return mesh;
}

// Anel de colinas distantes ao redor do mundo jogável: dá o "360°" sem custo de física.
export function buildHills(env) {
  const R0 = env.radius, W = 70, amp = env.hillHeight;
  const ground = new THREE.Color(env.groundColor), hill = new THREE.Color(env.hillColor);
  const haze = new THREE.Color(env.skyHorizon), tmp = new THREE.Color();
  const geo = polarGrid(16, 160, t => R0 + W * t,
    (x, z, t) => {
      const ridge = 0.35 + 0.65 * fbm(x / 55, z / 55, env.seed + 7, 3);
      return amp * smoothstep(0, 0.45, t) * ridge * (0.6 + 0.4 * t);
    },
    (x, z, t) => {
      tmp.copy(ground).lerp(hill, smoothstep(0, 0.3, t)).lerp(haze, t * 0.45);
      return tmp.multiplyScalar(0.9 + 0.2 * fbm(x / 9, z / 9, env.seed + 3, 2));
    }, 10);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  mesh.name = 'colinas';
  mesh.receiveShadow = true;
  return mesh;
}

// Céu: esfera com cores por vértice (gradiente + brilho do sol). Sem shader, então exporta para GLB
// e o arquivo fica igual ao que se vê. Faces viradas para dentro (escala -1 em X inverte a orientação).
export function buildSky(env, map = null) {
  const g = new THREE.SphereGeometry(450, 64, 40);
  g.scale(-1, 1, 1);
  const top = new THREE.Color(env.skyTop), hor = new THREE.Color(env.skyHorizon);
  const sun = sunDirection(env);
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    n.fromBufferAttribute(pos, i).normalize();
    const h = Math.max(0, n.y);
    c.copy(hor).lerp(top, Math.pow(h, 0.55));
    const glow = Math.pow(Math.max(0, n.dot(sun)), 180) * 1.4 + Math.pow(Math.max(0, n.dot(sun)), 8) * 0.12;
    c.r = clamp(c.r + glow, 0, 1); c.g = clamp(c.g + glow * 0.95, 0, 1); c.b = clamp(c.b + glow * 0.8, 0, 1);
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // Com panorama (textura equirretangular da foto), a esfera usa as UVs da própria geometria.
  // Sem ele, fica o degradê por vértice de antes.
  if (map) {
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map, fog: false, depthWrite: false, toneMapped: false }));
    mesh.name = 'ceu';
    mesh.renderOrder = -10;
    mesh.frustumCulled = false;
    return mesh;
  }
  g.deleteAttribute('uv');
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    vertexColors: true, fog: false, depthWrite: false, toneMapped: false,
  }));
  mesh.name = 'ceu';
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  return mesh;
}

export function sunDirection(env) {
  const az = THREE.MathUtils.degToRad(env.sunAzimuth), el = THREE.MathUtils.degToRad(env.sunElevation);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
}

