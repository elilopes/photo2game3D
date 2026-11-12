// Painel de ajustes do ambiente.
//
// O painel NÃO guarda nada por conta própria. Ele lê o estado do projeto (S), monta uma cópia alterada e
// entrega essa cópia para `commit(next, { live })`, que é quem aplica no palco (stage.sync), salva o
// scene.json e atualiza a cena ao vivo. Assim o teste e o arquivo exportado continuam saindo do mesmo estado.
//
//   mountPanel({
//     getS: () => S,                      // estado atual
//     commit: (next, { live }) => {...},  // aplica: S = next; stage.sync(S, live); salva; se !live, pode recarregar a cena
//     history,                            // History (state.js), já com reset(JSON.stringify(S)) no carregamento
//     stage,                              // Stage (stage.js), usado só para mostrar/ocultar colisores
//     onExport,                           // opcional: função chamada pelo botão "Exportar"
//   });
import { TYPES, scatter } from './library.js';

const CSS = `
#p2g-panel{position:fixed;top:10px;right:10px;width:300px;max-height:calc(100vh - 20px);display:flex;flex-direction:column;
  background:rgba(14,18,24,.92);color:#e8edf2;font:12px/1.4 system-ui,sans-serif;border-radius:10px;z-index:20;
  box-shadow:0 6px 24px rgba(0,0,0,.35);user-select:none}
#p2g-panel.closed .p2g-body{display:none}
#p2g-panel header{display:flex;gap:6px;align-items:center;padding:8px 10px;border-bottom:1px solid #2a323c}
#p2g-panel header b{flex:1;font-size:13px}
#p2g-panel button{background:#26303b;color:#e8edf2;border:1px solid #3a4654;border-radius:6px;padding:4px 8px;cursor:pointer;font:inherit}
#p2g-panel button:hover:not(:disabled){background:#33404e}
#p2g-panel button:disabled{opacity:.4;cursor:default}
#p2g-panel .p2g-body{overflow:auto;padding:4px 10px 12px}
#p2g-panel details{border-bottom:1px solid #222a33;padding:6px 0}
#p2g-panel summary{cursor:pointer;font-weight:600;padding:4px 0}
#p2g-panel .row{display:grid;grid-template-columns:110px 1fr 44px;gap:6px;align-items:center;margin:4px 0}
#p2g-panel .row.wide{grid-template-columns:110px 1fr}
#p2g-panel .row output{text-align:right;opacity:.75;font-variant-numeric:tabular-nums}
#p2g-panel input[type=range]{width:100%}
#p2g-panel input[type=color]{width:100%;height:22px;padding:0;border:0;background:none}
#p2g-panel select,#p2g-panel input[type=number]{background:#1b232c;color:#e8edf2;border:1px solid #3a4654;border-radius:4px;padding:2px}
#p2g-panel .obj{border:1px solid #2a323c;border-radius:8px;padding:6px 8px;margin:6px 0}
#p2g-panel .obj header{padding:0 0 4px;border:0}
#p2g-panel .hint{opacity:.6;margin:4px 0}
`;

// ---- utilidades de DOM ------------------------------------------------------------------------
function el(tag, props = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k in n) n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) n.append(c);
  return n;
}

const fmt = v => (Math.round(Number(v) * 1000) / 1000).toString();
const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
function setPath(o, p, v) {
  const ks = p.split('.'), last = ks.pop();
  ks.reduce((a, k) => a[k], o)[last] = v;
}
const hex = v => (String(v).startsWith('#') ? String(v) : '#' + v);

