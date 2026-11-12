import * as THREE from 'three';
import { addMeshColliders, addObjectColliders, removeColliders, boxSpec } from './physics.js';
import { EYE_HEIGHT, makeHeightFn, buildTerrain, buildHills, buildSky, sunDirection, reliefWidthM } from './terrain.js';
import { buildObject } from './library.js';
import { rng } from './util.js';
import { buildSquareFloor, buildWalls, buildTrees } from './photo_props.js';

const J = JSON.stringify;
const pick = (o, keys) => J(keys.map(k => o[k]));

function disposeTree(root) {
  root.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material && !o.userData.sharedMaterial) {
      for (const m of [].concat(o.material)) { m.map?.dispose(); m.dispose(); }
    }
  });
}

// Textura neutra de grama/terra (multiplica a cor do chão) que repete sem emendas visíveis.
function makeGroundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#e4e4e4';
  g.fillRect(0, 0, 256, 256);
  const r = rng(7);
  for (let i = 0; i < 2600; i++) {
    const x = r() * 256, y = r() * 256, s = 1 + r() * 2.5, v = 150 + Math.floor(r() * 105);
    g.fillStyle = `rgba(${v},${v},${v},0.45)`;
    for (const dx of [-256, 0, 256]) for (const dy of [-256, 0, 256]) g.fillRect(x + dx, y + dy, s, s * 1.8);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.name = 'textura_chao';
  return t;
}

