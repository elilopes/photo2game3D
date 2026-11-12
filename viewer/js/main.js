// Ponto de entrada do viewer.
//
// Fluxo: foto -> /api/generate (relevo + sugestão de cores) -> o ambiente aparece no teste ao vivo ->
// o usuário anda, pula e ajusta no painel -> "Exportar" monta o GLB a partir da CENA AO VIVO e manda para
// /api/export, que converte para FBX, OBJ e .blend. Teste e arquivo saem do mesmo estado (S).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createPhysics, groundY, RAPIER } from './physics.js';
import { Character } from './character.js';
import { Input } from './input.js';
import { Stage } from './stage.js';
import { newState, migrate, History } from './state.js';
import { scatter } from './library.js';
import { mountPanel } from './panel.js';
import { clamp } from './util.js';

const $ = id => document.getElementById(id);
const $status = $('status'), $warn = $('warn'), $fps = $('fps'), $links = $('links'), $photoName = $('photo-name');
const $photo = $('photo'), $glb = $('glb');
const $modeTest = $('mode-test'), $modeEdit = $('mode-edit');

const FIXED = 1 / 60;               // passo de física (s)
const SCENE_SAVE_DELAY = 400;       // ms

// ---------- estado global ----------------------------------------------------------------------
let S = newState();                 // única fonte da verdade do projeto
let pid = null;                     // id do projeto no servidor ('novo' = GLB de teste ainda não exportado)
let mode = 'test';                  // 'test' | 'edit'
const hist = new History();

// ---------- renderer, cena, câmera ------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 700);
const gltfLoader = new GLTFLoader();

// ---------- física, palco, personagem, entrada -----------------------------------------------
const world = await createPhysics();
const stage = new Stage(scene, world);
const input = new Input(renderer.domElement);
const character = new Character(world, S.character);
scene.add(character.root);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enabled = false;
orbit.enableDamping = true;

// ---------- painel de ajustes ------------------------------------------------------------------
const panel = mountPanel({
  getS: () => S,
  commit: (next, { live }) => apply(next, live),
  history: hist,
  stage,
  onExport: () => exportScene(),
});

// Aplica uma versão do estado no palco e no personagem. live = só visual (arrastando um controle).
function apply(next, live = false) {
  S = next;
  stage.sync(S, live);
  character.applyConfig(S.character);
  if (!live) queueSave();
}

// Troca de projeto: monta tudo, zera o histórico e posiciona o personagem.
function setProject(next, id) {
  pid = id;
  S = next;
  stage.sync(S, false);
  character.applyConfig(S.character);
  resetCharacter();
  hist.reset(JSON.stringify(S));
  panel.render();
  queueSave();
}

function resetCharacter() {
  const x = S.spawn[0], z = S.spawn[2];
  const y = groundY(world, x, z, character.collider) ?? 0;
  character.reset({ x, y, z }, S.spawnYaw || 0);
}

