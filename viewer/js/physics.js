import * as THREE from 'three';
import RAPIER from 'rapier';

export { RAPIER };

export async function createPhysics() {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 60;
  return world;
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

// Colisores trimesh a partir da geometria REAL (com as transformações já aplicadas): o que o
// personagem encosta é exatamente o que aparece. Malhas com userData.noCollider são ignoradas.
export function addMeshColliders(world, root, filter = null) {
  root.updateWorldMatrix(true, true);   // inclui os pais: a malha pode estar dentro de um grupo escalado
  const handles = [];
  root.traverse(obj => {
    if (!obj.isMesh || obj.userData.noCollider || (filter && !filter(obj))) return;
    const pos = obj.geometry.attributes.position;
    const verts = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
      verts[i * 3] = _v.x; verts[i * 3 + 1] = _v.y; verts[i * 3 + 2] = _v.z;
    }
    const index = obj.geometry.index
      ? Uint32Array.from(obj.geometry.index.array)
      : Uint32Array.from({ length: pos.count }, (_, i) => i);
    handles.push(world.createCollider(RAPIER.ColliderDesc.trimesh(verts, index).setFriction(0.8)));
  });
  return handles;
}

// Colisores simples de um objeto da biblioteca. `specs` estão no espaço local do objeto
// (antes da escala/rotação); aqui viram formas do Rapier já no espaço do mundo.
//   mode: 'auto' (formas da biblioteca) | 'box' (caixa do objeto inteiro) | 'mesh' (malha exata) | 'none'
export function addObjectColliders(world, group, mode, specs, localBox) {
  group.updateWorldMatrix(true, true);
  if (mode === 'none') return [];
  if (mode === 'mesh') return addMeshColliders(world, group);

  const s = group.scale.x;
  group.getWorldQuaternion(_q);
  const list = mode === 'box' ? [boxSpec(localBox)] : specs;
  const handles = [];

  for (const sp of list) {
    let desc = null;
    if (sp.shape === 'box') {
      desc = RAPIER.ColliderDesc.cuboid(sp.size[0] / 2 * s, sp.size[1] / 2 * s, sp.size[2] / 2 * s);
    } else if (sp.shape === 'cyl') {
      desc = RAPIER.ColliderDesc.cylinder(sp.h / 2 * s, sp.r * s);
    } else if (sp.shape === 'hull') {
      const pts = [];
      group.traverse(m => {
        if (!m.isMesh || m.userData.debug) return;
        const p = m.geometry.attributes.position;
        for (let i = 0; i < p.count; i++) {
          _v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
          pts.push(_v.x, _v.y, _v.z);
        }
      });
      desc = RAPIER.ColliderDesc.convexHull(new Float32Array(pts));
      if (desc) handles.push(world.createCollider(desc.setFriction(0.8)));
      continue;
    }
    if (!desc) continue;
    _v.set(sp.at[0], sp.at[1], sp.at[2]).applyMatrix4(group.matrixWorld);
    desc.setTranslation(_v.x, _v.y, _v.z).setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }).setFriction(0.8);
    handles.push(world.createCollider(desc));
  }
  return handles;
}

export function boxSpec(box) {
  return {
    shape: 'box',
    size: [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]],
    at: [(box.max[0] + box.min[0]) / 2, (box.max[1] + box.min[1]) / 2, (box.max[2] + box.min[2]) / 2],
  };
}

export function removeColliders(world, handles) {
  for (const c of handles) world.removeCollider(c, true);
  handles.length = 0;
}

// Altura do que existe abaixo de (x, z), olhando de cima. null se não houver nada.
export function groundY(world, x, z, exclude, fromY = 400) {
  const ray = new RAPIER.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 });
  const hit = world.castRay(ray, fromY * 2, true, undefined, undefined, exclude);
  return hit ? fromY - hit.toi : null;   // Rapier 0.12 devolve `toi` (não `timeOfImpact`)
}

