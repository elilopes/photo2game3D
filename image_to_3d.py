"""Adapters for Tencent InstantMesh and Hunyuan3D.

Heavy model dependencies live in their own environments/services. Photo2Game3D
communicates with them through subprocesses (InstantMesh) and documented HTTP
APIs (Hunyuan3D), keeping the viewer's Python environment lightweight.
"""
from __future__ import annotations

import base64
import io
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import requests
import trimesh
from PIL import Image


def _mode() -> str:
    value = os.getenv("PHOTO2GAME_3D_MODE", os.getenv("PHOTO2GAME_AI_MODE", "local")).lower()
    return value if value in {"local", "cloud", "off"} else "local"


def _truthy(name: str, default: str = "0") -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "on"}


def status() -> dict[str, Any]:
    mode = _mode()
    instant_dir = Path(os.getenv("INSTANTMESH_DIR", "models/InstantMesh"))
    instant_python = os.getenv("INSTANTMESH_PYTHON", sys.executable)
    instant_local = (instant_dir / "run.py").is_file() and shutil.which(instant_python) is not None
    instant_remote = bool(os.getenv("INSTANTMESH_API_URL"))
    hy_url = os.getenv("HUNYUAN3D_API_URL", "http://127.0.0.1:8081/generate")
    hy_remote = hy_url.startswith(("http://", "https://"))
    return {
        "mode": mode,
        "instantmesh": {
            "provider": "http-api" if mode == "cloud" else "subprocess",
            "local_configured": instant_local,
            "remote_configured": instant_remote,
            "ready": instant_remote if mode == "cloud" else instant_local,
            "repository": "https://github.com/TencentARC/InstantMesh",
        },
        "hunyuan3d": {
            "provider": "http-api",
            "endpoint_configured": hy_remote,
            "ready": hy_remote,
            "endpoint": hy_url,
            "repository": "https://github.com/Tencent-Hunyuan/Hunyuan3D-2",
            "license": "Tencent Hunyuan Community License (review terms before commercial use)",
        },
    }


def _white_background(image: Image.Image, size: tuple[int, int] | None = None) -> Image.Image:
    rgba = image.convert("RGBA")
    bg = Image.new("RGBA", rgba.size, (245, 245, 245, 255))
    bg.alpha_composite(rgba)
    result = bg.convert("RGB")
    if size:
        result.thumbnail(size, Image.Resampling.LANCZOS)
    return result


def _to_glb(source: Path, target: Path) -> Path:
    if source.suffix.lower() == ".glb":
        if source != target:
            shutil.copy2(source, target)
        return target
    loaded = trimesh.load(str(source), force="scene", process=False)
    if isinstance(loaded, trimesh.Trimesh):
        loaded = trimesh.Scene(loaded)
    if not loaded.geometry:
        raise RuntimeError(f"Modelo sem geometria: {source}")
    target.parent.mkdir(parents=True, exist_ok=True)
    loaded.export(str(target), file_type="glb")
    return target


def _remote_glb(url: str, image: Image.Image, output: Path, *, token: str = "",
                timeout: int = 900, model: str = "") -> Path:
    buffer = io.BytesIO()
    _white_background(image).save(buffer, format="PNG")
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    files = {"image": ("input.png", buffer.getvalue(), "image/png")}
    data = {"model": model} if model else None
    response = requests.post(url, files=files, data=data, headers=headers, timeout=timeout)
    response.raise_for_status()
    content_type = response.headers.get("content-type", "").lower()
    if "json" in content_type:
        payload = response.json()
        encoded = payload.get("glb_base64") or payload.get("model_base64")
        if not encoded:
            raise RuntimeError(f"API Image-to-3D não retornou GLB: {payload}")
        output.write_bytes(base64.b64decode(encoded))
    else:
        output.write_bytes(response.content)
    if output.stat().st_size < 16 or output.read_bytes()[:4] != b"glTF":
        raise RuntimeError("A API remota não retornou um arquivo GLB válido.")
    return output