// O "palco": tudo o que existe no mundo (céu, luz, chão, colinas, foto, objetos) montado A PARTIR do estado do
// projeto. sync(S) compara com o que já está montado e refaz só o que mudou — por isso desfazer/refazer,
// ajustes e reabrir o projeto passam todos pelo mesmo caminho.
export class Stage {
  constructor(scene, rworld) {
    this.scene = scene;
    this.rworld = rworld;
    this.S = null;
    this.heightFn = () => 0;
    this.sig = {};
    this.mats = new Map();
    this.objs = new Map();
    this.cols = { terrain: [], relief: [], external: [], walls: [] };
    this.pending = { terrain: false, relief: false, external: false, walls: false, objs: new Set() };
    this.nodes = { sky: null, terrain: null, hills: null, external: null, square: null, treesPhoto: null };
    this.relief = null;                 // { group, visual, proxy, info }
    this.showColliders = false;
    this._tex = null;
    this.panorama = null;               // THREE.Texture equirretangular (ou null)
    this._squareAssets = null;          // último set de assets da foto (floorTex, trees…)

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x556677, 1);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 260 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.05;
    this.objectsGroup = new THREE.Group();
    this.objectsGroup.name = 'objetos';
    scene.add(this.hemi, this.sun, this.sun.target, this.objectsGroup);
  }

  get groundTexture() { return (this._tex ||= makeGroundTexture()); }
  heightAt(x, z) { return this.heightFn(x, z); }

  mat(hex) {
    if (!this.mats.has(hex)) {
      this.mats.set(hex, new THREE.MeshStandardMaterial({ color: '#' + hex, roughness: 0.92, metalness: 0, name: 'cor_' + hex }));
    }
    return this.mats.get(hex);
  }

  // ---- foto (relevo) -------------------------------------------------------------------------
  setReliefAsset(gltfScene, info) {
    if (this.relief) { this.relief.group.removeFromParent(); this.relief.group.traverse(o => o.geometry?.dispose()); this.relief = null; }
    if (!gltfScene) { this.sig.relief = null; return; }
    const visual = gltfScene.getObjectByName('relevo'), proxy = gltfScene.getObjectByName('relevo_col');
    if (!visual || !proxy) throw new Error('O GLB da foto não tem os nós "relevo" e "relevo_col".');
    const lit = visual.material;
    lit.fog = false;
    const unlit = new THREE.MeshBasicMaterial({ map: lit.map, side: THREE.DoubleSide, fog: false, name: 'foto' });
    visual.userData.mats = { lit, unlit };
    visual.castShadow = false;
    visual.receiveShadow = true;
    visual.userData.noCollider = true;
    proxy.visible = false;
    const group = new THREE.Group();
    group.name = 'foto';
    group.visible = false;   // invisível por padrão; _placeRelief mostra se rel.enabled=true
    group.add(visual, proxy);
    this.scene.add(group);
    this.relief = { group, visual, proxy, info };
    this.sig.relief = null;
  }

  // Panorama 360° da foto (ou null). Força a reconstrução do céu no próximo sync().
  setPanorama(tex) {
    this.panorama = tex || null;
    this.sig.sky = null;
  }

  setExternal(root) {
    if (this.nodes.external) { this.nodes.external.removeFromParent(); disposeTree(this.nodes.external); }
    removeColliders(this.rworld, this.cols.external);
    this.nodes.external = root;
    if (root) {
      root.name = root.name || 'cenario_externo';
      root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.scene.add(root);
    }
    this.pending.external = true;
    this.commitColliders();
  }

  // assets = { floorTex, widthM, depthM, squareSize, trees } | null (limpa o modo quadrado)
  // floorTex: THREE.Texture já carregada
  // trees: [ { url, width_m, height_m } ]
  setSquare(assets) {
    // Guarda o último conjunto não-nulo para poder reconstruir ao mudar squareSize/square pelo painel
    if (assets) this._squareAssets = assets;
    // Remove piso e árvores antigos
    if (this.nodes.square) { this.nodes.square.removeFromParent(); disposeTree(this.nodes.square); this.nodes.square = null; }
    if (this.nodes.treesPhoto) { this.nodes.treesPhoto.removeFromParent(); disposeTree(this.nodes.treesPhoto); this.nodes.treesPhoto = null; }
    removeColliders(this.rworld, this.cols.walls);
    this.cols.walls = [];
    removeColliders(this.rworld, this.cols.square || []);
    this.cols.square = [];

    if (!assets) return;

    const sz = assets.squareSize || 60;

    // Piso retificado
    this.nodes.square = buildSquareFloor(assets.floorTex, assets.widthM, assets.depthM, sz);
    this.scene.add(this.nodes.square);
    // Colisor do piso: sem ele o personagem atravessa o chão e cai no loop de respawn
    this.nodes.square.updateWorldMatrix(true, true);
    this.cols.square = addMeshColliders(this.rworld, this.nodes.square);
    this.pending.walls = true;   // força um step em commitColliders() para o Rapier enxergar o piso

    // Paredes invisíveis (colisores)
    const walls = buildWalls(sz);
    walls.name = 'paredes_colisor';
    this.scene.add(walls);
    // guardamos na nodes para exportNodes ignorar (paredes são só colisão)
    this.nodes.wallsNode = walls;
    this.pending.walls = true;

    // Árvores
    if (assets.trees && assets.trees.length > 0) {
      this.nodes.treesPhoto = buildTrees(assets.trees, sz);
      this.scene.add(this.nodes.treesPhoto);
    }

    this.commitColliders();
  }

  // Casa da foto como volume 3D: a face da frente é o recorte real; o resto é uma caixa de cor neutra.
  // info = { url, width_m, height_m, dist, x_m } | null. Fica na posição da câmera da foto (origem).
  setHouse(info) {
    removeColliders(this.rworld, this.cols.house || []);
    this.cols.house = [];
    if (this.nodes.house) { this.nodes.house.removeFromParent(); disposeTree(this.nodes.house); this.nodes.house = null; }
    if (!info) return;

    const depth = 6;
    const tex = new THREE.TextureLoader().load(info.url);
    tex.colorSpace = THREE.SRGBColorSpace;
    const front = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.32, transparent: true, roughness: 0.9 });
    const side = new THREE.MeshStandardMaterial({ color: 0xc9a58a, roughness: 0.9 });
    const mats = [side, side, side, side, front, side];   // ordem: +x, -x, +y, -y, +z (frente), -z
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(info.width_m, info.height_m, depth), mats);
    mesh.name = 'casa_foto';
    mesh.position.set(info.x_m, info.height_m / 2, -info.dist - depth / 2);   // face da frente voltada para a câmera
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const group = new THREE.Group();
    group.name = 'casa_foto';
    group.add(mesh);
    this.scene.add(group);
    this.nodes.house = group;

    group.updateWorldMatrix(true, true);
    this.cols.house = addMeshColliders(this.rworld, group);
    this.pending.walls = true;   // força o step em commitColliders()
    this.commitColliders();
  }

  // Reconstrói o piso/árvores quando env.square ou env.squareSize mudam pelo painel.
  _rebuildSquare(env) {
    if (!this._squareAssets) return; // sem foto carregada, ignora
    const assets = env.square
      ? { ...this._squareAssets, squareSize: env.squareSize || this._squareAssets.squareSize }
      : null;
    this.setSquare(assets);
  }

  // ---- sincronização -------------------------------------------------------------------------
  // live = true: só o visual (arrastar um controle). Os colisores são refeitos em commitColliders().
  sync(S, live = false) {
    this.S = S;
    const env = S.env, rel = S.relief;
    const sig = {
      sky: pick(env, ['skyTop', 'skyHorizon', 'sunAzimuth', 'sunElevation']),
      light: pick(env, ['sunIntensity', 'ambient', 'shadows', 'fogFar', 'skyHorizon']),
      height: pick(env, ['terrain', 'terrainBump', 'radius', 'seed']) + pick(rel, ['enabled', 'distance', 'fov']) + !!this.relief,
      ground: pick(env, ['ground', 'groundColor', 'groundTexture', 'textureTile']),
      hills: pick(env, ['hills', 'hillHeight', 'hillColor', 'radius', 'groundColor', 'skyHorizon', 'seed']),
      relief: J(rel) + (this.relief ? 1 : 0),
      palette: J(S.palette),
      square: pick(env, ['square', 'squareSize']),
    };
    const old = this.sig;
    const changed = k => old[k] !== sig[k];

    if (changed('sky')) this._rebuildSky(env);
    if (changed('light') || changed('sky')) this._applyLight(env);
    if (changed('height') || changed('ground')) this._rebuildTerrain(S);
    if (changed('hills')) this._rebuildHills(env);
    if (changed('relief') || changed('height')) this._placeRelief(S);
    if (changed('palette')) { this.mats.forEach(m => m.dispose()); this.mats.clear(); }
    if (changed('square')) this._rebuildSquare(env);
    this.sig = sig;
    this._syncObjects(S, sig.palette + sig.height);
    if (!live) this.commitColliders();
  }

  _rebuildSky(env) {
    if (this.nodes.sky) { this.nodes.sky.removeFromParent(); disposeTree(this.nodes.sky); }
    this.nodes.sky = buildSky(env, this.panorama);
    this.scene.add(this.nodes.sky);
  }

  _applyLight(env) {
    this.scene.background = new THREE.Color(env.skyHorizon);
    this.scene.fog = new THREE.Fog(env.skyHorizon, env.fogFar * 0.3, env.fogFar);
    this.hemi.intensity = env.ambient;
    this.hemi.color.set(env.skyTop).lerp(new THREE.Color('#ffffff'), 0.6);
    this.hemi.groundColor.set(env.groundColor).multiplyScalar(0.6);
    this.sun.intensity = env.sunIntensity;
    this.sun.castShadow = !!env.shadows;
  }

  _rebuildTerrain(S) {
    const env = S.env;
    this.heightFn = makeHeightFn(env, S.relief, !!this.relief);
    if (this.nodes.terrain) { this.nodes.terrain.removeFromParent(); disposeTree(this.nodes.terrain); this.nodes.terrain = null; }
    if (env.ground !== false) {
      this.nodes.terrain = buildTerrain(env, this.heightFn, this.groundTexture);
      this.nodes.terrain.userData.sharedMaterial = false;
      this.scene.add(this.nodes.terrain);
    }
    this.pending.terrain = true;
  }

  _rebuildHills(env) {
    if (this.nodes.hills) { this.nodes.hills.removeFromParent(); disposeTree(this.nodes.hills); this.nodes.hills = null; }
    if (env.hills) {
      this.nodes.hills = buildHills(env);
      this.scene.add(this.nodes.hills);
    }
  }

  // Posiciona a foto: largura pelo campo de visão, linha do horizonte da foto na altura dos olhos.
  _placeRelief(S) {
    const R = this.relief;
    if (!R) return;
    const rel = S.relief, info = R.info;
    const k = reliefWidthM(rel) / info.width_m;
    const kz = rel.depth / info.depth_m;
    R.group.scale.set(k, k, Math.max(kz, 0.001));
    R.group.position.set(0, EYE_HEIGHT - (1 - rel.horizon) * info.height_m * k + rel.offsetY, -rel.distance);
    R.group.rotation.y = THREE.MathUtils.degToRad(rel.rotY);
    R.group.visible = !!rel.enabled;
    R.visual.material = rel.lit ? R.visual.userData.mats.lit : R.visual.userData.mats.unlit;
    R.group.updateWorldMatrix(true, true);
    this.pending.relief = true;
  }

  _syncObjects(S, ctxSig) {
    const seen = new Set();
    for (const o of S.objects) {
      seen.add(o.id);
      const sig = J(o) + ctxSig;
      const cur = this.objs.get(o.id);
      if (cur && cur.sig === sig) continue;
      if (cur) this._disposeObject(cur);
      this.objs.set(o.id, this._buildEntry(o, S, sig));
      this.pending.objs.add(o.id);
    }
    for (const [id, e] of this.objs) {
      if (!seen.has(id)) { this._disposeObject(e); this.objs.delete(id); }
    }
  }

  _buildEntry(o, S, sig) {
    const { group, specs, localBox } = buildObject(o.type, o.seed, S.palette, hex => this.mat(hex));
    group.name = `${o.type}_${o.id}`;
    group.userData.p2g = { id: o.id, type: o.type, collider: o.collider };
    for (const m of group.children) m.userData.sharedMaterial = true;
    group.position.set(o.x, this.heightFn(o.x, o.z) + (o.lift || 0), o.z);
    group.rotation.y = THREE.MathUtils.degToRad(o.rotY || 0);
    group.scale.setScalar(o.scale || 1);

    const wires = this._wires(specs, localBox, o.collider);
    for (const w of wires) { w.visible = this.showColliders; group.add(w); }
    this.objectsGroup.add(group);
    group.updateWorldMatrix(true, true);
    return { id: o.id, o, sig, group, specs, localBox, colliders: [] };
  }

  _wires(specs, localBox, mode) {
    if (mode === 'none') return [];
    const mk = (geo, at, color) => {
      const w = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 15),
        new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
      w.position.set(...at);
      w.renderOrder = 10;
      w.userData.debug = true;
      w.userData.noCollider = true;
      geo.dispose();
      return w;
    };
    const list = mode === 'box' ? [boxSpec(localBox)] : specs;
    const out = [];
    for (const sp of list) {
      if (sp.shape === 'box') out.push(mk(new THREE.BoxGeometry(...sp.size), sp.at, 0xff3b30));
      else if (sp.shape === 'cyl') out.push(mk(new THREE.CylinderGeometry(sp.r, sp.r, sp.h, 14), sp.at, 0xff3b30));
    }
    if (mode === 'mesh' || list.some(s => s.shape === 'hull')) {
      const b = boxSpec(localBox);
      out.push(mk(new THREE.BoxGeometry(...b.size), b.at, 0xff9f0a));
    }
    return out;
  }

  _disposeObject(e) {
    removeColliders(this.rworld, e.colliders);
    e.group.removeFromParent();
    e.group.traverse(o => o.geometry?.dispose());
    e.group.traverse(o => { if (o.userData.debug) o.material.dispose(); });
    this.pending.objs.delete(e.id);
  }

  // ---- colisores -----------------------------------------------------------------------------
  commitColliders() {
    const p = this.pending, S = this.S;
    let touched = false;
    if (p.terrain) {
      removeColliders(this.rworld, this.cols.terrain);
      if (this.nodes.terrain) this.cols.terrain = addMeshColliders(this.rworld, this.nodes.terrain);
      p.terrain = false; touched = true;
    }
    if (p.relief) {
      removeColliders(this.rworld, this.cols.relief);
      if (this.relief && S?.relief.enabled && S.relief.collider) {
        this.relief.group.updateWorldMatrix(true, true);
        this.cols.relief = addMeshColliders(this.rworld, this.relief.proxy);
      }
      p.relief = false; touched = true;
    }
    if (p.external) {
      removeColliders(this.rworld, this.cols.external);
      if (this.nodes.external) this.cols.external = addMeshColliders(this.rworld, this.nodes.external);
      p.external = false; touched = true;
    }
    if (p.walls) {
      removeColliders(this.rworld, this.cols.walls);
      if (this.nodes.wallsNode) this.cols.walls = addMeshColliders(this.rworld, this.nodes.wallsNode);
      p.walls = false; touched = true;
    }
    for (const id of p.objs) {
      const e = this.objs.get(id);
      if (!e) continue;
      removeColliders(this.rworld, e.colliders);
      e.colliders = addObjectColliders(this.rworld, e.group, e.o.collider, e.specs, e.localBox);
      touched = true;
    }
    p.objs.clear();
    if (touched) this.rworld.step();      // o Rapier só enxerga colisores novos nas consultas depois de um step
  }

  setShowColliders(v) {
    this.showColliders = v;
    this.objectsGroup.traverse(o => { if (o.userData.debug) o.visible = v; });
  }

  objectGroup(id) { return this.objs.get(id)?.group || null; }

  // ---- por quadro e exportação ---------------------------------------------------------------
  update(focus) {
    if (!this.S) return;
    const d = sunDirection(this.S.env);
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(d, 110);
    this.sun.target.updateMatrixWorld();
  }

  // Nós VIVOS que viram o arquivo 3D. As paredes invisíveis e as linhas de depuração ficam de fora.
  exportNodes() {
    const n = this.nodes;
    // n.wallsNode fica de fora (só colisão); piso e árvores da foto entram
    return [n.sky, n.terrain, n.hills, n.square, n.treesPhoto,
            this.relief?.group, this.objectsGroup, n.external].filter(Boolean);
  }
}

