import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng, lerp, noise2, jitterColor } from './util.js';
import { reliefWidthM } from './terrain.js';

// Objetos gerados por código (leves, com visual "low poly" e variação por semente). Origem = centro da base,
// +Y para cima, frente = +Z. Cada tipo devolve também os colisores simples (`specs`, no espaço local).
const TAU = Math.PI * 2;

class Builder {
  constructor() { this.lists = new Map(); }

  // Une tudo o que tem a mesma cor em UMA malha (poucas chamadas de desenho, arquivo enxuto).
  add(geo, color, { at = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1] } = {}) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...at),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), new THREE.Vector3(...scale));
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    g.deleteAttribute('uv');
    g.applyMatrix4(m);
    g.computeVertexNormals();                       // sombreamento facetado
    const key = new THREE.Color(color).getHexString();
    if (!this.lists.has(key)) this.lists.set(key, []);
    this.lists.get(key).push(g);
  }

  build(matFor) {
    const group = new THREE.Group();
    for (const [hex, list] of this.lists) {
      const mesh = new THREE.Mesh(mergeGeometries(list), matFor(hex));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  }
}

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt, rb, h, seg = 8) => new THREE.CylinderGeometry(rt, rb, h, seg);
const ico = (r, detail = 1) => new THREE.IcosahedronGeometry(r, detail);
const dark = (c, k) => new THREE.Color(c).multiplyScalar(k);

// Telhado de duas águas: cumeeira ao longo de Z, base em y = 0, centrado em X/Z.
function prism(w, h, d) {
  const A = [-w / 2, 0, d / 2], B = [w / 2, 0, d / 2], C = [0, h, d / 2];
  const D = [-w / 2, 0, -d / 2], E = [w / 2, 0, -d / 2], F = [0, h, -d / 2];
  const tris = [[A, B, C], [E, D, F], [A, C, F], [A, F, D], [B, E, F], [B, F, C], [A, D, E], [A, E, B]];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(2), 3));
  g.computeVertexNormals();
  return g;
}

const WOOD_DARK = '#4a3524', GLASS = '#34475c', TRIM = '#efe9dc';

function buildTree({ b, r, pal }) {
  const h = lerp(2.2, 3.0, r()), tr = lerp(0.17, 0.24, r());
  b.add(cyl(tr * 0.75, tr, h, 7), jitterColor(pal.trunk, r, 0.1), { at: [0, h / 2, 0] });
  const R = lerp(1.5, 2.0, r());
  b.add(ico(R), jitterColor(pal.foliage, r, 0.14), { at: [0, h + R * 0.55, 0], scale: [1, 0.9, 1] });
  for (let i = 0; i < 3; i++) {
    const a = r() * TAU;
    b.add(ico(R * lerp(0.45, 0.6, r())), jitterColor(pal.foliage, r, 0.14),
      { at: [Math.cos(a) * R * 0.6, h + R * lerp(0.2, 0.8, r()), Math.sin(a) * R * 0.6] });
  }
  return [{ shape: 'cyl', r: tr + 0.1, h, at: [0, h / 2, 0] }];
}

function buildPine({ b, r, pal }) {
  const th = lerp(0.9, 1.3, r());
  b.add(cyl(0.14, 0.2, th, 7), jitterColor(pal.trunk, r, 0.1), { at: [0, th / 2, 0] });
  const n = 4, leaf = dark(jitterColor(pal.foliage, r, 0.1), 0.78);
  for (let i = 0; i < n; i++) {
    const rad = lerp(1.7, 0.6, i / (n - 1)) * lerp(0.9, 1.1, r()), hh = 1.7;
    b.add(new THREE.ConeGeometry(rad, hh, 8), leaf, { at: [0, th + 0.4 + i * 1.05 + hh / 2, 0] });
  }
  return [{ shape: 'cyl', r: 0.32, h: 2.4, at: [0, 1.2, 0] }];
}

function buildBush({ b, r, pal }) {
  const n = 2 + Math.floor(r() * 2);
  for (let i = 0; i < n; i++) {
    const a = r() * TAU, rad = lerp(0.45, 0.7, r());
    b.add(ico(rad), jitterColor(pal.foliage, r, 0.12), { at: [Math.cos(a) * 0.4, rad * 0.7, Math.sin(a) * 0.4], scale: [1, 0.8, 1] });
  }
  return [];
}

function addBuilding(b, r, pal, { w, d, h, roofH, barn }) {
  const wall = jitterColor(pal.building, r, 0.06), roof = jitterColor(pal.roof, r, 0.06);
  b.add(box(w, h, d), wall, { at: [0, h / 2, 0] });
  b.add(prism(w + 0.7, roofH, d + 0.7), roof, { at: [0, h, 0] });
  const z = d / 2 + 0.03;
  if (barn) {
    b.add(box(2.6, h * 0.78, 0.08), TRIM, { at: [0, h * 0.39, z] });                 // portão duplo
    b.add(box(0.1, h * 0.78, 0.1), dark(wall, 0.6), { at: [0, h * 0.39, z + 0.02] });
    for (const s of [-1, 1]) b.add(box(0.8, 0.8, 0.08), TRIM, { at: [s * (w / 2 - 1.2), h * 0.62, z] });
  } else {
    b.add(box(0.95, 1.95, 0.08), WOOD_DARK, { at: [w * 0.18, 0.975, z] });          // porta
    for (const s of [-1, 1]) b.add(box(1.0, 0.95, 0.08), GLASS, { at: [s * w * 0.3, h * 0.6, z] });
    b.add(box(0.55, 1.3, 0.55), dark(wall, 0.75), { at: [w * 0.25, h + roofH * 0.7, -d * 0.2] });   // chaminé
  }
  return [{ shape: 'box', size: [w, h + roofH * 0.6, d], at: [0, (h + roofH * 0.6) / 2, 0] }];
}