def generate_instantmesh(image: Image.Image, output_dir: str, name: str) -> Path:
    """Generate one isolated object mesh with local InstantMesh or configured cloud endpoint."""
    mode = _mode()
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    target = out / f"{name}.glb"

    if mode == "off":
        raise RuntimeError("Motores Image-to-3D desativados.")

    if mode == "cloud":
        endpoint = os.getenv("INSTANTMESH_API_URL")
        if not endpoint:
            raise RuntimeError("Defina INSTANTMESH_API_URL para InstantMesh na nuvem.")
        return _remote_glb(endpoint, image, target,
                           token=os.getenv("INSTANTMESH_API_TOKEN", ""),
                           timeout=int(os.getenv("INSTANTMESH_TIMEOUT", "900")),
                           model=os.getenv("INSTANTMESH_MODEL", "instant-mesh-large"))

    root = Path(os.getenv("INSTANTMESH_DIR", "models/InstantMesh")).resolve()
    python = os.getenv("INSTANTMESH_PYTHON", sys.executable)
    config = os.getenv("INSTANTMESH_CONFIG", "configs/instant-mesh-large.yaml")
    runner = root / "run.py"
    config_path = Path(config)
    if not config_path.is_absolute():
        config_path = root / config_path
    if not runner.is_file() or not config_path.is_file():
        raise RuntimeError(
            f"InstantMesh local não encontrado. Configure INSTANTMESH_DIR (checkout oficial) e INSTANTMESH_PYTHON. Procurado: {runner}"
        )
    input_path = out / f"{name}_input.png"
    _white_background(image).save(input_path)
    output_root = out / "instantmesh_output"
    command = [
        python, str(runner), str(config_path), str(input_path),
        "--output_path", str(output_root), "--no_rembg", "--export_texmap",
    ]
    subprocess.run(command, cwd=str(root), check=True,
                   timeout=int(os.getenv("INSTANTMESH_TIMEOUT", "1800")))
    mesh_obj = output_root / config_path.stem / "meshes" / f"{input_path.stem}.obj"
    if not mesh_obj.is_file():
        raise RuntimeError(f"InstantMesh terminou sem produzir o OBJ esperado: {mesh_obj}")
    return _to_glb(mesh_obj, target)


def generate_hunyuan3d(image: Image.Image, output_dir: str, name: str,
                       *, texture: bool = True) -> Path:
    """Call Tencent's Hunyuan3D API server; works with a local or cloud endpoint."""
    if _mode() == "off":
        raise RuntimeError("Motores Image-to-3D desativados.")
    endpoint = os.getenv("HUNYUAN3D_API_URL", "http://127.0.0.1:8081/generate")
    token = os.getenv("HUNYUAN3D_API_TOKEN", "")
    output = Path(output_dir) / f"{name}.glb"
    output.parent.mkdir(parents=True, exist_ok=True)

    buffer = io.BytesIO()
    _white_background(image, (1024, 1024)).save(buffer, format="PNG")
    payload = {
        "image": base64.b64encode(buffer.getvalue()).decode("ascii"),
        "type": "glb",
        "texture": bool(texture),
        "octree_resolution": int(os.getenv("HUNYUAN3D_OCTREE_RESOLUTION", "256")),
        "num_inference_steps": int(os.getenv("HUNYUAN3D_STEPS", "5")),
        "face_count": int(os.getenv("HUNYUAN3D_FACE_COUNT", "40000")),
    }
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    response = requests.post(endpoint, json=payload, headers=headers,
                             timeout=int(os.getenv("HUNYUAN3D_TIMEOUT", "1800")))
    response.raise_for_status()
    if "json" in response.headers.get("content-type", "").lower():
        result = response.json()
        encoded = result.get("model_base64") or result.get("glb_base64")
        if not encoded:
            raise RuntimeError(f"Hunyuan3D não retornou GLB: {result}")
        output.write_bytes(base64.b64decode(encoded))
    else:
        output.write_bytes(response.content)
    if output.stat().st_size < 16 or output.read_bytes()[:4] != b"glTF":
        raise RuntimeError("Hunyuan3D não retornou um arquivo GLB válido.")
    return output