// ---- montagem ---------------------------------------------------------------------------------
export function mountPanel({ getS, commit, history, stage, onExport }) {
  const style = el('style', {}, [CSS]);
  document.head.append(style);

  const root = el('div', { id: 'p2g-panel' });
  const body = el('div', { class: 'p2g-body' });
  const btnUndo = el('button', { title: 'Desfazer (Ctrl+Z)', onclick: () => undo() }, ['↶']);
  const btnRedo = el('button', { title: 'Refazer (Ctrl+Y)', onclick: () => redo() }, ['↷']);
  const btnToggle = el('button', { title: 'Mostrar/ocultar painel', onclick: () => root.classList.toggle('closed') }, ['≡']);
  const header = el('header', {}, [el('b', {}, ['Ajustes do ambiente']), btnUndo, btnRedo, btnToggle]);
  root.append(header, body);
  if (onExport) root.querySelector('header').append(el('button', { onclick: onExport }, ['Exportar']));
  document.body.append(root);

  // ---- edição: toda alteração passa por aqui ----------------------------------------------------
  // live = true: enquanto o usuário arrasta um controle (só visual). live = false: ao soltar, vira
  // um passo do histórico e o painel é redesenhado a partir do estado novo.
  function edit(mutate, { live = false } = {}) {
    const next = structuredClone(getS());
    mutate(next);
    commit(next, { live });
    if (!live) {
      history.commit(JSON.stringify(next));
      render();
    }
  }

  function undo() { const j = history.undo(); if (j) { commit(JSON.parse(j), { live: false }); render(); } }
  function redo() { const j = history.redo(); if (j) { commit(JSON.parse(j), { live: false }); render(); } }

  window.addEventListener('keydown', e => {
    if (e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); undo(); }
    if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey))) { e.preventDefault(); redo(); }
  });

  // ---- controles ---------------------------------------------------------------------------------
  function slider(label, value, min, max, step, set) {
    const out = el('output', {}, [fmt(value)]);
    const input = el('input', { type: 'range', min, max, step, value });
    input.addEventListener('input', () => { out.textContent = fmt(input.value); set(+input.value, true); });
    input.addEventListener('change', () => set(+input.value, false));
    return el('div', { class: 'row' }, [el('span', {}, [label]), input, out]);
  }

  function color(label, value, set) {
    const input = el('input', { type: 'color', value: hex(value) });
    input.addEventListener('input', () => set(input.value, true));
    input.addEventListener('change', () => set(input.value, false));
    return el('div', { class: 'row wide' }, [el('span', {}, [label]), input]);
  }

  function check(label, value, set) {
    const input = el('input', { type: 'checkbox', checked: !!value });
    input.addEventListener('change', () => set(input.checked));
    return el('div', { class: 'row wide' }, [el('span', {}, [label]), input]);
  }

  function select(label, value, options, set) {
    const input = el('select', {}, options.map(([v, t]) => el('option', { value: v, selected: v === value }, [t])));
    input.addEventListener('change', () => set(input.value));
    return el('div', { class: 'row wide' }, [el('span', {}, [label]), input]);
  }

  // Controles ligados a um caminho do estado (ex.: 'env.sunAzimuth')
  const bindRange = (label, path, min, max, step) =>
    slider(label, getPath(getS(), path), min, max, step, (v, live) => edit(S => setPath(S, path, v), { live }));
  const bindColor = (label, path) =>
    color(label, getPath(getS(), path), (v, live) => edit(S => setPath(S, path, v), { live }));
  const bindCheck = (label, path) =>
    check(label, getPath(getS(), path), v => edit(S => setPath(S, path, v)));

  function section(title, rows, open = false) {
    return el('details', { open }, [el('summary', {}, [title]), ...rows]);
  }

  // ---- seções ------------------------------------------------------------------------------------
  function environmentSection() {
    return section('Ambiente e céu', [
      bindCheck('Chão', 'env.ground'),
      bindCheck('Relevo do terreno', 'env.terrain'),
      bindCheck('Colinas', 'env.hills'),
      bindCheck('Sombras', 'env.shadows'),
      bindRange('Raio do mundo (m)', 'env.radius', 30, 200, 5),
      bindRange('Semente do terreno', 'env.seed', 1, 999, 1),
      bindRange('Ondulação do chão', 'env.terrainBump', 0, 2, 0.05),
      bindRange('Altura das colinas', 'env.hillHeight', 0, 40, 1),
      bindRange('Textura (repetição)', 'env.textureTile', 1, 20, 1),
      bindRange('Névoa (distância)', 'env.fogFar', 40, 400, 5),
      bindRange('Azimute do sol', 'env.sunAzimuth', 0, 360, 1),
      bindRange('Altura do sol', 'env.sunElevation', 5, 89, 1),
      bindRange('Intensidade do sol', 'env.sunIntensity', 0, 5, 0.1),
      bindRange('Luz ambiente', 'env.ambient', 0, 3, 0.05),
      bindColor('Cor do céu (topo)', 'env.skyTop'),
      bindColor('Cor do horizonte', 'env.skyHorizon'),
      bindColor('Cor do chão', 'env.groundColor'),
      bindColor('Cor das colinas', 'env.hillColor'),
    ], true);
  }

  function squareSection() {
    const S = getS();
    const rows = [bindCheck('Chão da foto', 'env.square')];
    if (S.env.square) {
      rows.push(bindRange('Tamanho (m)', 'env.squareSize', 20, 120, 5));
    } else {
      rows.push(el('p', { class: 'hint' }, ['Requer foto com chão detectável.']));
    }
    return section('Chão da foto', rows);
  }

  function reliefSection() {
    return section('Foto (relevo)', [
      bindCheck('Mostrar foto', 'relief.enabled'),
      bindCheck('Colisão da foto', 'relief.collider'),
      bindCheck('Luz da cena na foto', 'relief.lit'),
      bindRange('Distância (m)', 'relief.distance', 10, 120, 1),
      bindRange('Campo de visão', 'relief.fov', 20, 100, 1),
      bindRange('Profundidade', 'relief.depth', 0, 30, 0.5),
      bindRange('Linha do horizonte', 'relief.horizon', 0, 1, 0.01),
      bindRange('Altura (m)', 'relief.offsetY', -5, 5, 0.05),
      bindRange('Giro (graus)', 'relief.rotY', -180, 180, 1),
    ]);
  }

  function characterSection() {
    return section('Personagem', [
      bindRange('Altura (m)', 'character.height', 1, 2.5, 0.05),
      bindRange('Andar (m/s)', 'character.walkSpeed', 0.5, 10, 0.1),
      bindRange('Correr (m/s)', 'character.runSpeed', 1, 16, 0.1),
      bindRange('Altura do pulo (m)', 'character.jumpHeight', 0.2, 4, 0.05),
      bindRange('Gravidade', 'character.gravity', 5, 40, 0.5),
      bindRange('Distância da câmera', 'character.cameraDistance', 2, 14, 0.5),
      bindColor('Camisa', 'character.shirt'),
      bindColor('Calça', 'character.pants'),
      bindColor('Pele', 'character.skin'),
      bindColor('Cabelo', 'character.hair'),
      bindColor('Sapatos', 'character.shoes'),
    ]);
  }

  function paletteSection() {
    return section('Cores dos objetos', [
      bindColor('Folhagem', 'palette.foliage'),
      bindColor('Tronco', 'palette.trunk'),
      bindColor('Paredes', 'palette.building'),
      bindColor('Telhado', 'palette.roof'),
    ]);
  }

  function objectCard(S, o) {
    const id = o.id;
    const set = (key, v, live = false) => edit(St => {
      const t = St.objects.find(x => x.id === id);
      if (t) t[key] = v;
    }, { live });
    const label = TYPES[o.type]?.label || o.type;
    return el('div', { class: 'obj' }, [
      el('header', { class: 'row wide' }, [
        el('b', {}, [`${label} #${id}`]),
        el('button', { onclick: () => edit(St => { St.objects = St.objects.filter(x => x.id !== id); }) }, ['Remover']),
      ]),
      select('Colisor', o.collider, [['auto', 'Automático'], ['box', 'Caixa'], ['mesh', 'Malha exata'], ['none', 'Nenhum']],
        v => set('collider', v)),
      slider('Giro (graus)', o.rotY || 0, 0, 360, 1, (v, live) => set('rotY', v, live)),
      slider('Escala', o.scale || 1, 0.3, 3, 0.05, (v, live) => set('scale', v, live)),
      slider('Posição X', o.x, -80, 80, 0.1, (v, live) => set('x', v, live)),
      slider('Posição Z', o.z, -80, 80, 0.1, (v, live) => set('z', v, live)),
    ]);
  }

  function objectsSection(S) {
    const typeSel = el('select', {}, Object.entries(TYPES).map(([k, d]) => el('option', { value: k }, [d.label])));
    const cards = S.objects.length
      ? S.objects.map(o => objectCard(S, o))
      : [el('p', { class: 'hint' }, ['Nenhum objeto. Adicione abaixo ou espalhe de novo.'])];

    return section(`Objetos (${S.objects.length})`, [
      ...cards,
      el('div', { class: 'row wide' }, [typeSel, el('button', {
        onclick: () => edit(St => {
          const x = St.spawn[0], z = St.spawn[2] - 5;
          St.objects.push({ id: St.nextId++, type: typeSel.value, x, z, lift: 0, rotY: 0, scale: 1,
            seed: Math.floor(Math.random() * 99999) + 1, collider: 'auto' });
        }),
      }, ['Adicionar'])]),
      el('div', { class: 'row wide' }, [el('span', {}, ['Ambiente']), el('button', {
        onclick: () => edit(St => {
          St.objects = scatter(St, Math.floor(Math.random() * 999) + 1);
        }),
      }, ['Espalhar de novo'])]),
      check('Mostrar colisores', stage?.showColliders, v => stage?.setShowColliders(v)),
    ], true);
  }

  // ---- renderização ------------------------------------------------------------------------------
  function render() {
    const S = getS();
    btnUndo.disabled = !history.canUndo;
    btnRedo.disabled = !history.canRedo;
    body.replaceChildren(
      objectsSection(S),
      environmentSection(),
      squareSection(),
      reliefSection(),
      paletteSection(),
      characterSection(),
      el('p', { class: 'hint' }, ['Arraste para ver ao vivo. Ao soltar, a mudança entra no histórico (Ctrl+Z).']),
    );
  }

  render();
  return { render, undo, redo, root };
}
