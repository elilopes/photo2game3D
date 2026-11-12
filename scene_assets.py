"""Elementos do ambiente tirados da própria foto: linha do chão, textura do piso e árvores recortadas.

Modelo de câmera (o mesmo do viewer): a câmera da foto está a EYE metros do chão, o horizonte fica no centro da
imagem e o campo de visão horizontal é `fov`. Com isso, um pixel abaixo do horizonte corresponde a um ponto do
chão a uma distância conhecida, e dá para "endireitar" o chão visto de cima (retificação).

    distância à frente  dz = f * EYE / (linha - altura/2)         (f = (largura/2) / tan(fov/2))
    posição lateral      X = (coluna - largura/2) * dz / f

A detecção de chão é heurística. Para fotos rurais com campo/gramado funciona bem e gera piso retificado.
Para outros tipos (urbano, praia, neve, interior) usa piso genérico (porção inferior da foto).
O contexto detectado ('rural','urban','beach','snow','mixed') vai no meta e ajusta os objetos do ambiente.
"""
import math
import os

import numpy as np
from PIL import Image

EYE = 1.6          # altura dos olhos (m). Deve bater com EYE_HEIGHT em viewer/js/terrain.js
FOV = 55.0         # campo de visão horizontal da foto (graus). Deve bater com relief.fov em state.js


def focal(pw: int, fov: float = FOV) -> float:
    return (pw / 2) / math.tan(math.radians(fov) / 2)


# ---- contexto da foto ---------------------------------------------------------------------------
def _hsv(a: np.ndarray):
    """RGB float (0-255) -> (H graus 0-360, S 0-1, V 0-1), sem divisão por zero."""
    r, g, b = a[..., 0] / 255.0, a[..., 1] / 255.0, a[..., 2] / 255.0
    mx, mn = np.maximum(np.maximum(r, g), b), np.minimum(np.minimum(r, g), b)
    d = mx - mn
    s = d / np.maximum(mx, 1e-6)
    dd = np.maximum(d, 1e-6)
    h = np.where(mx == r, ((g - b) / dd) % 6, np.where(mx == g, (b - r) / dd + 2, (r - g) / dd + 4)) * 60.0
    return h, s, mx


def _texture(gray: np.ndarray) -> np.ndarray:
    """Textura local (desvio padrão numa janela ~7px). Neve/asfalto liso = baixo; rocha/mato = alto."""
    import cv2
    g = gray.astype(np.float32)
    m = cv2.blur(g, (7, 7))
    return np.sqrt(np.maximum(cv2.blur(g * g, (7, 7)) - m * m, 0))


