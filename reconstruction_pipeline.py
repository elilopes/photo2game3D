"""Dispatches enabled image-to-3D engines and ranks compatible mesh outputs."""
from __future__ import annotations
import os
from pathlib import Path
ROOT=Path(__file__).resolve().parent
PROJECTS=ROOT/"projects"
import image_to_3d
import ai_model_settings
from model_comparator import rank_candidates

OBJECT_ENGINES=("sf3d","triposr","instantmesh","spar3d","hunyuan3d21","trellis2")
BUILDING_ENGINES=("hunyuan3d21","trellis2")

def _enabled(key: str) -> bool:
    return ai_model_settings.is_enabled(key)

def reconstruct(image, category: str, output_dir: str, name: str) -> dict:
    engines=OBJECT_ENGINES if category=="object" else BUILDING_ENGINES
    out=Path(output_dir); out.mkdir(parents=True,exist_ok=True)
    candidates=[]; failures={}
    for key in engines:
        if not _enabled(key): continue
        try:
            fn=getattr(image_to_3d,"generate_"+key)
            path=fn(image,str(out/key),name)
            project_id=next((part for part in out.parts if len(part)==8 and all(ch in "0123456789abcdef" for ch in part)),None)
            if not project_id: raise RuntimeError("Não foi possível identificar o projeto para publicar a malha.")
            relative=Path(path).resolve().relative_to((PROJECTS/project_id).resolve())
            candidates.append({"engine":key,"label":key,"path":str(path),"url":f"/projects/{project_id}/{relative.as_posix()}"})
        except Exception as exc:
            failures[key]=f"{type(exc).__name__}: {exc}"
    ranked=rank_candidates(candidates)
    # SF3D tem precedencia quando sua malha passa na validacao geometrica.
    winner=next((x for x in ranked if x["engine"]=="sf3d" and x["evaluation"].get("valid")),None)
    if winner is None:
        winner=next((x for x in ranked if x["evaluation"].get("valid")),None)
    return {"winner":winner,"candidates":ranked,"failures":failures,
      "selection_method":"geometric_integrity_heuristic","perceptual_similarity_evaluated":False}