const buildHouse = ({ b, r, pal }) => addBuilding(b, r, pal,
  { w: lerp(5.5, 7.5, r()), d: lerp(4.5, 6, r()), h: lerp(2.8, 3.2, r()), roofH: lerp(1.6, 2.2, r()) });
const buildBarn = ({ b, r, pal }) => addBuilding(b, r, pal,
  { w: lerp(7, 8.5, r()), d: lerp(10, 12, r()), h: lerp(3.6, 4.2, r()), roofH: lerp(2.4, 3.0, r()), barn: true });

function buildBench({ b, r, pal }) {
  const wood = jitterColor(pal.trunk, r, 0.08), metal = '#3b3f45';
  b.add(box(1.7, 0.07, 0.46), wood, { at: [0, 0.46, 0] });
  b.add(box(1.7, 0.42, 0.06), wood, { at: [0, 0.78, -0.22], rot: [-0.12, 0, 0] });
  for (const s of [-1, 1]) {
    b.add(box(0.06, 0.46, 0.46), metal, { at: [s * 0.78, 0.23, 0] });
    b.add(box(0.06, 0.34, 0.06), metal, { at: [s * 0.78, 0.63, -0.24] });
  }
  return [{ shape: 'box', size: [1.7, 0.95, 0.55], at: [0, 0.475, -0.05] }];
}

function buildLamp({ b }) {
  b.add(cyl(0.2, 0.24, 0.25, 8), '#2f3237', { at: [0, 0.125, 0] });
  b.add(cyl(0.05, 0.07, 4.0, 8), '#3b3f45', { at: [0, 2.0, 0] });
  b.add(box(0.5, 0.08, 0.5), '#2f3237', { at: [0, 4.05, 0] });
  b.add(box(0.36, 0.26, 0.36), '#ffe9a8', { at: [0, 3.88, 0] });
  return [{ shape: 'cyl', r: 0.14, h: 4.1, at: [0, 2.05, 0] }];
}

function buildRock({ b, r }) {
  const g = ico(0.85, 1).toNonIndexed();
  const p = g.attributes.position, seed = Math.floor(r() * 1000);
  for (let i = 0; i < p.count; i++) {                // deslocamento por posição: vértices iguais saem iguais
    const k = 0.78 + 0.5 * noise2(p.getX(i) * 2.1 + seed, p.getZ(i) * 2.1 - seed, seed) + 0.1 * p.getY(i);
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
  }
  const v = lerp(0.5, 0.62, r());
  b.add(g, new THREE.Color(v, v, v * 0.98), { at: [0, 0.4, 0], scale: [lerp(1, 1.4, r()), lerp(0.6, 0.85, r()), lerp(0.9, 1.2, r())] });
  return [{ shape: 'hull' }];
}

function buildFence({ b, r, pal }) {
  const wood = jitterColor(pal.trunk, r, 0.08), L = 3;
  for (const s of [-1, 0, 1]) b.add(box(0.12, 1.05, 0.12), wood, { at: [s * L / 2, 0.525, 0] });
  for (const y of [0.45, 0.85]) b.add(box(L + 0.12, 0.09, 0.05), wood, { at: [0, y, 0] });
  return [{ shape: 'box', size: [L + 0.12, 1.05, 0.14], at: [0, 0.525, 0] }];
}

// ---- objetos urbanos ---------------------------------------------------------------------------

function buildBuilding({ b, r, pal }) {
  // Prédio de 3-5 andares com janelas e laje plana
  const floors = 3 + Math.floor(r() * 3);
  const flH = lerp(2.6, 3.2, r());
  const h = floors * flH;
  const w = lerp(9, 15, r()), d = lerp(7, 11, r());
  const wall = jitterColor(pal.building, r, 0.05);
  b.add(box(w, h, d), wall, { at: [0, h / 2, 0] });
  // Janelas por andar
  for (let f = 0; f < floors; f++) {
    const wy = f * flH + flH * 0.55;
    const cols = Math.floor(w / 2.8);
    for (let c = -(cols - 1) / 2; c <= (cols - 1) / 2; c++) {
      b.add(box(1.1, 0.85, 0.08), GLASS, { at: [c * 2.4, wy, d / 2 + 0.01] });
    }
  }
  // Laje plana no topo
  b.add(box(w + 0.4, 0.3, d + 0.4), dark(wall, 0.55), { at: [0, h + 0.15, 0] });
  // Entrada no térreo
  b.add(box(1.8, 2.4, 0.09), GLASS, { at: [0, 1.2, d / 2 + 0.01] });
  return [{ shape: 'box', size: [w, h + 0.3, d], at: [0, (h + 0.3) / 2, 0] }];
}