def sample_context(img: Image.Image) -> str:
    """Classifica o ambiente combinando COR + TEXTURA (+ posição na foto).

    Retorna: 'snow' | 'tropical' | 'suburban' | 'alpine' | 'urban' | 'rural' | 'beach' | 'mixed'
    """
    im = img.convert("RGB")
    im.thumbnail((320, 320))                       # análise rápida; não precisa de resolução
    a = np.asarray(im, dtype=np.float32)
    ph = a.shape[0]
    h, s, v = _hsv(a)
    lum = 0.3 * a[..., 0] + 0.59 * a[..., 1] + 0.11 * a[..., 2]
    tex = _texture(lum)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]

    lower = slice(int(ph * 0.5), ph)               # metade de baixo: onde está o chão
    mid = slice(int(ph * 0.25), int(ph * 0.85))

    def frac(mask, sl=slice(None)):
        return float(mask[sl].mean())

    # ---- máscaras (cor) ----
    snow = (v > 0.62) & (s < 0.22) & (b >= r - 8)                       # branco, inclusive sombra azulada
    green = (h > 65) & (h < 170) & (s > 0.18) & (v > 0.10)             # verde claro E escuro (pinheiro)
    vivid_green = green & (s > 0.30) & (v > 0.30)
    rocky = (s < 0.20) & (lum > 70) & (lum < 215) & (tex > 9)           # cinza com textura (pedra)
    flat_gray = (s < 0.22) & (lum > 40) & (lum < 190) & (tex <= 9)      # asfalto/concreto liso
    terracotta = ((h < 20) | (h > 350)) & (s > 0.45) & (v > 0.45)       # telhado cerâmico/terra vermelha (vermelho intenso; folhas outonais ficam de fora)
    sand = (h > 25) & (h < 55) & (s > 0.18) & (s < 0.55) & (v > 0.60)
    # água azul/turquesa: s<0.65 exclui tendas/carros vibrantes; v<0.90 exclui céu muito claro
    blue_water = (h > 155) & (h < 225) & (s > 0.20) & (s < 0.65) & (v > 0.30) & (v < 0.90)

    snow_low, rock_low = frac(snow, lower), frac(rocky, lower)
    green_all, vivid_all = frac(green), frac(vivid_green, mid)
    green_low, gray_low = frac(green, lower), frac(flat_gray, lower)
    terra_all, sand_low = frac(terracotta, mid), frac(sand, lower)
    dark_low = frac(v < 0.35, lower)                                   # asfalto/sombra: escuro embaixo
    water_low = frac(blue_water, lower)                                # água só na metade de baixo (céu fica em cima)
    cob_low = frac((tex > 9) & (s < 0.45) & (lum > 60), lower)         # calçada: piso texturizado de cor neutra ou pastel
    # mar pouco saturado (cinza-azulado, verde-acinzentado) e areia clara: sinais extras só para praia
    sea_ext_low = frac((h > 170) & (h < 240) & (s > 0.08) & (v > 0.30) & (v < 0.85), lower)
    sand_pale_low = frac((h > 20) & (h < 60) & (s > 0.05) & (s < 0.25) & (v > 0.60), lower)

    # interior: teto/parede lisa e clara em cima, sem céu azul e sem gramado no chão.
    # Vem antes de 'snow' porque piso/parede branca de sala acionaria a neve.
    top, bot = slice(0, int(ph * 0.33)), slice(int(ph * 0.67), ph)
    sky = (h > 170) & (h < 250) & (s > 0.10) & (v > 0.55)
    uni = (tex <= 6) & (v > 0.45)
    # neve fria no chão (céu cinza ou azul claro) vem antes de 'indoor': o céu uniforme parece teto
    cool_bot = float((b - r)[bot].mean())               # interior tem chão quente (b-r bem negativo)
    if frac(snow, bot) > 0.40 and cool_bot > -10:
        return 'snow'
    if frac(uni, top) > 0.25 and frac(sky, top) < 0.10 and frac(green, bot) < 0.05 and green_all < 0.10 \
            and cool_bot < -12:
        return 'indoor'

    # caverna: topo escuro, sem céu azul, sem verde e textura de rocha em volta
    if frac(v < 0.35, top) > 0.35 and frac(sky, top) < 0.12 and green_all < 0.10 and frac(tex > 9, lower) > 0.35:
        return 'cave'

    if snow_low > 0.35:
        return 'snow'
    # floresta: topo verde denso, chão de terra ou madeira (não gramado), sem água
    brown = (h > 8) & (h < 42) & (s > 0.18) & (s < 0.75) & (v > 0.12) & (v < 0.65)   # terra, madeira de passarela
    # laterais escuras (folhas sombreadas e troncos) também indicam mata, além do topo verde
    edge = np.zeros(v.shape, bool)
    edge_w = int(a.shape[1] * 0.25)
    edge[:, :edge_w] = True
    edge[:, a.shape[1] - edge_w:] = True
    dark_veg = (((h > 65) & (h < 170) & (s > 0.18) & (v > 0.08) & (v < 0.45))      # verde escuro
                | ((h > 8) & (h < 42) & (s > 0.18) & (v > 0.08) & (v < 0.45)))     # marrom escuro (troncos)
    upper = int(ph * 0.67)
    side_dark = float(dark_veg[:upper][edge[:upper]].mean())
    if (frac(green, top) > 0.35 or side_dark > 0.30) and green_all > 0.20 and frac(green, bot) < 0.5 \
            and water_low < 0.04 and frac(brown, bot) > 0.02:
        return 'forest'
    if vivid_all > 0.25 or (green_all > 0.32 and (water_low > 0.04 or terra_all > 0.02)):
        return 'tropical'                  # folhagem densa/alta, sem gramado grande no chão
    if terra_all > 0.05 and green_all < 0.18:
        return 'suburban'                  # telhas/terra vermelha + pouco mato
    if rock_low > 0.30 and dark_low < 0.25 and green_low < 0.10 and water_low < 0.08:
        return 'alpine'                    # pedra clara e texturizada embaixo
    # praia: mar embaixo, ou areia com alguma água; rochas/mato costeiros também contam
    beach_cond = (
        water_low > 0.10
        or (sand_low > 0.25 and water_low > 0.02)
        or (sand_low > 0.20 and water_low > 0.03)
        or (sand_low > 0.08 and water_low > 0.03 and green_all < 0.15 and rock_low < 0.20)
        or (sea_ext_low > 0.15 and (sand_low > 0.12 or sand_pale_low > 0.12))   # mar pálido + areia clara
        or (sand_low > 0.30 and dark_low < 0.15 and green_all < 0.10)           # areia domina o chão, mar mais no meio da foto
    )
    if beach_cond and green_all < 0.25:
        return 'beach'
    # urbano: escuro ou cinza embaixo, e chão de asfalto liso ou calçada texturizada
    if (dark_low > 0.30 or gray_low > 0.30) and green_low < 0.12 and water_low < 0.08 \
            and (gray_low > 0.15 or rock_low > 0.15 or cob_low > 0.2):
        return 'urban'
    if green_low > 0.08 or green_all > 0.15:
        return 'rural'
    return 'mixed'


