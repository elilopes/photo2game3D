import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RAPIER } from './physics.js';
import { clamp, smoothstep } from './util.js';

const BASE_HEIGHT = 1.8;
const CAP_HALF = 0.6, CAP_R = 0.3;          // cápsula: 1,8 m no total
const FOOT = CAP_HALF + CAP_R;              // centro da cápsula a 0,9 m dos pés
const FADE = 0.15;                          // tempo de transição entre animações (s)

// ---------------------------------------------------------------------------------------------
// Esqueleto (mesmos nomes no viewer, no GLB, no FBX e no .blend). "L" = esquerda do personagem (+X).
// ---------------------------------------------------------------------------------------------
export const BONES = ['hips', 'spine', 'head',
  'arm_up_L', 'arm_lo_L', 'arm_up_R', 'arm_lo_R',
  'leg_up_L', 'leg_lo_L', 'leg_up_R', 'leg_lo_R'];

// posição de cada articulação na pose de repouso (personagem de frente para +Z, pés em y = 0)
const JOINT = {
  hips: [0, 0.95, 0], spine: [0, 1.05, 0], head: [0, 1.50, 0],
  arm_up_L: [0.26, 1.45, 0], arm_lo_L: [0.26, 1.12, 0], arm_up_R: [-0.26, 1.45, 0], arm_lo_R: [-0.26, 1.12, 0],
  leg_up_L: [0.11, 0.95, 0], leg_lo_L: [0.11, 0.50, 0], leg_up_R: [-0.11, 0.95, 0], leg_lo_R: [-0.11, 0.50, 0],
};
const PARENT = {
  hips: null, spine: 'hips', head: 'spine',
  arm_up_L: 'spine', arm_lo_L: 'arm_up_L', arm_up_R: 'spine', arm_lo_R: 'arm_up_R',
  leg_up_L: 'hips', leg_lo_L: 'leg_up_L', leg_up_R: 'hips', leg_lo_R: 'leg_up_R',
};

const MAT_NAMES = ['camisa', 'pele', 'calca', 'sapatos', 'cabelo'];
const M = { shirt: 0, skin: 1, pants: 2, shoes: 3, hair: 4 };

function buildRig(colors) {
  const mats = ['shirt', 'skin', 'pants', 'shoes', 'hair'].map((k, i) => {
    const m = new THREE.MeshStandardMaterial({ color: colors[k], roughness: 0.8, metalness: 0 });
    m.name = MAT_NAMES[i];
    return m;
  });

  const idx = Object.fromEntries(BONES.map((b, i) => [b, i]));
  const byMat = mats.map(() => []);
  const part = (geo, mat, bone, at, rot) => {
    if (rot) geo.rotateX(rot);
    geo.translate(at[0], at[1], at[2]);
    const n = geo.attributes.position.count;
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { si[i * 4] = idx[bone]; sw[i * 4] = 1; }   // cada peça segue 100% um osso
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    byMat[mat].push(geo);
  };
  const caps = (r, len) => new THREE.CapsuleGeometry(r, len, 4, 10);

  part(new THREE.BoxGeometry(0.34, 0.16, 0.20), M.pants, 'hips', [0, 0.97, 0]);
  part(new THREE.BoxGeometry(0.42, 0.52, 0.22), M.shirt, 'spine', [0, 1.24, 0]);
  part(new THREE.CylinderGeometry(0.05, 0.055, 0.09, 10), M.skin, 'head', [0, 1.53, 0]);
  part(new THREE.SphereGeometry(0.125, 20, 14), M.skin, 'head', [0, 1.65, 0]);
  part(new THREE.SphereGeometry(0.133, 20, 10, 0, Math.PI * 2, 0, 1.35), M.hair, 'head', [0, 1.655, -0.004]);
  for (const s of [1, -1]) {
    part(new THREE.SphereGeometry(0.016, 8, 6), M.shoes, 'head', [0.045 * s, 1.665, 0.112]);   // olhos: mostram para onde ele olha
  }
  for (const [side, s] of [['L', 1], ['R', -1]]) {
    part(caps(0.05, 0.23), M.shirt, `arm_up_${side}`, [0.27 * s, 1.285, 0]);
    part(caps(0.045, 0.22), M.skin, `arm_lo_${side}`, [0.27 * s, 0.96, 0]);
    part(new THREE.SphereGeometry(0.052, 10, 8), M.skin, `arm_lo_${side}`, [0.27 * s, 0.79, 0]);
    part(caps(0.085, 0.28), M.pants, `leg_up_${side}`, [0.11 * s, 0.725, 0]);
    part(caps(0.065, 0.31), M.pants, `leg_lo_${side}`, [0.11 * s, 0.28, 0]);
    part(new THREE.BoxGeometry(0.11, 0.07, 0.26), M.shoes, `leg_lo_${side}`, [0.11 * s, 0.035, 0.05]);
  }

  const geo = mergeGeometries(byMat.map(list => mergeGeometries(list, false)), true);
  const mesh = new THREE.SkinnedMesh(geo, mats);
  mesh.name = 'PersonagemMalha';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;

  const bones = BONES.map(name => {
    const b = new THREE.Bone();
    b.name = name;
    const p = PARENT[name], j = JOINT[name];
    b.position.set(...(p ? j.map((v, i) => v - JOINT[p][i]) : j));
    return b;
  });
  BONES.forEach((name, i) => (PARENT[name] ? bones[idx[PARENT[name]]] : mesh).add(bones[i]));

  const root = new THREE.Group();
  root.name = 'Personagem';
  root.add(mesh);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);     // calcula as matrizes inversas da pose de repouso
  mesh.bind(skeleton);
  return { root, mesh, skeleton, mats };
}