function buildCar({ b, r }) {
  // Carro genérico — cor variada, corpo + teto + rodas
  const CAR_COLORS = ['#c43030', '#2255bb', '#228833', '#888899', '#ddddcc', '#553300', '#cc8800'];
  const cl = CAR_COLORS[Math.floor(r() * CAR_COLORS.length)];
  const len = lerp(3.8, 4.6, r()), wid = lerp(1.65, 1.9, r()), hb = lerp(0.65, 0.78, r());
  const ht = lerp(0.52, 0.62, r());
  b.add(box(wid, hb, len), cl, { at: [0, hb / 2, 0] });                                     // carroçaria
  b.add(box(wid * 0.88, ht, len * 0.56), cl, { at: [0, hb + ht / 2, len * 0.05] });         // teto
  // Para-brisas e vidrão traseiro
  b.add(box(wid * 0.84, ht * 0.8, 0.07), GLASS, { at: [0, hb + ht * 0.35, len * 0.28] });
  b.add(box(wid * 0.84, ht * 0.8, 0.07), GLASS, { at: [0, hb + ht * 0.35, -len * 0.28] });
  // Rodas (4)
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    b.add(cyl(0.29, 0.29, 0.19, 10), '#111111',
      { at: [sx * (wid / 2 + 0.04), 0.29, sz * len * 0.3], rot: [0, 0, Math.PI / 2] });
  }
  return [{ shape: 'box', size: [wid + 0.1, hb + ht + 0.05, len], at: [0, (hb + ht) / 2, 0] }];
}

function buildHedge({ b, r, pal }) {
  // Sebe topiada / sebe de jardim urbano: bloco retangular de verde
  const w = lerp(1.6, 3.2, r()), h = lerp(1.0, 1.8, r()), d = lerp(0.55, 0.9, r());
  const col = jitterColor(pal.foliage, r, 0.07);
  b.add(box(w, h, d), col, { at: [0, h / 2, 0] });
  b.add(box(w * 0.95, h * 0.12, d * 0.95), dark(col, 0.65), { at: [0, h + 0.06, 0] });  // tampo ligeiramente mais escuro
  return [{ shape: 'box', size: [w, h, d], at: [0, h / 2, 0] }];
}

function buildPalm({ b, r, pal }) {
  // Palmeira: tronco curvo + leque de folhas, bom para praia e jardim tropical
  const th = lerp(5, 8, r()), tr = lerp(0.14, 0.2, r());
  b.add(cyl(tr * 0.65, tr, th, 7), jitterColor('#7a5c3a', r, 0.1), { at: [0, th / 2, 0] });
  const nLeaves = 5 + Math.floor(r() * 3);
  for (let i = 0; i < nLeaves; i++) {
    const a = (i / nLeaves) * Math.PI * 2;
    const len2 = lerp(2.5, 3.5, r()), tilt = lerp(0.4, 0.75, r());
    b.add(box(0.25, 0.1, len2), jitterColor(pal.foliage, r, 0.1),
      { at: [Math.cos(a) * len2 / 2 * tilt, th + 0.1, Math.sin(a) * len2 / 2 * tilt],
        rot: [-(Math.PI * tilt * 0.4), a, 0] });
  }
  return [{ shape: 'cyl', r: tr + 0.1, h: th, at: [0, th / 2, 0] }];
}


// ---- objetos por contexto: neve, alpino, tropical, suburbano -------------------------------------
const SNOW = '#f2f5f8';

function buildCabin({ b, r, pal }, snowy = true) {           // cabana de troncos (neve/alpino)
  const w = lerp(4.5, 6, r()), d = lerp(4, 5.2, r()), h = lerp(2.4, 2.8, r()), roofH = lerp(1.5, 2.0, r());
  b.add(box(w, h, d), jitterColor(pal.trunk, r, 0.08), { at: [0, h / 2, 0] });
  for (let y = 0.35; y < h; y += 0.5) b.add(box(w + 0.1, 0.08, d + 0.1), dark(pal.trunk, 0.7), { at: [0, y, 0] });   // fiadas de tronco
  b.add(prism(w + 0.8, roofH, d + 0.8), snowy ? SNOW : jitterColor(pal.roof, r, 0.06), { at: [0, h, 0] });
  b.add(box(0.9, 1.9, 0.08), WOOD_DARK, { at: [w * 0.2, 0.95, d / 2 + 0.03] });
  b.add(box(0.9, 0.8, 0.08), GLASS, { at: [-w * 0.25, h * 0.6, d / 2 + 0.03] });
  b.add(box(0.5, 1.2, 0.5), '#8a5a44', { at: [w * 0.25, h + roofH * 0.65, -d * 0.2] });                                // chaminé de tijolo
  return [{ shape: 'box', size: [w, h + roofH * 0.6, d], at: [0, (h + roofH * 0.6) / 2, 0] }];
}
const buildHut = ({ b, r, pal }) => {                         // refúgio A-frame de montanha
  const w = lerp(3.2, 4.2, r()), d = lerp(3.4, 4.4, r()), hh = lerp(3.4, 4.2, r());
  b.add(prism(w, hh, d), jitterColor(pal.trunk, r, 0.08), { at: [0, 0, 0] });
  b.add(box(w * 0.55, hh * 0.5, 0.07), GLASS, { at: [0, hh * 0.3, d / 2 + 0.02] });
  return [{ shape: 'box', size: [w, hh * 0.7, d], at: [0, hh * 0.35, 0] }];
};

function buildSnowPine({ b, r, pal }) {                       // pinheiro com neve nos galhos
  const th = lerp(0.9, 1.3, r());
  b.add(cyl(0.14, 0.2, th, 7), jitterColor(pal.trunk, r, 0.1), { at: [0, th / 2, 0] });
  const leaf = dark(jitterColor(pal.foliage, r, 0.1), 0.7);
  for (let i = 0; i < 4; i++) {
    const rad = lerp(1.7, 0.6, i / 3) * lerp(0.9, 1.1, r()), hh = 1.7, y = th + 0.4 + i * 1.05 + hh / 2;
    b.add(new THREE.ConeGeometry(rad, hh, 8), leaf, { at: [0, y, 0] });
    b.add(new THREE.ConeGeometry(rad * 0.82, hh * 0.55, 8), SNOW, { at: [0, y + hh * 0.28, 0] });   // capa de neve
  }
  return [{ shape: 'cyl', r: 0.32, h: 2.4, at: [0, 1.2, 0] }];
}

