"""Ambiente 360° a partir da foto: gera um panorama equirretangular (2:1) para o céu/fundo do viewer.

Convenção (igual à do viewer e à esfera do céu, que tem u = 0,75 na direção da foto):
  - a foto fica no centro (direção -Z), com o campo de visão horizontal `fov` graus;
  - a linha do horizonte da foto fica no equador (lat = 0);
  - acima da foto: céu (degradê até a cor do céu sugerida pela foto);
  - abaixo da foto: o chão continua pela foto espelhada nas bordas (linhas de plantio, terra, grama),
    esfumando para a cor do chão só ao longe;
  - laterais e costas: extensão das bordas, com desfoque crescente.

Modos (variável PHOTO2GAME_OUTPAINT):
  - (padrão)  "smear": só CPU, reproduzível, sem modelo.
  - "cv2":     preenche as laterais com inpainting do OpenCV (sem pesos de modelo).
  - "sd":      preenche as laterais com inpainting por difusão (diffusers + pesos locais).
               NÃO testado no ambiente de desenvolvimento: sem acesso aos pesos.
"""
import os

import numpy as np
from PIL import Image, ImageFilter

PHOTO_FOV = 55.0   # deve bater com relief.fov do estado (viewer/js/state.js)


def _hex_rgb(h, fallback):
    try:
        h = str(h).lstrip("#")
        return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float32)
    except (ValueError, TypeError):
        return np.array(fallback, dtype=np.float32)


def _smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def _mix(a, b, t):
    return a + (b - a) * t[..., None]


def _tri(v, n):
    """Rebate v dentro de [0, n] espelhando nas bordas (0 -> n -> 0 ...). Contínuo em todo o eixo."""
    p = np.mod(v, 2 * n)
    return np.where(p > n, 2 * n - p, p)


def _mode():
    return os.environ.get("PHOTO2GAME_OUTPAINT", "").lower()