// ---------------------------------------------------------------------------------------------
// Animações. Rotação em X: para membros que pendem para baixo, valor NEGATIVO = para a frente;
// para o que aponta para cima (coluna, cabeça), POSITIVO = inclina para a frente.
// ---------------------------------------------------------------------------------------------
const TAU = Math.PI * 2;

const poseIdle = u => {
  const s = Math.sin(TAU * u);
  return { hipsY: 0.004 * s, spine: 0.012 * s, head: -0.006 * s,
    arm_up_L: 0.03 * s, arm_up_R: -0.03 * s, arm_lo_L: -0.12, arm_lo_R: -0.12 };
};

const walkPose = ({ legA, knee, armA, elbow, lean, bob }) => u => {
  const s = Math.sin(TAU * u), c = Math.cos(TAU * u);
  return {
    hipsY: bob * Math.cos(2 * TAU * u),
    spine: lean, head: -lean * 0.6,
    leg_up_L: legA * s, leg_lo_L: knee * Math.max(0, -c),       // joelho dobra quando a perna vai à frente
    leg_up_R: -legA * s, leg_lo_R: knee * Math.max(0, c),
    arm_up_L: -armA * s, arm_up_R: armA * s, arm_lo_L: -elbow, arm_lo_R: -elbow,
  };
};

const lerpPose = (a, b, t) => {
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = (a[k] || 0) + ((b[k] || 0) - (a[k] || 0)) * t;
  return out;
};
const keyed = frames => u => {
  for (let i = 0; i < frames.length - 1; i++) {
    const [u0, p0] = frames[i], [u1, p1] = frames[i + 1];
    if (u <= u1) return lerpPose(p0, p1, smoothstep(u0, u1, u));
  }
  return frames[frames.length - 1][1];
};
const sym = (o) => ({ ...o, leg_up_L: o.thigh, leg_up_R: o.thigh, leg_lo_L: o.shin, leg_lo_R: o.shin,
  arm_up_L: o.arm, arm_up_R: o.arm, arm_lo_L: o.elbow, arm_lo_R: o.elbow });

const poseJump = keyed([
  [0.00, sym({ thigh: -0.10, shin: 0.15, arm: -0.40, elbow: -0.20, spine: 0.00, hipsY: 0 })],
  [0.18, sym({ thigh: -0.20, shin: 0.30, arm: -2.40, elbow: -0.20, spine: 0.05, hipsY: 0 })],
  [0.50, sym({ thigh: -0.90, shin: 1.30, arm: -2.70, elbow: -0.50, spine: 0.10, hipsY: 0 })],
  [0.85, sym({ thigh: -0.40, shin: 0.35, arm: -1.50, elbow: -0.20, spine: 0.00, hipsY: 0 })],
  [1.00, sym({ thigh: -0.30, shin: 0.30, arm: -1.00, elbow: -0.20, spine: 0.00, hipsY: 0 })],
]);

const poseLand = keyed([
  [0.00, sym({ thigh: -0.30, shin: 0.30, arm: -1.00, elbow: -0.20, spine: 0.00, hipsY: 0 })],
  [0.35, sym({ thigh: -0.85, shin: 1.45, arm: -0.50, elbow: -0.50, spine: 0.22, hipsY: -0.19 })],
  [1.00, sym({ thigh: 0, shin: 0, arm: 0, elbow: -0.12, spine: 0, hipsY: 0 })],
]);