function buildSnowman({ b, r }) {
  b.add(ico(0.55, 2), SNOW, { at: [0, 0.5, 0] });
  b.add(ico(0.4, 2), SNOW, { at: [0, 1.2, 0] });
  b.add(ico(0.28, 2), SNOW, { at: [0, 1.7, 0] });
  b.add(box(0.06, 0.06, 0.22), '#e07b2a', { at: [0, 1.7, 0.3] });                                        // nariz
  b.add(cyl(0.2, 0.2, 0.22, 8), '#222', { at: [0, 2.0, 0] });                                           // chapéu
  return [{ shape: 'cyl', r: 0.5, h: 2.0, at: [0, 1.0, 0] }];
}

function buildCairn({ b, r }) {                               // pilha de pedras (marco de trilha)
  let y = 0;
  for (let i = 0; i < 5; i++) {
    const rad = lerp(0.42, 0.16, i / 4) * lerp(0.9, 1.1, r());
    b.add(ico(rad, 1), new THREE.Color(0.55, 0.55, 0.57), { at: [(r() - 0.5) * 0.1, y + rad * 0.6, (r() - 0.5) * 0.1], scale: [1.2, 0.7, 1] });
    y += rad * 1.0;
  }
  return [{ shape: 'cyl', r: 0.4, h: y + 0.2, at: [0, (y + 0.2) / 2, 0] }];
}

function buildBanana({ b, r, pal }) {                         // bananeira / planta tropical grande
  const n = 6 + Math.floor(r() * 3);
  b.add(cyl(0.12, 0.16, 1.6, 6), jitterColor('#8aa05a', r, 0.1), { at: [0, 0.8, 0] });
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + r() * 0.4, len = lerp(1.6, 2.3, r());
    b.add(box(0.55, 0.05, len), jitterColor(pal.foliage, r, 0.1),
      { at: [Math.cos(a) * len * 0.45, 1.8 - len * 0.12, Math.sin(a) * len * 0.45], rot: [0.35, -a + Math.PI / 2, 0] });
  }
  return [{ shape: 'cyl', r: 0.25, h: 1.6, at: [0, 0.8, 0] }];
}

function buildPool({ b }) {                                   // piscina com borda de deck (caminhável)
  const w = 7, d = 3.6;
  b.add(box(w + 1.2, 0.12, d + 1.2), '#d9c7a3', { at: [0, 0.06, 0] });
  b.add(box(w, 0.04, d), '#2aa4d8', { at: [0, 0.14, 0] });
  b.add(box(w, 0.02, 0.1), '#e8f6fb', { at: [0, 0.17, d / 2 - 0.05] });
  return [{ shape: 'box', size: [w + 1.2, 0.16, d + 1.2], at: [0, 0.08, 0] }];
}

function buildPergola({ b, r, pal }) {                        // pérgola de madeira (varanda)
  const wood = jitterColor(pal.trunk, r, 0.08), w = 4, d = 3, h = 2.5;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(box(0.16, h, 0.16), wood, { at: [sx * w / 2, h / 2, sz * d / 2] });
  for (const sz of [-1, 1]) b.add(box(w + 0.6, 0.16, 0.16), wood, { at: [0, h, sz * d / 2] });
  for (let x = -w / 2; x <= w / 2; x += 0.5) b.add(box(0.08, 0.1, d + 0.5), wood, { at: [x, h + 0.12, 0] });
  return [-1, 1].flatMap(sx => [-1, 1].map(sz => ({ shape: 'box', size: [0.2, h, 0.2], at: [sx * w / 2, h / 2, sz * d / 2] })));
}

function buildLounger({ b, r }) {                             // espreguiçadeira
  const cloth = ['#3b5b8c', '#ddd', '#8c3b3b'][Math.floor(r() * 3)];
  b.add(box(0.7, 0.08, 1.2), cloth, { at: [0, 0.3, 0.3] });
  b.add(box(0.7, 0.08, 0.8), cloth, { at: [0, 0.65, -0.45], rot: [-0.9, 0, 0] });
  for (const s of [-1, 1]) b.add(box(0.05, 0.3, 1.3), '#555', { at: [s * 0.33, 0.15, 0.2] });
  return [{ shape: 'box', size: [0.75, 0.6, 2.0], at: [0, 0.3, 0] }];
}

function buildUmbrella({ b, r }) {                           // guarda-sol de praia (mastro + copa listrada)
  const c1 = ['#e04a3a', '#2f8fd6', '#f2b233', '#1fa37a'][Math.floor(r() * 4)];
  b.add(cyl(0.03, 0.03, 2.2, 6), '#e8e8e8', { at: [0, 1.1, 0] });
  b.add(new THREE.ConeGeometry(1.3, 0.5, 8), c1, { at: [0, 2.3, 0] });
  b.add(new THREE.ConeGeometry(0.12, 0.2, 6), '#ffffff', { at: [0, 2.55, 0] });
  return [{ shape: 'cyl', r: 0.4, h: 2.2, at: [0, 1.1, 0] }];
}