// ---------- salvar (scene.json) ----------------------------------------------------------------
let saveTimer = 0;
function queueSave() {
  clearTimeout(saveTimer);
  if (!pid || pid === 'novo') return;
  saveTimer = setTimeout(() => {
    fetch(`/api/scene/${pid}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(S),
    }).catch(() => setStatus('Não consegui salvar os ajustes (servidor offline?).'));
  }, SCENE_SAVE_DELAY);
}

// ---------- utilidades de interface ------------------------------------------------------------
function setStatus(text) { $status.textContent = text; }
function setWarn(list = []) { $warn.innerHTML = list.map(t => `<div>⚠ ${t}</div>`).join(''); }

function replaceUrl(id) {
  window.history.replaceState(null, '', `?projeto=${id}`);
}

async function api(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    const text = await r.text();
    let msg = text;
    try { msg = JSON.parse(text).error || text; } catch { /* não era JSON */ }
    throw new Error(msg);
  }
  return r.json();
}

async function guard(fn) {
  try { await fn(); }
  catch (e) { setStatus('Erro: ' + e.message); }
}

// ---------- carregamento -----------------------------------------------------------------------
// Relevo da foto: GLB com os nós "relevo" (visual) e "relevo_col" (colisão).
async function loadRelief(url, info) {
  if (!info) throw new Error('Projeto sem informações do relevo (meta.json).');
  stage.setExternal(null);
  const gltf = await gltfLoader.loadAsync(url);
  stage.setReliefAsset(gltf.scene, info);
}

// Panorama 360° gerado pelo servidor (panorama.jpg). Sem ele, o céu usa o degradê de cores.
async function loadPanorama(url) {
  if (!url) { stage.setPanorama(null); return; }
  const tex = await new THREE.TextureLoader().loadAsync(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  stage.setPanorama(tex);
}

// Piso retificado + árvores extraídas da foto. Chama setSquare() no stage.
// meta.floor  = { url, width_m, depth_m }  (só presente se a foto tem chão)
// meta.trees  = [ { url, width_m, height_m }, ... ] (pode ser [] ou ausente)
async function loadPhotoAssets(meta, squareSize = 60) {
  if (!meta?.floor) {
    // Sem chão detectado: limpa qualquer piso anterior
    stage.setSquare(null);
    return;
  }
  const loader = new THREE.TextureLoader();
  const floorTex = await loader.loadAsync(meta.floor.url);
  floorTex.colorSpace = THREE.SRGBColorSpace;
  const trees = meta.trees || [];
  stage.setSquare({
    floorTex,
    widthM: meta.floor.width_m,
    depthM: meta.floor.depth_m,
    squareSize,
    trees,
  });
}

// Envia a foto com progresso de upload (XHR, porque fetch não expõe progresso de envio).
function postWithProgress(url, fd, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let j = null;
      try { j = JSON.parse(xhr.responseText); } catch { /* resposta não é JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && j) resolve(j);
      else reject(new Error(j?.error || xhr.responseText || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Falha de conexão com o servidor'));
    xhr.send(fd);
  });
}

async function uploadPhoto(file) {
  setWarn([]);
  const fd = new FormData();
  fd.append('image', file);
  const t0 = performance.now();
  let timer = null;
  // Upload: mostra a porcentagem enviada. Depois do envio, o servidor processa e não informa progresso,
  // então mostramos o tempo decorrido.
  const data = await postWithProgress('/api/generate', fd, frac => {
    if (frac < 1) {
      setStatus(`Enviando a foto "${file.name}"... ${Math.round(frac * 100)}%`);
    } else if (!timer) {
      timer = setInterval(() => {
        const s = Math.round((performance.now() - t0) / 1000);
        setStatus(`Gerando o ambiente de "${file.name}"... ${s}s (a primeira vez pode demorar)`);
      }, 1000);
      setStatus(`Gerando o ambiente de "${file.name}"... 0s (a primeira vez pode demorar)`);
    }
  }).finally(() => { if (timer) clearInterval(timer); });
  await loadRelief(data.relief_url, data.meta.relief);
  stage.setPanorama(null);   // céu só com degradê; panorama da foto removido
  await loadPhotoAssets(data.meta);
  stage.setHouse(data.meta.house || null);   // casa recortada da foto (fachada 3D)

  const next = newState(data.meta.suggest);
  // Quando há chão quadrado, desliga o terreno procedural e o relevo (evita "parede de foto")
  if (data.meta.floor) {
    next.env.ground = false;
    next.env.terrain = false;
    next.env.hills = false;
    next.env.square = true;
    next.env.squareSize = 60;
    next.relief.enabled = false;   // o piso da foto substitui o relevo; relevo ficaria como parede
  }
  next.objects = scatter(next, 7, data.meta.context || 'mixed');
  if (data.meta.house) next.objects = next.objects.filter(o => o.type !== 'house' && o.type !== 'rowhouse');   // a casa da foto substitui as genéricas
  setProject(next, data.id);
  replaceUrl(data.id);
  setStatus(`Ambiente pronto · ${S.objects.length} objetos · profundidade: ${data.meta.depth_backend}`);
  $links.innerHTML = '';
}

async function openProject(id) {
  setStatus('Abrindo projeto...');
  const { scene: saved, meta } = await api(`/api/scene/${id}`);
  await loadRelief(`/projects/${id}/cenario.glb`, meta?.relief);
  stage.setPanorama(null);   // céu só com degradê
  await loadPhotoAssets(meta);
  stage.setHouse(meta?.house || null);
  const next = saved ? migrate(saved) : newState(meta?.suggest);
  if (!saved) {
    if (meta?.floor) {
      next.env.ground = false;
      next.env.terrain = false;
      next.env.hills = false;
      next.env.square = true;
      next.relief.enabled = false;   // piso da foto substitui o relevo
    }
    next.objects = scatter(next, 7, meta?.context || 'mixed');
    if (meta?.house) next.objects = next.objects.filter(o => o.type !== 'house' && o.type !== 'rowhouse');
  }
  setProject(next, id);
  replaceUrl(id);
  setStatus(`Projeto ${id} aberto · ${S.objects.length} objetos`);
}

// GLB que já existe (teste secundário): não é uma foto, então não há relevo nem chão procedural.
async function loadTestGlb(url, label) {
  setStatus('Carregando GLB de teste...');
  const gltf = await gltfLoader.loadAsync(url);
  stage.setReliefAsset(null);
  stage.setPanorama(null);
  stage.setSquare(null);    // limpa piso/paredes de foto anterior
  stage._squareAssets = null; // descarta assets da foto anterior (GLB de teste não tem foto)
  stage.setExternal(gltf.scene);
  const next = newState();
  next.env.ground = false;
  next.env.terrain = false;
  next.env.hills = false;
  next.relief.enabled = false;
  next.objects = [];
  setProject(next, 'novo');
  replaceUrl('novo');
  setStatus(`${label} · GLB de teste (vira arquivo ao clicar em Exportar)`);
}

// Mostra se a IA de profundidade e o Blender estão disponíveis.
async function checkServer() {
  try {
    const s = await api('/api/status');
    const warn = [];
    if (s.depth === 'missing') warn.push('Modelo de profundidade não instalado: pip install torch transformers.');
    if (!s.converter) warn.push('Blender não encontrado: o export gera só GLB e OBJ. Defina BLENDER=/caminho/blender.');
    setWarn(warn);
  } catch {
    setWarn(['Servidor não respondeu. Rode: python server.py']);
  }
}

// ---------- exportação --------------------------------------------------------------------------
// O GLB sai da CENA AO VIVO: mesmos nós, mesmas posições, mesmos colisores invisíveis de fora.
function buildGlb() {
  return new Promise((resolve, reject) => {
    const { x, z } = { x: S.spawn[0], z: S.spawn[2] };
    const feet = { x, y: groundY(world, x, z, character.collider) ?? 0, z };
    const restore = character.prepareExport(feet, S.spawnYaw || 0);     // pose de repouso no início

    const nodes = [...stage.exportNodes(), character.root];
    const homes = nodes.map(n => n.parent);
    const holder = new THREE.Scene();
    holder.name = 'photo2game';
    nodes.forEach(n => holder.add(n));

    const hidden = [];                                                   // linhas de depuração não entram no arquivo
    holder.traverse(o => { if (o.userData.debug && o.visible) { o.visible = false; hidden.push(o); } });

    const done = () => {
      hidden.forEach(o => { o.visible = true; });
      nodes.forEach((n, i) => homes[i]?.add(n));
      restore();
    };

    new GLTFExporter().parse(holder,
      result => { done(); resolve(new Blob([result], { type: 'model/gltf-binary' })); },
      err => { done(); reject(err); },
      { binary: true, onlyVisible: true, animations: character.clips, maxTextureSize: 2048 });
  });
}

async function exportScene() {
  if (!S) return;
  try {
    setStatus('Montando o GLB a partir da cena ao vivo...');
    const glb = await buildGlb();
    const fd = new FormData();
    fd.append('glb', glb, 'cenario_completo.glb');
    fd.append('scene', JSON.stringify(S));
    setStatus('Convertendo para FBX, OBJ e .blend (pode levar um minuto)...');
    const data = await api(`/api/export/${pid || 'novo'}`, { method: 'POST', body: fd });
    if (!pid || pid === 'novo') { pid = data.id; replaceUrl(pid); }
    showExports(data);
  } catch (e) {
    setStatus('Erro ao exportar: ' + e.message);
  }
}

function showExports(data) {
  $links.innerHTML = '';
  for (const f of data.files) {
    const a = document.createElement('a');
    a.href = f.url;
    a.download = f.name;
    a.textContent = `${f.name} (${(f.size / 1024).toFixed(0)} KB)`;
    $links.append(a, document.createElement('br'));
  }
  setWarn(data.warnings || []);
  setStatus('Exportação pronta. Os arquivos são gerados a partir da cena que você testou.');
}

// ---------- modo teste / câmera livre ----------------------------------------------------------
function setMode(m) {
  mode = m;
  input.enabled = m === 'test';
  orbit.enabled = m === 'edit';
  if (m === 'edit') orbit.target.copy(character.center(1));
  $modeTest.classList.toggle('on', m === 'test');
  $modeEdit.classList.toggle('on', m === 'edit');
}

// ---------- câmera em terceira pessoa ----------------------------------------------------------
const cam = { yaw: 0, pitch: 0.35, zoom: 0 };
const camTarget = new THREE.Vector3(), camDir = new THREE.Vector3(), centerNow = new THREE.Vector3();

function updateChaseCamera(dt, alpha) {
  character.center(alpha, centerNow);
  camTarget.set(centerNow.x, centerNow.y + 0.35 * character.scale, centerNow.z);
  camDir.set(
    Math.sin(cam.yaw) * Math.cos(cam.pitch),
    Math.sin(cam.pitch),
    Math.cos(cam.yaw) * Math.cos(cam.pitch));

  // Se algo bloquear o raio, aproxima a câmera para não atravessar paredes
  const maxDist = clamp(S.character.cameraDistance + cam.zoom, 2, 14);
  let dist = maxDist;
  const hit = world.castRay(new RAPIER.Ray(camTarget, camDir), maxDist, true, undefined, undefined, character.collider);
  if (hit) dist = Math.max(0.4, hit.toi - 0.15);

  const desired = camTarget.clone().addScaledVector(camDir, dist);
  camera.position.lerp(desired, 1 - Math.exp(-dt * 14));
  camera.lookAt(camTarget);
}

// ---------- loop: física em passo fixo, render interpolado -------------------------------------
let acc = 0, last = performance.now(), fpsFrames = 0, fpsTime = 0;
const focus = new THREE.Vector3();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  if (mode === 'test') {
    const look = input.consumeLook();
    cam.yaw -= look.dx * 0.006;
    cam.pitch = clamp(cam.pitch + look.dy * 0.004, -0.3, 1.3);
    cam.zoom = clamp(cam.zoom + input.consumeZoom(), -3, 9);
    if (input.consumeReset()) resetCharacter();

    acc += dt;
    while (acc >= FIXED) {
      character.step(FIXED, { ...input.move(), jump: input.consumeJump() }, cam.yaw);
      world.step();
      acc -= FIXED;
    }
    // Respawn de segurança: se o personagem cair para fora do mundo, volta ao ponto inicial
    if (character.curr && character.curr.y < -10) resetCharacter();
    const alpha = acc / FIXED;
    character.render(alpha, dt);
    updateChaseCamera(dt, alpha);
    focus.copy(camTarget);
  } else {
    input.consumeLook();
    input.consumeZoom();
    character.render(1, dt);
    orbit.update();
    focus.copy(orbit.target);
  }

  stage.update(focus);
  renderer.render(scene, camera);

  fpsFrames++;
  fpsTime += dt;
  if (fpsTime >= 0.5) {
    $fps.textContent = Math.round(fpsFrames / fpsTime) + ' fps';
    fpsFrames = 0;
    fpsTime = 0;
  }
}

// ---------- eventos ----------------------------------------------------------------------------
$photo.addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  // Mantém o arquivo no input e mostra o nome em um texto próprio (o input limpo voltaria a "Nenhum arquivo")
  $photoName.textContent = `Foto selecionada: ${f.name}`;
  guard(() => uploadPhoto(f)).finally(() => { e.target.value = ''; });
});
$glb.addEventListener('change', e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) guard(() => loadTestGlb(URL.createObjectURL(f), f.name));
});
$modeTest.addEventListener('click', () => setMode('test'));
$modeEdit.addEventListener('click', () => setMode('edit'));

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- inicialização ----------------------------------------------------------------------
setProject(S, null);                 // palco padrão enquanto nenhuma foto foi enviada
setMode('test');
checkServer();

const params = new URLSearchParams(location.search);
if (params.get('projeto')) guard(() => openProject(params.get('projeto')));
else if (params.get('scene')) guard(() => loadTestGlb(params.get('scene'), params.get('scene')));
else setStatus('Envie uma foto do local para começar.');

requestAnimationFrame(frame);

