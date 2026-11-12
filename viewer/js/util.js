// Utilitários compartilhados entre os módulos do viewer.
// Sem dependências de terceiros — pode ser importado por qualquer módulo JS.

// ---- gerador pseudo-aleatório determinístico (LCG 32-bit) ----------------------------------------
export function rng(seed = 1) {
  let s = (seed | 0) || 1;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) | 0;
    return (s >>> 0) / 4294967296;
  };
}

// ---- matemática simples --------------------------------------------------------------------------
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const lerp  = (a, b, t) => a + (b - a) * t;

export function smoothstep(lo, hi, v) {
  const t = clamp((v - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}

// ---- ruído de valor 2D (sem dependência) ---------------------------------------------------------
function _hash(x, y) {
  let h = (Math.imul((x | 0) * 374761393, (y | 0) * 668265263) + 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function hash2(x, y) { return _hash(x | 0, y | 0); }

export function noise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  return lerp(
    lerp(_hash(ix, iy), _hash(ix + 1, iy), u),
    lerp(_hash(ix, iy + 1), _hash(ix + 1, iy + 1), u),
    v,
  );
}

// Fractal Brownian Motion — valor em [-~1, ~1]
export function fbm(x, y, octaves = 4) {
  let val = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < octaves; i++) {
    val += amp * (noise2(x * freq, y * freq) * 2 - 1);
    amp *= 0.5; freq *= 2;
  }
  return val;
}

// ---- cor -----------------------------------------------------------------------------------------
// Desloca ligeiramente uma cor hexadecimal (variação por rng). amount ∈ [0,1].
export function jitterColor(hex, r, amount = 0.12) {
  const c = parseInt(String(hex).replace('#', ''), 16);
  const dr = (r() - 0.5) * amount;
  const cc = v => clamp(Math.round(v * (1 + dr)), 0, 255);
  const R = cc((c >> 16) & 255);
  const G = cc((c >> 8) & 255);
  const B = cc(c & 255);
  return '#' + [R, G, B].map(v => v.toString(16).padStart(2, '0')).join('');
}
