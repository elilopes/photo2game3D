"""Estimativa de profundidade: foto -> mapa (H, W) em [0, 1], onde 1 = mais perto da câmera.

Backends:
  - "ai"        Depth Anything V2 (precisa de torch + transformers). É o modo de produção.
  - "heuristic" rampa simples (embaixo = perto, em cima = longe). SÓ para testar o sistema
                sem baixar a IA; ative com a variável PHOTO2GAME_DEPTH=heuristic.
"""
import importlib.util
import os

import numpy as np
from PIL import Image

MODEL_ID = os.environ.get("PHOTO2GAME_MODEL", "depth-anything/Depth-Anything-V2-Small-hf")

_pipe = None  # o modelo é carregado uma única vez e reaproveitado


class DepthBackendMissing(RuntimeError):
    """Nenhum backend de profundidade disponível."""


def available_backend() -> str:
    if os.environ.get("PHOTO2GAME_DEPTH", "").lower() == "heuristic":
        return "heuristic"
    if importlib.util.find_spec("torch") and importlib.util.find_spec("transformers"):
        return "ai"
    return "missing"


def _get_pipe():
    global _pipe
    if _pipe is None:
        import torch
        from transformers import pipeline

        device = 0 if torch.cuda.is_available() else -1
        _pipe = pipeline("depth-estimation", model=MODEL_ID, device=device)
    return _pipe


def _smooth(d: np.ndarray, passes: int = 2) -> np.ndarray:
    """Média 3x3 repetida: tira o ruído que deixaria o chão 'esburacado' para a colisão."""
    for _ in range(passes):
        p = np.pad(d, 1, mode="edge")
        d = sum(p[y:y + d.shape[0], x:x + d.shape[1]] for y in range(3) for x in range(3)) / 9.0
    return d


def _normalize(d: np.ndarray) -> np.ndarray:
    return (d - d.min()) / (d.max() - d.min() + 1e-8)


def estimate_depth(image_path: str) -> np.ndarray:
    backend = available_backend()
    img = Image.open(image_path).convert("RGB")
    w, h = img.size

    if backend == "missing":
        raise DepthBackendMissing(
            "Modelo de profundidade não instalado. Rode: pip install torch transformers "
            "(ou use PHOTO2GAME_DEPTH=heuristic só para testar sem IA)."
        )

    if backend == "heuristic":
        ramp = np.linspace(0.0, 1.0, h, dtype=np.float32) ** 1.4
        return _smooth(_normalize(np.tile(ramp[:, None], (1, w))), 3)

    import torch

    # O modelo trabalha em resolução baixa: reduzir antes evita inferir sobre a foto inteira (lento na CPU)
    lado = 518
    if max(w, h) > lado:
        k = lado / max(w, h)
        small = img.resize((max(1, round(w * k)), max(1, round(h * k))), Image.BILINEAR)
    else:
        small = img
    print(f"[profundidade] entrada {small.size}, dispositivo {'GPU' if torch.cuda.is_available() else 'CPU'}, "
          f"threads {torch.get_num_threads()}", flush=True)
    pred = _get_pipe()(small)["predicted_depth"]
    pred = torch.nn.functional.interpolate(
        pred.reshape(1, 1, *pred.shape[-2:]).float(), size=(h, w),
        mode="bilinear", align_corners=False,
    )[0, 0].cpu().numpy()
    return _smooth(_normalize(pred), 2)
