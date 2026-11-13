"""Adapters for scene-level geometry and explorable-world services."""
from __future__ import annotations
import base64, os
from pathlib import Path
import requests

ENGINES = {
 "lyra2": {"url_env":"LYRA2_API_URL","token_env":"LYRA2_API_TOKEN","label":"NVIDIA Lyra 2.0","kind":"explorable_world"},
 "vggt": {"url_env":"VGGT_API_URL","token_env":"VGGT_API_TOKEN","label":"Meta VGGT-1B","kind":"scene_geometry"},
}

def run_engine(key: str, image_path: str, output_dir: str) -> dict:
    if key not in ENGINES: raise ValueError("Motor de cena desconhecido.")
    cfg=ENGINES[key]; endpoint=os.getenv(cfg["url_env"])
    if not endpoint: raise RuntimeError(f"Configure {cfg['url_env']} para habilitar {cfg['label']}.")
    out=Path(output_dir); out.mkdir(parents=True,exist_ok=True)
    headers={}; token=os.getenv(cfg["token_env"],"")
    if token: headers["Authorization"]="Bearer "+token
    with open(image_path,"rb") as stream:
        response=requests.post(endpoint,files={"image":(Path(image_path).name,stream,"image/jpeg")},
          data={"model":key,"output_kind":cfg["kind"]},headers=headers,
          timeout=int(os.getenv(key.upper()+"_TIMEOUT","3600")))
    response.raise_for_status()
    if "json" not in response.headers.get("content-type","").lower():
        path=out/(key+"_scene.bin"); path.write_bytes(response.content)
        project_id=out.parents[1].name
        return {"engine":key,"label":cfg["label"],"kind":cfg["kind"],"local_artifact":str(path),
          "artifact_url":"/projects/"+project_id+"/world/"+key+"/"+path.name,"status":"generated"}
    data=response.json(); encoded=data.get("artifact_base64") or data.get("scene_base64")
    artifact_url=data.get("artifact_url") or data.get("scene_url"); local=None
    if encoded:
        fmt=str(data.get("artifact_format") or data.get("format") or "bin").lower().lstrip(".")
        if fmt not in {"glb","ply","splat","spz","mp4","webm","json","zip"}: fmt="bin"
        path=out/(key+"_scene."+fmt); path.write_bytes(base64.b64decode(encoded)); local=str(path)
        artifact_url="/projects/"+out.parents[1].name+"/"+path.relative_to(out.parents[1]).as_posix()
    return {"engine":key,"label":cfg["label"],"kind":data.get("kind",cfg["kind"]),
      "artifact_url":artifact_url,"local_artifact":local,"preview_url":data.get("preview_url"),
      "format":data.get("artifact_format") or data.get("format"),"metadata":data.get("metadata",{}),
      "status":"generated" if artifact_url else "manifest_without_artifact","note":data.get("message","")}
