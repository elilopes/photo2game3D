"""Dispatches enabled image-to-3D engines and ranks compatible mesh outputs."""
from __future__ import annotations
import os
from pathlib import Path
import image_to_3d
from model_comparator import rank_candidates

OBJECT_ENGINES=("triposr","instantmesh")
BUILDING_ENGINES=("hunyuan3d21","trellis2")

def _enabled(key: str) -> bool:
    return os.getenv("PHOTO2GAME_ENABLE_"+key.upper(),"1").strip().lower() not in {"0","false","no","off"}

def reconstruct(image, category: str, output_dir: str, name: str) -> dict:
    engines=OBJECT_ENGINES if category=="object" else BUILDING_ENGINES
    out=Path(output_dir); out.mkdir(parents=True,exist_ok=True)
    candidates=[]; failures={}
    for key in engines:
        if not _enabled(key): continue
        try:
            fn=getattr(image_to_3d,"generate_"+key)
            path=fn(image,str(out/key),name)
            candidates.append({"engine":key,"label":key,"path":str(path),"url":f"/projects/{out.parent.name}/{key}/{Path(path).name}"})
        except Exception as exc:
            failures[key]=f"{type(exc).__name__}: {exc}"
    ranked=rank_candidates(candidates)
    winner=next((x for x in ranked if x["evaluation"].get("valid")),None)
    return {"winner":winner,"candidates":ranked,"failures":failures,
      "selection_method":"geometric_integrity_heuristic","perceptual_similarity_evaluated":False}