# ---- linha do chão ------------------------------------------------------------------------------
def detect_ground_row(img: Image.Image):
    """Linha (em pixels, de cima para baixo) onde o chão aberto começa, ou None se não achar.

    Anda de baixo para cima e para quando a linha deixa de parecer "campo" (verde ou terra escura).
    """
    a = np.asarray(img.convert("RGB"), dtype=np.float32)
    ph = a.shape[0]
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    lum = 0.3 * r + 0.59 * g + 0.11 * b
    # campo = verde, escuro, ou terra/madeira marrom (trilha de terra tem r > g > b e não é verde)
    field = ((g > r + 4) & (g > b + 4)) | (lum < 75)
    # terra/madeira marrom só conta na metade de baixo; em cima é parede ou estrutura de madeira
    brown = (r > g + 6) & (r > b + 12) & (lum < 170) & (np.arange(ph)[:, None] >= ph * 0.6)
    field = field | brown
    frac = field.mean(1)
    k = max(5, ph // 60)
    frac = np.convolve(np.pad(frac, (k // 2, k - k // 2 - 1), mode="edge"), np.ones(k) / k, mode="valid")

    if frac[-max(3, ph // 30):].mean() < 0.55:        # a base da foto não é campo: sem chão confiável
        return None
    row = ph - 1
    while row > 0 and frac[row] >= 0.5:
        row -= 1
    row += 1
    # o chão precisa ocupar uma parte razoável da foto e ficar abaixo do horizonte (centro da imagem)
    if row <= ph / 2 + 0.04 * ph or (ph - row) < 0.15 * ph:
        return None
    return int(row)


def ground_info(img: Image.Image, fov: float = FOV):
    """Dados do chão para o viewer: linha, distância do painel e fração do horizonte. None se não houver chão."""
    pw, ph = img.size
    gl = detect_ground_row(img)
    if gl is None:
        return None
    f = focal(pw, fov)
    dist = f * EYE / (gl - ph / 2)
    return dict(row=gl, distance=float(np.clip(dist, 18.0, 70.0)), horizon_frac=float((ph / 2) / gl),
                eye=EYE, fov=fov)


# ---- piso ladrilhável ---------------------------------------------------------------------------
def _bilinear(a: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    h, w = a.shape[:2]
    x = np.clip(x, 0, w - 1.001)
    y = np.clip(y, 0, h - 1.001)
    x0, y0 = x.astype(np.int64), y.astype(np.int64)
    fx, fy = (x - x0)[..., None], (y - y0)[..., None]
    top = a[y0, x0] * (1 - fx) + a[y0, x0 + 1] * fx
    bot = a[y0 + 1, x0] * (1 - fx) + a[y0 + 1, x0 + 1] * fx
    return top * (1 - fy) + bot * fy


def floor_tile(img: Image.Image, gl: int, fov: float = FOV, size: int = 512):
    """Pedaço do chão visto de cima (retificado), pronto para ladrilhar. Devolve (imagem, largura_m, profundidade_m).

    Pega só linhas bem abaixo da linha do chão (longe das casas e árvores) e dentro da largura que a foto cobre.
    Em vista de cima, as linhas de plantio ficam paralelas ao eixo Z.
    """
    pw, ph = img.size
    f = focal(pw, fov)
    G = ph - gl
    # Linha mais longe do pedaço: nunca acima de 78% da altura (abaixo da base de casas, varandas e arbustos
    # que a heurística de campo confunde com chão). Sem isso o pedaço traz parede, porta e varanda.
    r_far = max(gl + 0.30 * G, 0.78 * ph)
    r_near = ph - 0.06 * G                                   # linha mais perto (início do pedaço na câmera)
    dz_far = f * EYE / (r_far - ph / 2)
    dz_near = f * EYE / (r_near - ph / 2)
    half = 0.92 * dz_near * math.tan(math.radians(fov) / 2)  # metade da largura que cabe na linha mais próxima

    X = np.linspace(-half, half, size, dtype=np.float32)
    Z = np.linspace(dz_far, dz_near, size, dtype=np.float32)   # primeira linha = mais longe
    px = pw / 2 + f * X[None, :] / Z[:, None]
    py = ph / 2 + f * EYE / Z[:, None] + np.zeros_like(px)
    tile = _bilinear(np.asarray(img.convert("RGB"), dtype=np.float32), px, py)
    return Image.fromarray(np.clip(tile, 0, 255).astype(np.uint8)), float(2 * half), float(dz_far - dz_near)


def universal_floor(img: Image.Image, size: int = 512):
    """Piso genérico: pega os 35% inferiores da foto como textura de chão.

    Usado quando detect_ground_row não acha chão (fotos urbanas, praia, neve, interior, etc.).
    Devolve (imagem, largura_m, profundidade_m). Dimensões genéricas (8x8m); o viewer ladrilha em cima.
    """
    from PIL import ImageFilter
    pw, ph = img.size
    top = int(ph * 0.65)
    crop = img.convert("RGB").crop((0, top, pw, ph))
    # Leve desfoque para reduzir artefatos de ladrilhamento nas bordas
    crop = crop.filter(ImageFilter.GaussianBlur(radius=1.5))
    tile = crop.resize((size, size), Image.LANCZOS)
    return tile, 8.0, 8.0


# ---- árvores recortadas -------------------------------------------------------------------------
def _sky_mask(a: np.ndarray) -> np.ndarray:
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx, mn = a.max(-1), a.min(-1)
    sat = (mx - mn) / np.maximum(mx, 1)
    lum = 0.3 * r + 0.59 * g + 0.11 * b
    blue = (b > r + 8) & (b >= g - 6)                   # azul / azul-acinzentado
    bright_gray = (lum > 150) & (sat < 0.28)            # nuvens e névoa
    return blue | bright_gray


def extract_trees(img: Image.Image, gl: int, out_dir: str, fov: float = FOV, max_trees: int = 3):
    """Recorta as árvores da parte de cima da foto (acima do chão) e salva PNGs com transparência.

    Folhagem = pixel claramente mais verde que vermelho e azul (telhados vermelhos, céu e paredes ficam de fora).
    Blob largo demais (vários arbustos juntos) é cortado na borda que toca a foto. Devolve lista de dicts:
    arquivo, largura_m, altura_m (estimadas pela mesma câmera do piso). Lista vazia se não achar nenhuma.
    """
    import cv2

    pw, ph = img.size
    f = focal(pw, fov)
    a = np.asarray(img.convert("RGB"), dtype=np.float32)[:gl]
    # Vegetação em HSV: verde claro OU escuro (pinheiro, sombra), com pouca saturação aceita (neve, contraluz).
    h, sat, val = _hsv(a)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    green_hue = (h > 55) & (h < 175)
    veg = (green_hue & (sat > 0.15) & (val > 0.08)) | ((g >= r) & (g >= b - 4) & (val < 0.38) & (sat > 0.08))
    veg &= ~(b > g + 6)                                   # céu azul/azulado fora
    veg = veg.astype(np.uint8)
    veg = cv2.morphologyEx(veg, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))   # fecha buracos (neve/galhos)
    veg = cv2.morphologyEx(veg, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))

    n, labels, stats, _ = cv2.connectedComponentsWithStats(veg, connectivity=8)
    # descarta blobs esburacados (arbustos juntos, muros): uma copa de árvore ocupa boa parte da sua caixa
    cands = [(stats[i, 4], i) for i in range(1, n)
             if stats[i, 4] >= 0.004 * pw * ph and stats[i, 3] >= 0.10 * ph
             and stats[i, 4] / float(stats[i, 2] * stats[i, 3]) >= (0.22 if stats[i, 3] >= 0.25 * ph else 0.38)]
    cands.sort(reverse=True)

    os.makedirs(out_dir, exist_ok=True)
    rgb8 = np.clip(a, 0, 255).astype(np.uint8)
    out = []
    for _, i in cands[:max_trees]:
        x, y, w, h = (int(v) for v in stats[i, :4])
        if w > 1.6 * h:                                  # blob largo: fica só a faixa junto à borda da foto
            w = int(h)
            if x > 1:
                x = x + int(stats[i, 2]) - w
        m = (labels[y:y + h, x:x + w] == i).astype(np.uint8) * 255
        m = cv2.GaussianBlur(m, (0, 0), 1.2)
        crop = rgb8[y:y + h, x:x + w].copy()
        mean = crop[m > 128].mean(0) if (m > 128).any() else np.array([60, 80, 40])
        crop[m < 128] = mean.astype(np.uint8)            # sem halo: pinta o fundo com a cor média da copa
        base = y + h
        dz = f * EYE / max(base - ph / 2, 8)
        wm, hm = w * dz / f, h * dz / f
        k = min(1.0, 12.0 / hm) if hm > 12 else 1.0      # limita a altura real estimada (copas muito perto da câmera)
        hm = max(hm * k, 4.0) if hm * k < 4.0 else hm * k
        fn = f"tree_{len(out)}.png"
        Image.fromarray(np.dstack([crop, m]), "RGBA").save(os.path.join(out_dir, fn))
        out.append(dict(file=fn, width_m=float(wm * k), height_m=float(hm)))
    return out


def _house_blob(mask: np.ndarray, pw: int, ph: int, gl):
    """Maior bloco da máscara com cara de casa. Se gl for dado, a base precisa estar perto dele;
    se não, a base precisa ficar na metade de baixo da foto. Devolve (labels, i, x, y, w, h) ou None."""
    import cv2
    m = mask.astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))     # corta pontes finas (troncos, arbustos)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((21, 21), np.uint8))   # fecha janelas e vãos
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    best = None
    for i in range(1, n):
        x, y, w, hh, area = (int(v) for v in stats[i])
        base = y + hh
        if w < 0.15 * pw or hh < 0.12 * ph:                 # pequeno demais: arbusto, poste, pedaço de muro
            continue
        if gl is not None and abs(base - gl) > 0.08 * ph:
            continue
        if gl is None and base < 0.5 * ph:                  # casa fica na metade de baixo da foto
            continue
        if best is None or area > best[0]:
            best = (area, i, x, y, w, hh)
    if best is None:
        return None
    return (labels,) + best[1:]


def extract_house(img: Image.Image, gl, out_dir: str, fov: float = FOV):
    """Recorta a casa principal da foto e salva PNG com transparência.

    Tenta primeiro pela cor (tijolo, telha e madeira quentes, sem verde e sem céu), que não depende
    da linha do chão. Se não achar, tenta o bloco de construção acima da linha do chão (gl).
    Devolve dict(file, width_m, height_m, dist, x_m) ou None se não achar uma casa confiável.
    dist = distância da câmera (m); x_m = deslocamento lateral (m) em relação ao eixo da câmera.
    """
    import cv2

    pw, ph = img.size
    f = focal(pw, fov)
    full = np.asarray(img.convert("RGB"), dtype=np.float32)
    h, sat, val = _hsv(full)
    r, g, b = full[..., 0], full[..., 1], full[..., 2]
    veg = (h > 55) & (h < 175) & (sat > 0.15) & (val > 0.08)
    warm = (r > g + 6) & (r > b + 14) & (sat > 0.15) & ~veg
    found = None
    if gl is not None:                                      # 1) bloco de construção acima da linha do chão
        a = full[:gl]
        h2, sat2, val2 = _hsv(a)
        veg2 = (h2 > 55) & (h2 < 175) & (sat2 > 0.15) & (val2 > 0.08)
        bld = (~_sky_mask(a)) & (~veg2)
        pad = np.zeros((ph - gl, pw), dtype=bool)
        found = _house_blob(np.vstack([bld, pad]), pw, ph, gl)
    if found is None:                                       # 2) tijolo, telha e madeira quentes
        found = _house_blob(warm, pw, ph, None)
    if found is None:
        return None

    labels, i, x, y, w, hh = found
    base = y + hh
    mask = (labels[y:y + hh, x:x + w] == i).astype(np.uint8) * 255
    mask = cv2.GaussianBlur(mask, (0, 0), 1.2)
    rgb8 = np.clip(full, 0, 255).astype(np.uint8)
    crop = rgb8[y:y + hh, x:x + w].copy()

    dz = f * EYE / max(base - ph / 2, 8)
    wm, hm = w * dz / f, hh * dz / f
    cx = x + w / 2
    x_m = (cx - pw / 2) * dz / f

    os.makedirs(out_dir, exist_ok=True)
    fn = "casa.png"
    Image.fromarray(np.dstack([crop, mask]), "RGBA").save(os.path.join(out_dir, fn))
    return dict(file=fn, width_m=float(wm), height_m=float(hm), dist=float(dz), x_m=float(x_m))