function makeClip(name, duration, poseFn, fps = 30) {
  const n = Math.max(2, Math.round(duration * fps));
  const times = [], rot = Object.fromEntries(BONES.map(b => [b, []])), hips = [];
  const q = new THREE.Quaternion(), ax = new THREE.Vector3(1, 0, 0);
  for (let i = 0; i <= n; i++) {
    const u = i / n, p = poseFn(u >= 1 ? 1 : u);
    times.push(u * duration);
    for (const b of BONES) { q.setFromAxisAngle(ax, p[b] || 0); rot[b].push(q.x, q.y, q.z, q.w); }
    hips.push(JOINT.hips[0], JOINT.hips[1] + (p.hipsY || 0), JOINT.hips[2]);
  }
  const tracks = BONES.map(b => new THREE.QuaternionKeyframeTrack(`${b}.quaternion`, times, rot[b]));
  tracks.push(new THREE.VectorKeyframeTrack('hips.position', times, hips));
  return new THREE.AnimationClip(name, duration, tracks);
}

export function buildClips() {
  return {
    Parado: makeClip('Parado', 3.0, poseIdle),
    Andar: makeClip('Andar', 0.8, walkPose({ legA: 0.60, knee: 0.95, armA: 0.50, elbow: 0.35, lean: 0.03, bob: 0.025 })),
    Correr: makeClip('Correr', 0.55, walkPose({ legA: 0.95, knee: 1.55, armA: 0.95, elbow: 1.30, lean: 0.20, bob: 0.05 })),
    Pular: makeClip('Pular', 0.8, poseJump),
    Aterrissar: makeClip('Aterrissar', 0.35, poseLand),
  };
}

const WALK_BASE = 3, RUN_BASE = 6;      // velocidades em que os clipes Andar/Correr foram feitos