def build_panorama(img: Image.Image, colors: dict, out_path: str, out_w: int = 2048, fov: float = PHOTO_FOV):
    """Escreve o panorama em out_path (JPEG). Devolve um dicionário com as dimensões e o método usado."""
    W, H = out_w, out_w // 2
    photo = img.convert("RGB")
    pw, ph = photo.size
    src = np.asarray(photo, dtype=np.float32)
    # Sem desfoque: as laterais usam a média de cada linha das bordas da foto (cor nítida, sem listras verticais)
    ew = max(2, pw // 12)
    left_rows = src[:, :ew].mean(1)
    right_rows = src[:, -ew:].mean(1)

    # Direção de cada pixel do panorama
    col = (np.arange(W) + 0.5) / W
    row = (np.arange(H) + 0.5) / H
    theta = 2 * np.pi * (col - 0.75)                       # 0 = direção da foto
    lat = np.pi / 2 - np.pi * row                          # +90° no zênite, -90° no nadir
    th = theta[None, :]
    la = lat[:, None]
    x = np.cos(la) * np.sin(th)
    y = np.sin(la) * np.ones_like(th)
    z = -np.cos(la) * np.cos(th)

    f = (pw / 2) / np.tan(np.radians(fov) / 2)             # mesmo f que o viewer usa para o painel
    half_v = np.arctan((ph / 2) / f)                       # latitude da borda de cima/baixo da foto
    half_h = np.radians(fov) / 2

    lat_full = np.broadcast_to(la, (H, W))
    below = lat_full < -half_v                             # chão abaixo da foto
    valid = (-z) > 1e-3                                    # na frente da câmera

    # Projeção perspectiva: onde cada direção cai na foto
    depth = np.maximum(-z, 1e-3)
    px = pw / 2 + f * x / depth                            # coordenadas contínuas (pixels)
    py = ph / 2 - f * y / depth

    # Linhas: acima, a borda (céu); abaixo da foto, espelhada (chão continua).
    sy = np.round(np.clip(py - 0.5, 0, ph - 1)).astype(np.int64)
    sx_proj = np.clip(np.round(px - 0.5), 0, pw - 1).astype(np.int64)

    sharp_proj = src[sy, sx_proj]

    # Atrás da câmera a projeção não vale. A cor vem da mistura das bordas esquerda e direita,
    # com t = (1 + sen θ)/2: 1 na borda direita (θ = +90°), 0 na esquerda (θ = -90°) e 0,5 em θ = 180°.
    t = np.broadcast_to((1 + np.sin(th)) / 2, (H, W))[..., None]
    edge = left_rows[sy] * (1 - t) + right_rows[sy] * t
    sharp = np.where(valid[..., None], sharp_proj, edge)

    # Quanto cada pixel está fora da janela da foto (horizontalmente)
    outside_h = np.abs(((theta + np.pi) % (2 * np.pi)) - np.pi)[None, :]
    w_h = np.broadcast_to(_smoothstep((outside_h - half_h) / np.radians(40)), (H, W))
    middle = _mix(sharp, edge, w_h)

    # Céu: degradê a partir da borda de cima da foto até a cor do céu sugerida
    top_avg = src[: max(1, ph // 50)].reshape(-1, 3).mean(0)
    sky = _hex_rgb(colors.get("skyTop"), (74, 134, 201))
    ground = _hex_rgb(colors.get("groundColor"), (122, 154, 90))
    t_sky = _smoothstep((lat_full - half_v) / np.radians(35))
    sky_col = _mix(np.broadcast_to(top_avg, (H, W, 3)), np.broadcast_to(sky, (H, W, 3)), t_sky)

    # Acima da foto: a foto esvanece para o céu (transição curta na frente, mais suave nas laterais).
    fade = np.radians(1) + np.radians(11) * w_h
    a_band = (1 - _smoothstep((lat_full - half_v) / fade))[..., None]
    upper = middle * a_band + sky_col * (1 - a_band)

    # Abaixo da foto: gradiente suave da cor do rodapé da foto até a cor do chão sugerida.
    # Sem projeção espelhada: o solo quadrado 3D (piso da foto) cobre a área onde o personagem anda.
    bottom_avg = src[max(0, ph - max(1, ph // 8)):].reshape(-1, 3).mean(0)
    tint_lo = _smoothstep((-lat_full - half_v) / np.radians(60))[..., None]
    lower = np.broadcast_to(bottom_avg, (H, W, 3)).copy() * (1 - tint_lo) \
            + np.broadcast_to(ground, (H, W, 3)) * tint_lo

    out = np.where(below[..., None], lower, upper)

    m = _mode()
    if m == "sd":
        out = _sd_fill(out, w_h, colors)
    elif m == "cv2":
        out = _cv2_fill(out, w_h)

    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(out_path, quality=90)
    return {"width": W, "height": H, "method": m if m in ("sd", "cv2") else "smear"}


def _cv2_fill(pano: np.ndarray, w_h: np.ndarray) -> np.ndarray:
    """Preenche as laterais com inpainting do OpenCV (Telea). Não usa pesos de modelo.

    Mantém a janela da foto intacta. Funciona offline, mas para laterais inteiras o resultado é borrado.
    """
    import cv2

    H, W = pano.shape[:2]
    small = (1024, 512)
    mask = ((w_h > 0.02) * 255).astype(np.uint8)
    img_s = cv2.resize(np.clip(pano, 0, 255).astype(np.uint8), small, interpolation=cv2.INTER_AREA)
    mask_s = cv2.resize(mask, small, interpolation=cv2.INTER_NEAREST)
    filled = cv2.inpaint(img_s, mask_s, 7, cv2.INPAINT_TELEA)
    filled = cv2.resize(filled, (W, H), interpolation=cv2.INTER_CUBIC).astype(np.float32)
    keep = cv2.GaussianBlur(mask.astype(np.float32) / 255.0, (0, 0), 6)[..., None]
    return pano * (1 - keep) + filled * keep


def _sd_fill(pano: np.ndarray, w_h: np.ndarray, colors: dict) -> np.ndarray:
    """NÃO TESTADO AQUI: preenche as laterais com inpainting por difusão.

    Requer: pip install diffusers accelerate, e os pesos do modelo (PHOTO2GAME_OUTPAINT_MODEL,
    padrão stabilityai/stable-diffusion-2-inpainting). Aceita uma pasta local com os pesos.
    Mantém a foto original intacta; só troca a região de fora da janela da foto.
    """
    import torch
    from diffusers import StableDiffusionInpaintPipeline

    model = os.environ.get("PHOTO2GAME_OUTPAINT_MODEL", "stabilityai/stable-diffusion-2-inpainting")
    cuda = torch.cuda.is_available()
    pipe = StableDiffusionInpaintPipeline.from_pretrained(
        model, torch_dtype=torch.float16 if cuda else torch.float32)
    pipe = pipe.to("cuda" if cuda else "cpu")

    H, W = pano.shape[:2]
    base = Image.fromarray(np.clip(pano, 0, 255).astype(np.uint8))
    mask = Image.fromarray((w_h > 0.02).astype(np.uint8) * 255).filter(ImageFilter.GaussianBlur(6))
    small = (1024, 512)
    filled = pipe(prompt="wide photorealistic natural landscape, continuation of the same scene, daylight",
                  negative_prompt="people, text, watermark, seams",
                  image=base.resize(small), mask_image=mask.resize(small),
                  num_inference_steps=25, guidance_scale=7.5).images[0].resize((W, H))

    keep = np.asarray(mask.resize((W, H)), dtype=np.float32)[..., None] / 255.0
    return pano * (1 - keep) + np.asarray(filled, dtype=np.float32) * keep

