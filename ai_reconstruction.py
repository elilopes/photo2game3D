"""Semantic image understanding for Photo2Game3D.

Backends:
- local: Transformers image-segmentation pipeline (weights cached locally after first run)
- cloud: Hugging Face Inference API (HF_TOKEN / HUGGINGFACEHUB_API_TOKEN)
- auto: prefer cloud when a token is configured, otherwise local

The module is deliberately optional: failures are reported to the caller and the
legacy OpenCV pipeline remains available as a fallback.
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageFilter

DEFAULT_MODEL = os.environ.get(
    "PHOTO2GAME_SEGMENTATION_MODEL",
    "facebook/mask2former-swin-large-coco-panoptic",
)
_pipeline = None


def mode() -> str:
    requested = os.environ.get("PHOTO2GAME_AI_MODE", "auto").strip().lower()
    if requested in {"local", "cloud"}:
        return requested
    return "cloud" if (os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACEHUB_API_TOKEN")) else "local"


def status() -> dict[str, Any]:
    selected = mode()
    token = bool(os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACEHUB_API_TOKEN"))
    installed = bool(importlib.util.find_spec("torch") and importlib.util.find_spec("transformers"))
    return {
        "mode": selected,
        "model": DEFAULT_MODEL,
        "local_available": installed,
        "cloud_configured": token,
        "available": token if selected == "cloud" else installed,
        "provider": "huggingface-inference" if selected == "cloud" else "transformers-local",
    }


def _local_segments(image: Image.Image):
    global _pipeline
    if _pipeline is None:
        import torch
        from transformers import pipeline
        device = 0 if torch.cuda.is_available() else -1
        _pipeline = pipeline("image-segmentation", model=DEFAULT_MODEL, device=device)
    return _pipeline(image)


def _cloud_segments(image: Image.Image):
    from huggingface_hub import InferenceClient
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACEHUB_API_TOKEN")
    if not token:
        raise RuntimeError("Defina HF_TOKEN para usar PHOTO2GAME_AI_MODE=cloud.")
    client = InferenceClient(model=DEFAULT_MODEL, token=token, timeout=180)
    return client.image_segmentation(image)


def _to_mask(item, size):
    mask = item.get("mask") if isinstance(item, dict) else getattr(item, "mask", None)
    if mask is None:
        return None
    if isinstance(mask, Image.Image):
        return np.asarray(mask.convert("L").resize(size, Image.Resampling.NEAREST)) > 0
    arr = np.asarray(mask)
    if arr.ndim == 3:
        arr = arr[..., 0]
    if arr.shape[::-1] != size:
        arr = np.asarray(Image.fromarray(arr.astype(np.uint8)).resize(size, Image.Resampling.NEAREST))
    return arr > 0


def _value(item, key, default=None):
    return item.get(key, default) if isinstance(item, dict) else getattr(item, key, default)


def analyze(image: Image.Image, output_dir: str) -> dict[str, Any]:
    """Run panoptic/semantic segmentation and persist semantic masks + object boxes."""
    selected = mode()
    if selected == "cloud":
        raw = _cloud_segments(image)
    else:
        raw = _local_segments(image)

    w, h = image.size
    labels: dict[str, np.ndarray] = {}
    objects = []
    aliases = {
        "building": "building", "house": "building", "wall": "building",
        "tree": "tree", "palm": "tree", "plant": "vegetation",
        "grass": "ground", "ground": "ground", "earth": "ground",
        "road": "path", "path": "path", "sidewalk": "path", "floor": "ground",
        "sky": "sky", "door": "door", "window": "window",
    }
    for item in raw or []:
        label = str(_value(item, "label", "object")).strip().lower()
        score = float(_value(item, "score", 1.0) or 1.0)
        mask = _to_mask(item, (w, h))
        if mask is None or not mask.any():
            continue
        canonical = aliases.get(label, label.replace(" ", "_"))
        labels[canonical] = labels.get(canonical, np.zeros((h, w), dtype=bool)) | mask
        ys, xs = np.where(mask)
        objects.append({
            "label": canonical, "source_label": label, "score": round(score, 4),
            "bbox": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
            "area": int(mask.sum()),
            "centroid": [round(float(xs.mean()), 2), round(float(ys.mean()), 2)],
        })

    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    saved = {}
    for name, mask in labels.items():
        # Store binary masks as lossless PNG for later geometry/texture projection.
        path = out / f"mask_{name}.png"
        Image.fromarray((mask * 255).astype(np.uint8)).save(path)
        saved[name] = path.name

    return {
        "provider": status()["provider"], "model": DEFAULT_MODEL,
        "mode": selected, "width": w, "height": h,
        "masks": saved, "objects": objects,
        "labels": sorted(labels),
    }


def extract_house(image: Image.Image, analysis: dict[str, Any], output_dir: str,
                  fov: float = 55.0, eye_height: float = 1.6) -> dict[str, Any] | None:
    """Create a clean AI-segmented facade sprite; preserve the original pixel silhouette."""
    from math import radians, tan
    mask_name = analysis.get("masks", {}).get("building")
    if not mask_name:
        return None
    path = Path(output_dir) / mask_name
    if not path.exists():
        return None
    mask_img = Image.open(path).convert("L")
    mask = np.asarray(mask_img) > 127
    if int(mask.sum()) < image.width * image.height * 0.008:
        return None
    ys, xs = np.where(mask)
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    # Keep mask edges antialiased, but do not morphologically expand into trees/sky.
    crop_mask = mask_img.crop((x0, y0, x1, y1)).filter(ImageFilter.GaussianBlur(0.65))
    rgba = image.convert("RGB").crop((x0, y0, x1, y1)).convert("RGBA")
    rgba.putalpha(crop_mask)
    target = Path(output_dir) / "casa_ai.png"
    rgba.save(target)

    # Approximate pinhole scale. The base row anchors the object on the ground plane.
    focal = image.width / (2.0 * tan(radians(fov / 2.0)))
    base = y1
    distance = focal * eye_height / max(base - image.height / 2.0, 8.0)
    scale = distance / focal
    width_m = (x1 - x0) * scale
    height_m = (y1 - y0) * scale
    center_x = (x0 + x1) / 2.0
    x_m = (center_x - image.width / 2.0) * scale
    return {
        "file": target.name, "width_m": float(width_m), "height_m": float(height_m),
        "dist": float(distance), "x_m": float(x_m), "bbox": [x0, y0, x1, y1],
        "segmentation": "ai",
    }
