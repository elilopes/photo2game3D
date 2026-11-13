"""Persistent per-engine enable/disable settings for Photo2Game3D."""
from __future__ import annotations
import json, os
from pathlib import Path
ROOT=Path(__file__).resolve().parent
SETTINGS_FILE=ROOT/"data"/"ai_model_settings.json"
MODEL_KEYS=("triposr","instantmesh","hunyuan3d21","trellis2","lyra2","vggt")
DEFAULTS={key:True for key in MODEL_KEYS}

def get_settings() -> dict:
    values=dict(DEFAULTS)
    try:
        raw=json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        if isinstance(raw,dict):
            for key in MODEL_KEYS:
                if isinstance(raw.get(key),bool): values[key]=raw[key]
    except (OSError,ValueError,TypeError):
        pass
    return values

def update_settings(changes: dict) -> dict:
    if not isinstance(changes,dict): raise ValueError("As configurações devem ser um objeto.")
    unknown=set(changes)-set(MODEL_KEYS)
    if unknown: raise ValueError("Modelo desconhecido: "+", ".join(sorted(unknown)))
    if any(not isinstance(value,bool) for value in changes.values()):
        raise ValueError("Cada opção deve ser true ou false.")
    values=get_settings(); values.update(changes)
    SETTINGS_FILE.parent.mkdir(parents=True,exist_ok=True)
    temp=SETTINGS_FILE.with_suffix(".tmp")
    temp.write_text(json.dumps(values,indent=2),encoding="utf-8")
    os.replace(temp,SETTINGS_FILE)
    return values

def is_enabled(key: str) -> bool:
    # Explicit choices saved in the UI take precedence over legacy environment flags.
    if SETTINGS_FILE.is_file():
        return get_settings().get(key,False)
    env=os.getenv("PHOTO2GAME_ENABLE_"+key.upper())
    if env is not None:
        return env.strip().lower() not in {"0","false","no","off"}
    return get_settings().get(key,False)