function buildBoat({ b, r }) {                               // barco de pesca varado na areia
  const L = lerp(3.6, 4.6, r()), W = lerp(1.4, 1.7, r());
  const hull = jitterColor('#2f6fb0', r, 0.08);
  b.add(box(W, 0.55, L * 0.8), hull, { at: [0, 0.35, 0] });
  b.add(new THREE.ConeGeometry(W / 2, L * 0.2, 4), hull, { at: [0, 0.35, L * 0.5 + L * 0.1], rot: [Math.PI / 2, Math.PI / 4, 0] });
  b.add(box(W * 0.9, 0.12, L * 0.82), '#f2efe6', { at: [0, 0.66, 0] });                    // convés
  b.add(box(W * 0.7, 0.7, 0.9), '#f2efe6', { at: [0, 1.0, -L * 0.15] });                   // cabine
  b.add(box(W * 0.74, 0.22, 0.95), GLASS, { at: [0, 1.15, -L * 0.15] });
  return [{ shape: 'box', size: [W, 1.4, L], at: [0, 0.7, 0] }];
}

function buildBeachHut({ b, r, pal }) {                      // quiosque de praia com telhado de palha
  const w = lerp(3.4, 4.2, r()), d = lerp(3, 3.8, r()), h = 2.4;
  b.add(box(w, h, d), jitterColor('#c9a77a', r, 0.06), { at: [0, h / 2, 0] });
  b.add(prism(w + 1.0, 1.6, d + 1.0), jitterColor('#b88a4a', r, 0.06), { at: [0, h, 0] });  // palha
  b.add(box(0.9, 1.9, 0.08), WOOD_DARK, { at: [0, 0.95, d / 2 + 0.03] });                    // porta
  b.add(box(w * 0.5, 0.9, 0.08), '#ffffff', { at: [0, 1.55, d / 2 + 0.03] });               // balcão branco
  return [{ shape: 'box', size: [w, h + 0.8, d], at: [0, (h + 0.8) / 2, 0] }];
}

function buildLifering({ b }) {                              // boia salva-vidas presa num poste
  b.add(cyl(0.05, 0.05, 1.5, 6), '#8a8a8a', { at: [0, 0.75, 0] });
  const ring = new THREE.TorusGeometry(0.32, 0.1, 6, 12);
  b.add(ring, '#e8402a', { at: [0, 1.2, 0.12], rot: [0, 0, 0] });
  return [{ shape: 'cyl', r: 0.15, h: 1.5, at: [0, 0.75, 0] }];
}

// ---- objetos de interior ------------------------------------------------------------------------
const FABRIC = ['#8c7f72', '#c9b79c', '#5b6670', '#a6523b', '#7a8b6f'];

function buildSofa({ b, r }) {                               // sofá de 2 lugares com encosto e braços
  const c = FABRIC[Math.floor(r() * FABRIC.length)], w = lerp(2.0, 2.4, r()), d = 0.95;
  b.add(box(w, 0.42, d), c, { at: [0, 0.32, 0] });                                         // assento
  b.add(box(w, 0.5, 0.22), c, { at: [0, 0.7, -d / 2 + 0.11] });                             // encosto
  for (const s of [-1, 1]) b.add(box(0.2, 0.3, d), c, { at: [s * (w / 2 - 0.1), 0.6, 0] }); // braços
  b.add(box(w * 0.95, 0.12, d * 0.95), dark(c, 0.8), { at: [0, 0.08, 0] });                 // pé/base
  return [{ shape: 'box', size: [w, 0.9, d], at: [0, 0.45, 0] }];
}

function buildArmchair({ b, r }) {
  const c = FABRIC[Math.floor(r() * FABRIC.length)], w = 0.95, d = 0.9;
  b.add(box(w, 0.4, d), c, { at: [0, 0.3, 0] });
  b.add(box(w, 0.55, 0.2), c, { at: [0, 0.68, -d / 2 + 0.1] });
  for (const s of [-1, 1]) b.add(box(0.16, 0.28, d), c, { at: [s * (w / 2 - 0.08), 0.56, 0] });
  return [{ shape: 'box', size: [w, 0.85, d], at: [0, 0.42, 0] }];
}

function buildCoffee({ b, r }) {                             // mesa de centro redonda
  const wood = jitterColor('#6b4a2e', r, 0.08);
  b.add(cyl(0.55, 0.55, 0.05, 16), wood, { at: [0, 0.42, 0] });
  b.add(cyl(0.05, 0.05, 0.4, 6), '#2f2f2f', { at: [0, 0.2, 0] });
  return [{ shape: 'cyl', r: 0.55, h: 0.45, at: [0, 0.22, 0] }];
}

function buildRug({ b, r }) {                                // tapete baixo (sem colisor: dá para pisar)
  const c = FABRIC[Math.floor(r() * FABRIC.length)];
  b.add(box(2.2, 0.02, 1.6), dark(c, 1.1), { at: [0, 0.01, 0] });
  return [];
}

function buildFloorLamp({ b }) {                             // luminária de piso com cúpula
  b.add(cyl(0.2, 0.22, 0.05, 10), '#2f3237', { at: [0, 0.025, 0] });
  b.add(cyl(0.03, 0.03, 1.6, 6), '#3b3f45', { at: [0, 0.85, 0] });
  b.add(new THREE.ConeGeometry(0.35, 0.35, 10, 1, true), '#f1ead8', { at: [0, 1.7, 0], rot: [Math.PI, 0, 0] });
  return [{ shape: 'cyl', r: 0.2, h: 1.7, at: [0, 0.85, 0] }];
}

function buildShelf({ b, r, pal }) {                         // estante de madeira com 3 prateleiras
  const wood = jitterColor(pal.trunk, r, 0.08), w = 1.8, h = 2.0, d = 0.4;
  b.add(box(w, h, 0.05), wood, { at: [0, h / 2, -d / 2] });                                 // fundo
  for (const s of [-1, 1]) b.add(box(0.05, h, d), wood, { at: [s * w / 2, h / 2, 0] });     // laterais
  for (let y = 0.05; y <= h; y += h / 3) b.add(box(w, 0.05, d), wood, { at: [0, y, 0] });   // prateleiras
  return [{ shape: 'box', size: [w, h, d], at: [0, h / 2, 0] }];
}

