"""Download and import official Image-to-3D model files into ./models."""
from __future__ import annotations
import os
import shutil
import subprocess
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent
MODELS = ROOT / "models"
CATALOG = {
    "instantmesh": {
        "label": "InstantMesh",
        "repo": "https://github.com/TencentARC/InstantMesh.git",
        "directory": "InstantMesh",
        "hf_repo": "TencentARC/InstantMesh",
    },
    "hunyuan3d": {
        "label": "Hunyuan3D-2",
        "directory": "Hunyuan3D-2",
        "repo": "https://github.com/Tencent-Hunyuan/Hunyuan3D-2.git",
        "hf_repo": "tencent/Hunyuan3D-2",
    },
}

def _recognized(name: str, path: Path) -> bool:
    """Recognize a model only when code structure and model weights are present."""
    if not path.is_dir():
        return False
    suffixes = {'.safetensors', '.ckpt', '.pth', '.pt', '.bin'}
    has_weights = any(p.is_file() and p.suffix.lower() in suffixes for p in path.rglob('*'))
    if name == 'instantmesh':
        has_code = (path / 'run.py').is_file() and ((path / 'pretrained_weights').is_dir() or (path / 'weights').is_dir())
    else:
        has_code = (path / 'api_server.py').is_file() or (path / 'hy3dgen').is_dir()
    return has_code and has_weights


def model_status():
    result = {}
    for key, item in CATALOG.items():
        path = MODELS / item['directory']
        files = [p for p in path.rglob('*') if p.is_file()] if path.exists() else []
        result[key] = {'label': item['label'], 'path': str(path), 'exists': path.exists(),
                       'recognized': _recognized(key, path),
                       'size_bytes': sum(p.stat().st_size for p in files)}
    return result

def download_model(name: str):
    if name not in CATALOG:
        raise ValueError("Modelo não reconhecido.")
    item = CATALOG[name]
    target = MODELS / item["directory"]
    MODELS.mkdir(parents=True, exist_ok=True)
    if name == "instantmesh":
        if not (target / "run.py").exists():
            git = shutil.which("git")
            if not git:
                raise RuntimeError("Git não encontrado. Instale Git for Windows e tente novamente.")
            subprocess.run([git, "clone", "--depth", "1", item["repo"], str(target)],
                           check=True, timeout=1800)
        # Pesos são distribuídos no Hugging Face; manter separados do código.
        from huggingface_hub import snapshot_download
        snapshot_download(repo_id=item["hf_repo"], local_dir=str(target / "pretrained_weights"))
    else:
        if not (target / "api_server.py").exists():
            git = shutil.which("git")
            if not git:
                raise RuntimeError("Git não encontrado. Instale Git for Windows e tente novamente.")
            subprocess.run([git, "clone", "--depth", "1", item["repo"], str(target)],
                           check=True, timeout=1800)
        from huggingface_hub import snapshot_download
        snapshot_download(repo_id=item["hf_repo"], local_dir=str(target / "weights"))
    return model_status()[name]

def import_model_files(name: str, files):
    if name not in CATALOG:
        raise ValueError("Modelo não reconhecido.")
    target = MODELS / CATALOG[name]["directory"]
    count = 0
    for uploaded in files:
        rel = uploaded.filename.replace("\\", "/")
        parts = PurePosixPath(rel).parts
        if not rel or rel.startswith("/") or any(p in ("", ".", "..") for p in parts):
            raise ValueError(f"Caminho de arquivo inválido: {uploaded.filename}")
        # Navegadores podem enviar caminho completo da pasta selecionada; descarta o primeiro nível.
        if len(parts) > 1:
            parts = parts[1:]
        if not parts:
            continue
        dest = target.joinpath(*parts).resolve()
        if target.resolve() not in dest.parents:
            raise ValueError("Caminho de destino fora da pasta de modelos.")
        dest.parent.mkdir(parents=True, exist_ok=True)
        uploaded.save(dest)
        count += 1
    return {"model": name, "path": str(target), "files_imported": count}
