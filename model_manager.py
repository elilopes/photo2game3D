"""Download/import registry for optional Photo2Game3D AI engines."""
from __future__ import annotations
import os
import shutil
import subprocess
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent
MODELS = ROOT / "models"
CATALOG = {
    "triposr": {"label":"TripoSR", "directory":"TripoSR", "repo":"https://github.com/VAST-AI-Research/TripoSR.git", "hf_repo":"stabilityai/TripoSR", "kind":"object"},
    "instantmesh": {"label":"InstantMesh", "directory":"InstantMesh", "repo":"https://github.com/TencentARC/InstantMesh.git", "hf_repo":"TencentARC/InstantMesh", "kind":"object"},
    "hunyuan3d21": {"label":"Tencent Hunyuan3D-2.1", "directory":"Hunyuan3D-2.1", "repo":"https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1.git", "hf_repo":"tencent/Hunyuan3D-2.1", "kind":"building"},
    "trellis2": {"label":"Microsoft TRELLIS.2-4B", "directory":"TRELLIS.2", "repo":"https://github.com/microsoft/TRELLIS.2.git", "hf_repo":"microsoft/TRELLIS.2-4B", "kind":"building"},
    "lyra2": {"label":"NVIDIA Lyra 2.0", "directory":"Lyra", "repo":"https://github.com/nv-tlabs/lyra.git", "hf_repo":"nvidia/Lyra-2.0", "kind":"world"},
    "vggt": {"label":"Meta VGGT-1B", "directory":"VGGT", "repo":"https://github.com/facebookresearch/vggt.git", "hf_repo":"facebook/VGGT-1B", "kind":"geometry"},
}

def _has_weights(path: Path) -> bool:
    suffixes={'.safetensors','.ckpt','.pth','.pt','.bin'}
    return any(p.is_file() and p.suffix.lower() in suffixes for p in path.rglob('*'))

def _recognized(name: str, path: Path) -> bool:
    if not path.is_dir(): return False
    markers = {
      "triposr": (path/"run.py").is_file(),
      "instantmesh": (path/"run.py").is_file() and ((path/"pretrained_weights").exists() or (path/"weights").exists()),
      "hunyuan3d21": (path/"gradio_app.py").is_file() and (path/"hy3dshape").is_dir(),
      "trellis2": (path/"app.py").is_file() and (path/"trellis2").is_dir(),
      "lyra2": (path/"Lyra-2").is_dir(),
      "vggt": (path/"vggt").is_dir(),
    }
    # Lyra is a multi-stage world pipeline; source presence is distinct from checkpoint readiness.
    return bool(markers.get(name)) and (_has_weights(path) if name != "lyra2" else True)

def model_status():
    result={}
    for key,item in CATALOG.items():
        path=MODELS/item["directory"]
        files=[p for p in path.rglob('*') if p.is_file()] if path.exists() else []
        result[key]={"label":item["label"],"path":str(path),"exists":path.exists(),
          "recognized":_recognized(key,path),"size_bytes":sum(p.stat().st_size for p in files),
          "kind":item["kind"],"repository":item["repo"],"hf_repo":item["hf_repo"]}
    return result

def download_model(name: str):
    if name not in CATALOG: raise ValueError("Modelo não reconhecido.")
    item=CATALOG[name]; target=MODELS/item["directory"]; MODELS.mkdir(parents=True,exist_ok=True)
    git=shutil.which("git")
    if not git: raise RuntimeError("Git não encontrado. Instale Git for Windows e tente novamente.")
    if not target.exists():
        cmd=[git,"clone","--depth","1"]
        if name=="trellis2": cmd += ["--recursive"]
        cmd += [item["repo"],str(target)]
        subprocess.run(cmd,check=True,timeout=3600)
    from huggingface_hub import snapshot_download
    # Each repository is kept in its own directory; Lyra checkpoints can be very large.
    weights_dir = target/("pretrained_weights" if name=="instantmesh" else "checkpoints")
    snapshot_download(repo_id=item["hf_repo"],local_dir=str(weights_dir))
    return model_status()[name]

def import_model_files(name: str, files):
    if name not in CATALOG: raise ValueError("Modelo não reconhecido.")
    target=MODELS/CATALOG[name]["directory"]; count=0
    for uploaded in files:
        rel=uploaded.filename.replace("\\","/")
        parts=PurePosixPath(rel).parts
        if not rel or rel.startswith("/") or any(p in ("",".","..") for p in parts):
            raise ValueError(f"Caminho de arquivo inválido: {uploaded.filename}")
        if len(parts)>1: parts=parts[1:]
        if not parts: continue
        dest=target.joinpath(*parts).resolve()
        if target.resolve() not in dest.parents: raise ValueError("Caminho de destino fora da pasta de modelos.")
        dest.parent.mkdir(parents=True,exist_ok=True); uploaded.save(dest); count+=1
    return {"model":name,"path":str(target),"files_imported":count}
