// Estado do projeto = ÚNICA fonte da verdade. Tudo o que aparece no teste ao vivo é montado
// a partir dele, e o arquivo 3D é exportado da própria cena ao vivo (mesmos objetos, mesmos dados).
// É JSON puro: serve para salvar (scene.json), desfazer/refazer e reabrir o projeto.

export const defaultEnv = () => ({
  ground: true,           // mostra o chão procedural (desligado ao abrir um GLB que já tem chão)
  terrain: true,
  skyTop: '#4a86c9', skyHorizon: '#bcd4e6',
  groundColor: '#7a9a5a', groundTexture: true, textureTile: 6,
  hills: true, hillHeight: 14, hillColor: '#6f8a62',
  terrainBump: 0.5, radius: 60, seed: 1,
  fogFar: 170,
  sunAzimuth: 40, sunElevation: 48, sunIntensity: 2.6, ambient: 1.1, shadows: true,
  // chão quadrado (ativado quando a foto tem chão detectado)
  square: false, squareSize: 60,
});

export const defaultRelief = () => ({
  enabled: true, distance: 40, fov: 55, depth: 8, horizon: 0.5,
  offsetY: 0, rotY: 0, collider: true, lit: false,
});

export const defaultCharacter = () => ({
  height: 1.8, walkSpeed: 3, runSpeed: 6, jumpHeight: 1.2, gravity: 22,
  shirt: '#3b6fd8', pants: '#2f3a52', skin: '#e0b28a', hair: '#3a2a1c', shoes: '#222222',
  cameraDistance: 5,
});

export const defaultPalette = () => ({
  foliage: '#4f8f3a', trunk: '#6b4a2f', building: '#d9cbb0', roof: '#8a3b2a',
});

export function newState(suggest = {}) {
  const env = defaultEnv();
  for (const k of ['skyTop', 'skyHorizon', 'groundColor', 'hillColor']) if (suggest[k]) env[k] = suggest[k];
  const palette = defaultPalette();
  for (const k of ['foliage', 'building', 'roof']) if (suggest[k]) palette[k] = suggest[k];
  return {
    version: 1, nextId: 1, env, palette,
    relief: defaultRelief(), character: defaultCharacter(),
    spawn: [0, 0, 6], spawnYaw: 0,
    objects: [],
  };
}

// Completa com padrões o que faltar (projetos salvos em versões antigas)
export function migrate(s) {
  const base = newState();
  const out = { ...base, ...s };
  out.env = { ...base.env, ...(s.env || {}) };
  out.relief = { ...base.relief, ...(s.relief || {}) };
  out.character = { ...base.character, ...(s.character || {}) };
  out.palette = { ...base.palette, ...(s.palette || {}) };
  out.objects = Array.isArray(s.objects) ? s.objects : [];
  return out;
}

export class History {
  constructor(limit = 100) { this.limit = limit; this.stack = []; this.i = -1; }
  reset(json) { this.stack = [json]; this.i = 0; }
  commit(json) {
    if (this.stack[this.i] === json) return false;
    this.stack.length = this.i + 1;
    this.stack.push(json);
    if (this.stack.length > this.limit) this.stack.shift();
    this.i = this.stack.length - 1;
    return true;
  }
  get canUndo() { return this.i > 0; }
  get canRedo() { return this.i < this.stack.length - 1; }
  undo() { return this.canUndo ? this.stack[--this.i] : null; }
  redo() { return this.canRedo ? this.stack[++this.i] : null; }
}