function buildIndoorPlant({ b, r }) {                        // vaso com planta de interior
  b.add(cyl(0.2, 0.16, 0.4, 10), '#b5654a', { at: [0, 0.2, 0] });
  const n = 5 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + r() * 0.5, rad = lerp(0.3, 0.45, r());
    b.add(ico(rad * 0.5, 1), jitterColor('#3f8a4a', r, 0.1),
      { at: [Math.cos(a) * 0.22, 0.55 + r() * 0.35, Math.sin(a) * 0.22], scale: [1.3, 0.5, 1] });
  }
  return [{ shape: 'cyl', r: 0.22, h: 0.4, at: [0, 0.2, 0] }];
}

function buildRowHouse({ b, r, pal }) {                       // casinha de loteamento: gabled, faixa colorida na frente
  const w = lerp(5.5, 6.5, r()), d = lerp(7, 8.5, r()), h = lerp(2.5, 2.8, r()), roofH = lerp(1.3, 1.7, r());
  const stripe = ['#58b947', '#f0cf3b', '#ef7d2e', '#2f6fc4'][Math.floor(r() * 4)];
  b.add(box(w, h, d), '#e9e7e2', { at: [0, h / 2, 0] });
  b.add(prism(w + 0.8, roofH, d + 0.8), '#c9704a', { at: [0, h, 0] });                 // telha cerâmica
  b.add(box(1.1, h, 0.1), stripe, { at: [-w * 0.2, h / 2, d / 2 + 0.03] });
  b.add(box(0.9, 2.0, 0.08), '#6d7178', { at: [w * 0.15, 1.0, d / 2 + 0.04] });
  b.add(box(0.8, 0.9, 0.08), '#6d7178', { at: [-w * 0.2, h * 0.6, d / 2 + 0.06] });
  return [{ shape: 'box', size: [w, h + roofH * 0.6, d], at: [0, (h + roofH * 0.6) / 2, 0] }];
}

function buildPole({ b }) {                                   // poste de concreto com cruzeta
  b.add(cyl(0.12, 0.16, 8, 8), '#a8a8a2', { at: [0, 4, 0] });
  b.add(box(1.6, 0.1, 0.1), '#4a4a4a', { at: [0, 7.6, 0] });
  return [{ shape: 'cyl', r: 0.2, h: 8, at: [0, 4, 0] }];
}

export const TYPES = {
  tree:     { label: 'Árvore',    build: buildTree },
  pine:     { label: 'Pinheiro',  build: buildPine },
  bush:     { label: 'Arbusto',   build: buildBush },
  house:    { label: 'Casa',      build: buildHouse },
  barn:     { label: 'Celeiro',   build: buildBarn },
  bench:    { label: 'Banco',     build: buildBench },
  lamp:     { label: 'Poste',     build: buildLamp },
  rock:     { label: 'Pedra',     build: buildRock },
  fence:    { label: 'Cerca',     build: buildFence },
  building: { label: 'Prédio',    build: buildBuilding },
  car:      { label: 'Carro',     build: buildCar },
  hedge:    { label: 'Sebe',      build: buildHedge },
  palm:     { label: 'Palmeira',  build: buildPalm },
  cabin:    { label: 'Cabana',          build: buildCabin },
  hut:      { label: 'Refúgio A-frame', build: buildHut },
  snowpine: { label: 'Pinheiro nevado', build: buildSnowPine },
  snowman:  { label: 'Boneco de neve',  build: buildSnowman },
  cairn:    { label: 'Marco de pedras', build: buildCairn },
  banana:   { label: 'Bananeira',       build: buildBanana },
  pool:     { label: 'Piscina',         build: buildPool },
  pergola:  { label: 'Pérgola',         build: buildPergola },
  lounger:  { label: 'Espreguiçadeira', build: buildLounger },
  sofa:     { label: 'Sofá',            build: buildSofa },
  armchair: { label: 'Poltrona',        build: buildArmchair },
  coffee:   { label: 'Mesa de centro',  build: buildCoffee },
  rug:      { label: 'Tapete',          build: buildRug },
  floorlamp:{ label: 'Luminária de piso', build: buildFloorLamp },
  shelf:    { label: 'Estante',         build: buildShelf },
  indoorplant: { label: 'Planta de interior', build: buildIndoorPlant },
  umbrella: { label: 'Guarda-sol',      build: buildUmbrella },
  boat:     { label: 'Barco',           build: buildBoat },
  beachhut: { label: 'Quiosque de praia', build: buildBeachHut },
  lifering: { label: 'Boia salva-vidas', build: buildLifering },
  rowhouse: { label: 'Casa de loteamento', build: buildRowHouse },
  pole:     { label: 'Poste de concreto',  build: buildPole },
};

// Monta o objeto (sem posição). `matFor(hex)` devolve o material compartilhado dessa cor.
export function buildObject(type, seed, palette, matFor) {
  const def = TYPES[type] || TYPES.tree;
  const b = new Builder();
  const specs = def.build({ b, r: rng(seed), pal: palette });
  const group = b.build(matFor);
  const box3 = new THREE.Box3().setFromObject(group);
  return { group, specs, localBox: { min: box3.min.toArray(), max: box3.max.toArray() } };
}

