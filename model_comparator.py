"""Heuristic validation/ranking of generated GLB candidates.

This score measures mesh integrity and game-readiness, NOT perceptual similarity
to hidden sides of a single input photograph.
"""
from __future__ import annotations
from pathlib import Path
import math

def evaluate_glb(path: str | Path) -> dict:
    import trimesh
    p=Path(path)
    result={"valid":False,"score":0.0,"file":p.name,"bytes":p.stat().st_size if p.exists() else 0}
    if not p.is_file() or p.stat().st_size < 20: return result
    try:
        scene=trimesh.load(str(p),force="scene")
        meshes=[g for g in scene.geometry.values() if isinstance(g,trimesh.Trimesh) and len(g.vertices)>0 and len(g.faces)>0]
        if not meshes: return result
        vertices=sum(len(m.vertices) for m in meshes); faces=sum(len(m.faces) for m in meshes)
        bounds=scene.bounds
        extents=[float(x) for x in (bounds[1]-bounds[0])]
        finite=all(math.isfinite(x) for x in extents) and all(x>1e-6 for x in extents)
        watertight=sum(1 for m in meshes if m.is_watertight)/len(meshes)
        components=sum(len(m.split(only_watertight=False)) for m in meshes)
        # Bounded components/face-count preference avoids rewarding pathological meshes.
        topology=min(1.0,faces/15000.0)
        compact=1.0 if faces<=150000 else max(0.0,1-(faces-150000)/850000)
        score=(0.40*watertight+0.25*topology+0.20*compact+0.15*(1.0 if finite else 0.0))*100
        result.update(valid=finite,score=round(score,2),vertices=vertices,faces=faces,
          components=components,watertight_ratio=round(watertight,3),bounds=extents,
          metrics_kind="geometric_integrity_heuristic")
    except Exception as exc: result["error"]=f"{type(exc).__name__}: {exc}"
    return result

def rank_candidates(candidates: list[dict]) -> list[dict]:
    evaluated=[]
    for item in candidates:
        metric=evaluate_glb(item["path"])
        evaluated.append({**item,"evaluation":metric})
    return sorted(evaluated,key=lambda x:(bool(x["evaluation"].get("valid")),x["evaluation"].get("score",0)),reverse=True)
