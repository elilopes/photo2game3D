// Elementos do ambiente construídos a partir dos assets extraídos da foto (piso e árvores).
//
// buildSquareFloor(floorTex, widthM, depthM, squareSize)
//   Plano horizontal texturizado com o ladrilho retificado do chão da foto.
//
// buildWalls(squareSize)
//   Quatro paredes invisíveis nas bordas do quadrado (colisor de caixa, H=8 m).
//   O personagem não cai do mapa; paredes NÃO aparecem no teste nem no export visual.
//
// buildTrees(treeList, squareSize)
//   Painéis cruzados (X-billboard) com textura RGBA de cada árvore, distribuídos ao longo do perímetro.

import * as THREE from 'three';

const WALL_H = 12;    // altura das paredes invisíveis (m)
const WALL_T = 0.5;   // espessura (m) — só afeta o colisor

// ---- Piso retificado -----------------------------------------------------------------------------
export function buildSquareFloor(floorTex, widthM, depthM, squareSize = 60) {
  const tex = floorTex.clone ? floorTex.clone() : floorTex;
  // Uma amostra de chão deve ser usada uma única vez, nunca ladrilhada pelo mapa.
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(1, 1);
  tex.needsUpdate = true;
  tex.anisotropy = 8;

  const geo = new THREE.PlaneGeometry(squareSize, squareSize, 1, 1);
  const mat = new THREE.MeshStandardMaterial({
    map: tex, roughness: 0.88, metalness: 0, name: 'piso_foto',
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'piso_foto';
  mesh.rotation.x = -Math.PI / 2;    // deitado na horizontal
  mesh.receiveShadow = true;
  return mesh;
}

// ---- Paredes invisíveis --------------------------------------------------------------------------
export function buildWalls(squareSize = 60) {
  const walls = new THREE.Group();
  walls.name = 'paredes';
  const half = squareSize / 2;

  // Norte / Sul: estendem em X; Leste / Oeste: estendem em Z (usamos rotY = 90°)
  const geoH = new THREE.BoxGeometry(squareSize + WALL_T, WALL_H, WALL_T);
  const geoV = new THREE.BoxGeometry(WALL_T, WALL_H, squareSize + WALL_T);

  const configs = [
    { geo: geoH, x: 0,     z: -half },   // norte (direção da foto)
    { geo: geoH, x: 0,     z:  half },   // sul
    { geo: geoV, x: -half, z:  0    },   // oeste
    { geo: geoV, x:  half, z:  0    },   // leste
  ];

  const mat = new THREE.MeshBasicMaterial({ visible: false });
  for (const c of configs) {
    const mesh = new THREE.Mesh(c.geo, mat);
    // Centro da parede em y = WALL_H/2 - 2 → parede começa em y=-2 (embaixo do chão)
    // e termina em y=WALL_H-2. Elimina o gap entre o piso e a parede.
    mesh.position.set(c.x, WALL_H / 2 - 2, c.z);
    mesh.name = 'parede';
    // userData.wallCollider marcado para facilitar filtros futuros
    mesh.userData.wallCollider = true;
    walls.add(mesh);
  }
  return walls;
}

// ---- Árvores billboard ---------------------------------------------------------------------------
// "Star-billboard": 4 quads a cada 45°. Parece volumoso de qualquer ângulo horizontal,
// sem o aspecto "plano" do X-billboard de 2 planos.
function buildBillboard(url, widthM, heightM) {
  const tex = new THREE.TextureLoader().load(url);
  tex.colorSpace = THREE.SRGBColorSpace;

  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, alphaTest: 0.32,
    side: THREE.DoubleSide, fog: true, depthWrite: false,
  });
  mat.userData.sharedMaterial = true;

  const geo = new THREE.PlaneGeometry(widthM, heightM);
  const group = new THREE.Group();

  // 4 planos a 0°, 45°, 90°, 135° — cobre todos os ângulos horizontais
  for (let i = 0; i < 4; i++) {
    const p = new THREE.Mesh(geo, mat);
    p.rotation.y = (i / 4) * Math.PI;
    p.castShadow = true;
    p.userData.sharedMaterial = true;
    p.userData.noCollider = true;
    group.add(p);
  }
  return group;
}

// Distribui `count` posições uniformemente ao longo do perímetro do quadrado, com margem interior.
export function layoutTrees(count, squareSize = 60, margin = 5) {
  const half = squareSize / 2 - margin;
  if (half <= 0 || count <= 0) return [];
  const perimeter = 8 * half;
  const step = perimeter / count;
  const positions = [];

  for (let i = 0; i < count; i++) {
    let d = i * step;
    let x, z;
    if (d < 2 * half) {                     // borda norte (z = −half)
      x = -half + d; z = -half;
    } else if (d < 4 * half) {              // borda leste
      d -= 2 * half; x = half; z = -half + d;
    } else if (d < 6 * half) {              // borda sul
      d -= 4 * half; x = half - d; z = half;
    } else {                                // borda oeste
      d -= 6 * half; x = -half; z = half - d;
    }
    positions.push({ x, z });
  }
  return positions;
}

// treeList: [{ url, width_m, height_m }, ...]
// Repete a lista se precisar de mais posições do que há árvores distintas.
export function fitGeneratedModel(model, widthM, heightM) {
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  if (size.x <= 0 || size.y <= 0 || size.z <= 0) return;
  model.position.sub(center);
  model.scale.set(widthM / size.x, heightM / size.y, widthM / size.z);
  model.updateMatrixWorld(true);
  const fitted = new THREE.Box3().setFromObject(model);
  model.position.y -= fitted.min.y;
}

// treeList: [{ url, model, width_m, height_m, x_m, z_m }, ...]
export function buildTrees(treeList, squareSize = 60) {
  const group = new THREE.Group();
  group.name = 'arvores_foto';
  if (!treeList || treeList.length === 0) return group;
  const positions = layoutTrees(treeList.length, squareSize, 1);

  for (let i = 0; i < treeList.length; i++) {
    const info = treeList[i];
    const pos = Number.isFinite(info.x_m) && Number.isFinite(info.z_m) ? info : positions[i];
    if (info.model) {
      // Clona a hierarquia sem duplicar buffers: _squareAssets conserva o original
      // para que o palco possa reconstruir a área sem reutilizar geometrias descartadas.
      const model = info.model.clone(true);
      model.name = `arvore_instantmesh_${i}`;
      fitGeneratedModel(model, info.width_m, info.height_m);
      model.position.x += pos.x_m ?? pos.x;
      model.position.z += pos.z_m ?? pos.z;
      model.traverse(o => {
        o.userData.sharedAsset = true;
        if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
      });
      group.add(model);
    } else if (info.url) {
      const bb = buildBillboard(info.url, info.width_m, info.height_m);
      bb.position.set(pos.x_m ?? pos.x, info.height_m / 2, pos.z_m ?? pos.z);
      group.add(bb);
    }
  }
  return group;
}
