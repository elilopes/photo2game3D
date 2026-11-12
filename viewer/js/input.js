// Teclado e mouse do modo Teste. `enabled = false` (modo Editar) zera tudo.
const isField = t => !!t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName));

export class Input {
  constructor(el) {
    this.enabled = true;
    this.keys = new Set();
    this.jumpQueued = false;
    this.resetQueued = false;
    this.dx = 0; this.dy = 0; this.zoom = 0;
    this.dragging = false;

    el.tabIndex = 0;
    el.addEventListener('pointerdown', e => {
      el.focus({ preventScroll: true });            // tira o foco dos campos do painel
      if (e.button === 2 && this.enabled) { this.dragging = true; el.setPointerCapture(e.pointerId); }
    });
    el.addEventListener('pointerup', e => { if (e.button === 2) this.dragging = false; });
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('pointermove', e => {
      if (this.dragging) { this.dx += e.movementX; this.dy += e.movementY; }
    });
    el.addEventListener('wheel', e => { if (this.enabled) this.zoom += e.deltaY * 0.004; }, { passive: true });

    window.addEventListener('keydown', e => {
      if (isField(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (!this.enabled) return;
      if (e.code === 'Space' && !e.repeat) this.jumpQueued = true;
      if (e.code === 'KeyR' && !e.repeat) this.resetQueued = true;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.dragging = false; });
  }

  // x = direita/esquerda, z = frente/trás (-1..1)
  move() {
    if (!this.enabled) return { x: 0, z: 0, run: false };
    const k = this.keys;
    return {
      x: (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0),
      z: (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0),
      run: k.has('ShiftLeft') || k.has('ShiftRight'),
    };
  }

  consumeJump() { const v = this.jumpQueued && this.enabled; this.jumpQueued = false; return v; }
  consumeReset() { const v = this.resetQueued && this.enabled; this.resetQueued = false; return v; }
  consumeZoom() { const v = this.zoom; this.zoom = 0; return v; }
  consumeLook() { const v = { dx: this.dx, dy: this.dy }; this.dx = 0; this.dy = 0; return v; }
}