// ---------------------------------------------------------------------------------------------
export class Character {
  constructor(rworld, cfg) {
    this.rworld = rworld;
    this.cfg = { ...cfg };
    this.scale = 1;
    this.vy = 0;
    this.grounded = false;
    this.airTime = 0;
    this.moving = false;
    this.running = false;
    this.facing = 0;
    this.speedXZ = 0;

    this.body = rworld.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 5, 0));
    this.collider = null;
    this.ctrl = rworld.createCharacterController(0.02);
    this.ctrl.setUp({ x: 0, y: 1, z: 0 });
    this.ctrl.setMaxSlopeClimbAngle(50 * Math.PI / 180);
    this.ctrl.setMinSlopeSlideAngle(60 * Math.PI / 180);
    this.ctrl.setSlideEnabled(true);
    this.prev = { x: 0, y: 5, z: 0 };
    this.curr = { x: 0, y: 5, z: 0 };

    const rig = buildRig(cfg);
    this.root = rig.root; this.mesh = rig.mesh; this.skeleton = rig.skeleton; this.mats = rig.mats;
    this.clipMap = buildClips();
    this.clips = Object.values(this.clipMap);
    this.mixer = new THREE.AnimationMixer(this.root);
    this.actions = {};
    for (const [name, clip] of Object.entries(this.clipMap)) this.actions[name] = this.mixer.clipAction(clip);
    for (const n of ['Pular', 'Aterrissar']) { this.actions[n].setLoop(THREE.LoopOnce, 1); this.actions[n].clampWhenFinished = true; }
    this.state = null;
    this.landTimer = 0;
    this.applyConfig(cfg, true);
  }

  // Aplica altura, velocidades, pulo, gravidade e cores vindas do estado do projeto.
  applyConfig(cfg, force = false) {
    this.cfg = { ...cfg };
    const scale = clamp(cfg.height / BASE_HEIGHT, 0.4, 3);
    if (force || Math.abs(scale - this.scale) > 1e-4 || !this.collider) {
      const c = this.centerNow();
      const feetY = c.y - FOOT * this.scale;
      this.scale = scale;
      if (this.collider) this.rworld.removeCollider(this.collider, true);
      this.collider = this.rworld.createCollider(RAPIER.ColliderDesc.capsule(CAP_HALF * scale, CAP_R * scale), this.body);
      this.ctrl.enableAutostep(0.35 * scale, 0.2 * scale, true);
      this.ctrl.enableSnapToGround(0.3 * scale);
      this.root.scale.setScalar(scale);
      this.setFeet({ x: c.x, y: feetY, z: c.z });
    }
    this.jumpSpeed = Math.sqrt(2 * cfg.gravity * cfg.jumpHeight);
    this.mats.forEach((m, i) => m.color.set(cfg[['shirt', 'skin', 'pants', 'shoes', 'hair'][i]]));
  }

  centerNow() { return this.body.translation(); }

  setFeet(f) {
    const c = { x: f.x, y: f.y + FOOT * this.scale, z: f.z };
    this.body.setTranslation(c, true);
    this.prev = { ...c }; this.curr = { ...c };
  }

  feet() {
    const c = this.curr;
    return { x: c.x, y: c.y - FOOT * this.scale, z: c.z };
  }

  // feet = ponto no chão; yaw = direção do olhar da câmera (graus). O personagem nasce de costas para a câmera.
  reset(feet, yawDeg = 0) {
    this.setFeet(feet);
    this.vy = 0; this.airTime = 0; this.grounded = false; this.landTimer = 0;
    this.facing = THREE.MathUtils.degToRad(yawDeg) + Math.PI;
    this.root.rotation.y = this.facing;
    this.state = null;
  }

  // Passo de física a 60 Hz.
  step(dt, cmd, camYaw) {
    const sinY = Math.sin(camYaw), cosY = Math.cos(camYaw);
    let dx = cosY * cmd.x - sinY * cmd.z;
    let dz = -sinY * cmd.x - cosY * cmd.z;
    const len = Math.hypot(dx, dz);
    this.moving = len > 0.01;
    this.running = cmd.run;
    if (this.moving) { dx /= len; dz /= len; this.facing = Math.atan2(dx, dz); }
    const speed = (cmd.run ? this.cfg.runSpeed : this.cfg.walkSpeed) * this.scale;

    if (cmd.jump && this.grounded) { this.vy = this.jumpSpeed; this.grounded = false; }
    this.vy = this.grounded && this.vy <= 0 ? -2 : this.vy - this.cfg.gravity * dt;

    const want = { x: this.moving ? dx * speed * dt : 0, y: this.vy * dt, z: this.moving ? dz * speed * dt : 0 };
    this.ctrl.computeColliderMovement(this.collider, want);
    const m = this.ctrl.computedMovement();
    if (want.y > 0 && m.y < want.y - 1e-4) this.vy = 0;       // bateu a cabeça
    this.grounded = this.ctrl.computedGrounded();
    if (this.grounded && this.vy < 0) this.vy = 0;

    const p = this.body.translation();
    this.prev = this.curr;
    this.curr = { x: p.x + m.x, y: p.y + m.y, z: p.z + m.z };
    this.body.setNextKinematicTranslation(this.curr);
    this.speedXZ = this.moving ? speed / this.scale : 0;
  }

  center(alpha, out = new THREE.Vector3()) {
    return out.set(
      this.prev.x + (this.curr.x - this.prev.x) * alpha,
      this.prev.y + (this.curr.y - this.prev.y) * alpha,
      this.prev.z + (this.curr.z - this.prev.z) * alpha);
  }

  // A cada frame de render: posição interpolada + animação.
  render(alpha, dt) {
    const c = this.center(alpha);
    this.root.position.set(c.x, c.y - FOOT * this.scale, c.z);
    const d = Math.atan2(Math.sin(this.facing - this.root.rotation.y), Math.cos(this.facing - this.root.rotation.y));
    this.root.rotation.y += d * (1 - Math.exp(-dt * 12));
    this.animate(dt);
    this.mixer.update(dt);
  }

  animate(dt) {
    // só considera "no ar" depois de 80 ms sem chão (evita piscar em degraus e rampas)
    this.airTime = this.grounded ? 0 : this.airTime + dt;
    const air = this.airTime > 0.08;
    let want;
    if (air) want = 'Pular';
    else if (this.state === 'Pular' && this.grounded) { want = 'Aterrissar'; this.landTimer = 0.35; }
    else if (this.state === 'Aterrissar' && this.landTimer > 0 && !this.moving) { want = 'Aterrissar'; this.landTimer -= dt; }
    else want = this.moving ? (this.running ? 'Correr' : 'Andar') : 'Parado';

    if (want !== this.state) {
      const next = this.actions[want];
      next.reset().play();
      if (this.state) this.actions[this.state].crossFadeTo(next, FADE, false);
      else next.fadeIn(0);
      this.state = want;
    }
    const a = this.actions[this.state];
    if (this.state === 'Andar') a.timeScale = clamp(this.cfg.walkSpeed / WALK_BASE, 0.4, 2.5);
    else if (this.state === 'Correr') a.timeScale = clamp(this.cfg.runSpeed / RUN_BASE, 0.4, 2.5);
    else if (this.state === 'Pular') a.timeScale = clamp(0.8 / Math.max(0.3, 2 * this.jumpSpeed / this.cfg.gravity), 0.4, 3);
    else a.timeScale = 1;
  }

  // Coloca o personagem na pose de repouso, no ponto inicial, para exportar. Devolve a função que desfaz.
  prepareExport(feet, yawDeg) {
    const saved = { pos: this.root.position.clone(), rot: this.root.rotation.y };
    this.mixer.stopAllAction();
    this.skeleton.pose();
    this.root.position.set(feet.x, feet.y, feet.z);
    this.root.rotation.y = THREE.MathUtils.degToRad(yawDeg) + Math.PI;
    this.root.updateMatrixWorld(true);
    return () => {
      this.root.position.copy(saved.pos);
      this.root.rotation.y = saved.rot;
      this.state = null;                       // a próxima animação recomeça do estado certo
      this.root.updateMatrixWorld(true);
    };
  }
}