// Espalha elementos ao redor do ponto de início. Determinístico: mesma semente, mesmo resultado.
// Mantém livre o corredor entre o personagem e a foto, para ela continuar visível.
// context: 'rural' | 'urban' | 'beach' | 'snow' | 'alpine' | 'tropical' | 'suburban' | 'indoor' | 'cave' | 'forest' | 'mixed' — vem de meta.context do servidor
export function scatter(S, seed = 1, context = 'rural') {
  const r = rng(seed * 7919 + 13);
  const list = [];
  const R = S.env.radius;
  const photoHalf = S.relief.enabled ? reliefWidthM(S.relief) / 2 : 0;
  const spawn = S.spawn;
  const make = (type, x, z, rotY, scale = 1) => list.push({
    id: S.nextId++, type, x: +x.toFixed(2), z: +z.toFixed(2), lift: 0, rotY: Math.round(rotY),
    scale: +scale.toFixed(2), seed: Math.floor(r() * 99999) + 1, collider: 'auto',
  });
  const tooClose = (x, z, d) => list.some(o => Math.hypot(o.x - x, o.z - z) < d);
  const inCorridor = (x, z) => z < spawn[2] - 10 && Math.abs(x) < Math.min(photoHalf, 18) * 0.7 && z > -S.relief.distance - 6;
  const place = (type, count, rMin, rMax, gap, { scaleMin = 0.9, scaleMax = 1.25, face = false } = {}) => {
    for (let n = 0, tries = 0; n < count && tries < count * 40; tries++) {
      const a = r() * TAU, d = lerp(rMin, rMax, Math.sqrt(r()));
      const x = Math.cos(a) * d, z = Math.sin(a) * d + spawn[2] * 0.4;
      if (Math.hypot(x - spawn[0], z - spawn[2]) < 5 || tooClose(x, z, gap) || inCorridor(x, z)) continue;
      const toSpawn = Math.atan2(spawn[0] - x, spawn[2] - z) * 180 / Math.PI;
      make(type, x, z, face ? toSpawn + (r() - 0.5) * 30 : r() * 360, lerp(scaleMin, scaleMax, r()));
      n++;
    }
  };

  if (context === 'urban') {
    // Cidade/calçada: prédios, carros, postes, sebes — sem casas de campo nem celeiros
    place('building', 3, 24, Math.min(R - 12, 48), 22, { scaleMin: 0.85, scaleMax: 1.2, face: true });
    place('car',      5, 14, R - 10, 7,  { scaleMin: 1,   scaleMax: 1 });
    place('lamp',     7, 10, R - 8,  7,  { scaleMin: 1,   scaleMax: 1 });
    place('bench',    4, 6,  15,     5,  { scaleMin: 1,   scaleMax: 1,  face: true });
    place('hedge',    8, 6,  R - 8,  3.5,{ scaleMin: 0.8, scaleMax: 1.4 });
    place('tree',     6, 10, R - 8,  5);
    place('rock',     3, 10, R - 12, 5,  { scaleMin: 0.6, scaleMax: 1.2 });
    place('fence',    2, 14, 30,     10, { scaleMin: 1,   scaleMax: 1 });

  } else if (context === 'beach') {
    // Praia: palmeiras, guarda-sóis, espreguiçadeiras, quiosque, barco varado, boias e rochas. Sem celeiro.
    place('palm',      5, 14, R - 8,  7);
    place('rock',      10, 6, R - 8, 4,   { scaleMin: 0.5, scaleMax: 2.2 });
    place('umbrella',  4, 9, 22,     5,   { scaleMin: 0.9, scaleMax: 1.1 });
    place('lounger',   4, 8, 20,     3,   { scaleMin: 1,   scaleMax: 1, face: true });
    place('beachhut',  1, 20, Math.min(R - 12, 40), 16, { scaleMin: 1, scaleMax: 1.1, face: true });
    place('boat',      1, 22, Math.min(R - 12, 40), 14, { scaleMin: 1, scaleMax: 1.1, face: true });
    place('lifering',  1, 8, 16,     6,   { scaleMin: 1,   scaleMax: 1 });
    place('bench',     2, 8, 16,     7,   { scaleMin: 1,   scaleMax: 1, face: true });
    place('lamp',      2, 10, 20,    9,   { scaleMin: 1,   scaleMax: 1 });
    place('bush',      5, 6,  R - 12, 4,  { scaleMin: 0.7, scaleMax: 1.3 });
    place('tree',      3, 18, R - 8,  7);

  } else if (context === 'cave') {
    // Caverna/gruta: blocos de rocha, pilares de pedra (marcos), poucas luzes de trilha. Sem árvores.
    place('rock',  14, 4, R - 6, 3.5, { scaleMin: 0.8, scaleMax: 2.6 });
    place('cairn', 4, 6, 14,     5,   { scaleMin: 1, scaleMax: 1.5 });
    place('lamp',  2, 6, 14,     8,   { scaleMin: 1, scaleMax: 1 });

  } else if (context === 'forest') {
    // Floresta com trilha de terra ou passarela de madeira: árvores altas, pinheiros, arbustos, pedras e cercas.
    place('tree',  12, 10, R - 8, 5);
    place('pine',   8, 12, R - 8, 4.5);
    place('bush',  12, 5,  R - 10, 3, { scaleMin: 0.8, scaleMax: 1.6 });
    place('rock',   5, 8,  R - 10, 4,  { scaleMin: 0.6, scaleMax: 1.6 });
    place('fence',  2, 10, 26,     8,  { scaleMin: 1, scaleMax: 1 });
    place('bench',  1, 8,  14,     6,  { scaleMin: 1, scaleMax: 1, face: true });

  } else if (context === 'indoor') {
    // Ambiente interno (sala/ateliê): sofá, mesa de centro, poltrona, vaso, luminária, estante. Espaço pequeno.
    place('sofa',      2, 3.5, 6.5, 2.5, { scaleMin: 1, scaleMax: 1, face: true });
    place('armchair',  2, 3,   6,   2,   { scaleMin: 1, scaleMax: 1, face: true });
    place('coffee',    1, 2.5, 4,   2,   { scaleMin: 1, scaleMax: 1 });
    place('rug',       1, 1.5, 3,   2,   { scaleMin: 1, scaleMax: 1 });
    place('floorlamp', 2, 3,   6,   2,   { scaleMin: 1, scaleMax: 1 });
    place('shelf',     1, 6,   9,   3,   { scaleMin: 1, scaleMax: 1, face: true });
    place('indoorplant', 3, 2.5, 7, 1.5, { scaleMin: 0.9, scaleMax: 1.2 });

  } else if (context === 'snow') {
    // Neve: cabanas de tronco, pinheiros nevados, bonecos de neve, cercas
    place('cabin',    2, 20, Math.min(R - 12, 44), 16, { scaleMin: 1, scaleMax: 1.15, face: true });
    place('snowpine', 16, 10, R - 8, 4.5);
    place('snowman',  2, 6, 16, 6,  { scaleMin: 0.9, scaleMax: 1.2, face: true });
    place('rock',     6, 8, R - 8, 4, { scaleMin: 0.5, scaleMax: 1.6 });
    place('fence',    4, 12, 30, 8, { scaleMin: 1, scaleMax: 1 });
    place('bench',    1, 8, 14, 6,  { scaleMin: 1, scaleMax: 1, face: true });
    place('lamp',     2, 8, 18, 8,  { scaleMin: 1, scaleMax: 1 });

  } else if (context === 'alpine') {
    // Alpino/rochoso: refúgio A-frame, pedregulhos grandes, marcos de pedra, poucos pinheiros
    place('hut',    1, 18, Math.min(R - 12, 40), 18, { scaleMin: 1, scaleMax: 1.1, face: true });
    place('rock',   16, 6, R - 8, 4, { scaleMin: 1.0, scaleMax: 3.2 });
    place('cairn',  4, 8, R - 10, 8, { scaleMin: 1, scaleMax: 1.4 });
    place('pine',   6, 14, R - 8, 6);
    place('bush',   5, 7, R - 10, 4, { scaleMin: 0.5, scaleMax: 0.9 });
    place('bench',  1, 8, 12, 6, { scaleMin: 1, scaleMax: 1, face: true });

  } else if (context === 'tropical') {
    // Tropical/casa de lazer: casa, piscina, pérgola, espreguiçadeiras, palmeiras e bananeiras
    place('house',   1, 22, Math.min(R - 12, 40), 18, { scaleMin: 1.1, scaleMax: 1.25, face: true });
    place('pool',    1, 9, 16, 10, { scaleMin: 1, scaleMax: 1.15, face: true });
    place('pergola', 1, 10, 18, 9, { scaleMin: 1, scaleMax: 1.1, face: true });
    place('lounger', 3, 7, 14, 3,  { scaleMin: 1, scaleMax: 1, face: true });
    place('palm',    6, 12, R - 8, 6);
    place('banana',  6, 8, R - 8, 4);
    place('tree',    10, 12, R - 8, 6);
    place('bush',    8, 6, R - 10, 3, { scaleMin: 0.8, scaleMax: 1.4 });

  } else if (context === 'suburban') {
    // Suburbano/loteamento: fileira de casinhas, poste de concreto, sebes, carros, árvores pequenas
    place('rowhouse', 6, 16, Math.min(R - 10, 44), 9, { scaleMin: 1, scaleMax: 1.1, face: true });
    place('pole',     5, 8, R - 8, 12, { scaleMin: 1, scaleMax: 1 });
    place('car',      3, 12, R - 10, 8, { scaleMin: 1, scaleMax: 1 });
    place('hedge',    6, 6, R - 8, 4,  { scaleMin: 0.8, scaleMax: 1.3 });
    place('tree',     6, 10, R - 8, 6, { scaleMin: 0.7, scaleMax: 1.0 });
    place('palm',     4, 16, R - 8, 8);
    place('fence',    3, 10, 28, 8,   { scaleMin: 1, scaleMax: 1 });
    place('bench',    1, 6, 12, 6,    { scaleMin: 1, scaleMax: 1, face: true });

  } else {
    // 'rural' | 'mixed': comportamento original (campo, fazenda, jardim)
    place('house',  2, 22, Math.min(R - 12, 44), 16, { scaleMin: 1,   scaleMax: 1.15, face: true });
    place('barn',   1, 26, Math.min(R - 12, 46), 18, { scaleMin: 1,   scaleMax: 1.1,  face: true });
    place('tree',  14, 10, R - 8, 5);
    place('pine',   8, 14, R - 8, 4.5);
    place('bush',   8, 7,  R - 10, 3,  { scaleMin: 0.8, scaleMax: 1.3 });
    place('rock',   6, 8,  R - 10, 4,  { scaleMin: 0.7, scaleMax: 1.5 });
    place('bench',  2, 6,  10,     5,  { scaleMin: 1,   scaleMax: 1, face: true });
    place('lamp',   2, 6,  11,     6,  { scaleMin: 1,   scaleMax: 1 });
    place('fence',  3, 12, 28,     8,  { scaleMin: 1,   scaleMax: 1 });
  }
  return list;
}

