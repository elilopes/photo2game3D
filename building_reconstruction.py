"""Procedural volumetric building reconstruction from a single facade photograph.

The front facade is projected as a material reference, while the building body,
side/rear walls, roof and detected architectural openings are real meshes.
Hidden surfaces are inferred; they are not claimed to be recovered from one view.
"""
from __future__ import annotations

import os
from pathlib import Path

import cv2
import numpy as np
import trimesh
from PIL import Image
from trimesh.visual import TextureVisuals
from trimesh.visual.material import PBRMaterial


def _box(scene: trimesh.Scene, name: str, size, center, color):
    mesh = trimesh.creation.box(extents=size)
    mesh.apply_translation(center)
    mesh.visual = trimesh.visual.ColorVisuals(mesh=mesh, face_colors=[*color, 255])
    scene.add_geometry(mesh, node_name=name, geom_name=name)


def _quad(scene: trimesh.Scene, name: str, vertices, faces, uv, material):
    mesh = trimesh.Trimesh(vertices=np.asarray(vertices, dtype=float),
                           faces=np.asarray(faces, dtype=np.int64), process=False)
    mesh.visual = TextureVisuals(uv=np.asarray(uv, dtype=float), material=material)
    scene.add_geometry(mesh, node_name=name, geom_name=name)


def _rect_candidates(gray: np.ndarray, region: tuple[int, int, int, int], aspect_min: float,
                     aspect_max: float, area_min: float, area_max: float):
    x0, y0, x1, y1 = region
    roi = gray[y0:y1, x0:x1]
    if roi.size == 0:
        return []
    edges = cv2.Canny(cv2.GaussianBlur(roi, (5, 5), 0), 35, 110)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    total = max(1, gray.shape[0] * gray.shape[1])
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area = w * h
        ratio = h / max(w, 1)
        if aspect_min <= ratio <= aspect_max and area_min * total <= area <= area_max * total:
            out.append((x + x0, y + y0, x + x0 + w, y + y0 + h, area))
    out.sort(key=lambda r: r[4], reverse=True)
    return out[:8]


def _opening_boxes(image: Image.Image, bbox, width_m, height_m):
    """Estimate door/window rectangles from facade edges; returns conservative candidates."""
    x0, y0, x1, y1 = bbox
    crop = np.asarray(image.convert("RGB"))[y0:y1, x0:x1]
    gray = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY)
    fh, fw = gray.shape
    door_candidates = _rect_candidates(
        gray, (int(fw * .22), int(fh * .35), int(fw * .78), fh),
        1.5, 4.5, .003, .14)
    window_candidates = _rect_candidates(
        gray, (int(fw * .04), int(fh * .08), int(fw * .96), int(fh * .72)),
        .45, 1.8, .0015, .08)
    def convert(r):
        ax, ay, bx, by, _ = r
        return {
            "x": ((ax + bx) / 2 / fw - .5) * width_m,
            "y": height_m * (1 - (ay + by) / 2 / fh),
            "w": (bx - ax) / fw * width_m,
            "h": (by - ay) / fh * height_m,
            "crop": (x0 + ax, y0 + ay, x0 + bx, y0 + by),
        }
    # One most plausible entry and up to four separated window-like regions.
    door = convert(door_candidates[0]) if door_candidates else None
    windows = []
    for r in window_candidates:
        candidate = convert(r)
        if door and abs(candidate["x"] - door["x"]) < (door["w"] + candidate["w"]) * .6:
            continue
        if any(abs(candidate["x"] - v["x"]) < (candidate["w"] + v["w"]) * .45 and
               abs(candidate["y"] - v["y"]) < (candidate["h"] + v["h"]) * .45 for v in windows):
            continue
        windows.append(candidate)
        if len(windows) == 4:
            break
    return door, windows


def build_building(image: Image.Image, analysis: dict, output_dir: str,
                   fov: float = 55.0, eye_height: float = 1.6) -> dict | None:
    """Build a volumetric, textured building GLB using AI facade segmentation + procedural inference."""
    mask_name = (analysis or {}).get("masks", {}).get("building")
    if not mask_name:
        return None
    out = Path(output_dir)
    mask_path = out / mask_name
    if not mask_path.exists():
        return None
    mask_img = Image.open(mask_path).convert("L")
    mask = np.asarray(mask_img) > 127
    if mask.sum() < image.width * image.height * .008:
        return None
    ys, xs = np.where(mask)
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    facade = image.convert("RGB").crop((x0, y0, x1, y1))
    fw, fh = facade.size

    # Perspective scale is approximate. Clamp implausible results for a single-view estimate.
    focal = image.width / (2 * np.tan(np.deg2rad(fov / 2)))
    distance = focal * eye_height / max(y1 - image.height / 2, 8)
    mpp = distance / focal
    width_m = float(np.clip((x1 - x0) * mpp, 2.5, 30.0))
    height_m = float(np.clip((y1 - y0) * mpp, 2.2, 18.0))
    depth_m = float(np.clip(width_m * .55, 2.5, 16.0))
    wall_t = max(.16, width_m * .018)
    roof_h = max(.35, height_m * .18)
    wall_h = height_m - roof_h * .25
    half_w, half_d = width_m / 2, depth_m / 2

    rgb = np.asarray(facade, dtype=np.float32)
    # Robust facade/roof palette samples, avoiding single-pixel noise.
    wall_color = np.clip(np.median(rgb[int(fh*.45):int(fh*.92), int(fw*.08):int(fw*.92)].reshape(-1,3), axis=0),0,255).astype(int)
    roof_color = np.clip(np.median(rgb[:max(1,int(fh*.22))].reshape(-1,3),axis=0),0,255).astype(int)
    back_color = np.clip(wall_color * .88, 0, 255).astype(int)

    scene = trimesh.Scene()
    # Real volume: side walls, rear wall and floor slab.
    _box(scene, "parede_lateral_esquerda", (wall_t, wall_h, depth_m), (-half_w+wall_t/2, wall_h/2, 0), wall_color)
    _box(scene, "parede_lateral_direita", (wall_t, wall_h, depth_m), (half_w-wall_t/2, wall_h/2, 0), wall_color)
    _box(scene, "parede_traseira", (width_m, wall_h, wall_t), (0, wall_h/2, -half_d+wall_t/2), back_color)
    _box(scene, "laje_fundacao", (width_m, .18, depth_m), (0, -.09, 0), back_color)

    # Front facade image as a UV material on a thin, real facade plane.
    rgba = facade.convert("RGBA")
    alpha = mask_img.crop((x0,y0,x1,y1))
    rgba.putalpha(alpha)
    tex = rgba
    mat = PBRMaterial(name="fachada_fotografia", baseColorTexture=tex,
                      metallicFactor=0.0, roughnessFactor=.9, doubleSided=True,
                      alphaMode="BLEND")
    zf = half_d + wall_t * .55
    _quad(scene, "fachada_texturizada",
          [(-half_w,0,zf),(half_w,0,zf),(half_w,wall_h,zf),(-half_w,wall_h,zf)],
          [(0,1,2),(0,2,3)], [(0,0),(1,0),(1,1),(0,1)], mat)

    # Pitched roof with two real sloping planes, ridge running along the building depth.
    ridge_y = wall_h + roof_h
    eave_y = wall_h
    ridge_z = 0.0
    roof_mat = PBRMaterial(name="telhado_estimado", baseColorFactor=[int(roof_color[0]),int(roof_color[1]),int(roof_color[2]),255],
                           metallicFactor=0, roughnessFactor=.88, doubleSided=True)
    _quad(scene, "telhado_agua_esquerda",
          [(-half_w-wall_t,eave_y,half_d+wall_t),(0,ridge_y,half_d+wall_t),(0,ridge_y,-half_d-wall_t),(-half_w-wall_t,eave_y,-half_d-wall_t)],
          [(0,1,2),(0,2,3)], [(0,0),(1,0),(1,1),(0,1)], roof_mat)
    _quad(scene, "telhado_agua_direita",
          [(0,ridge_y,half_d+wall_t),(half_w+wall_t,eave_y,half_d+wall_t),(half_w+wall_t,eave_y,-half_d-wall_t),(0,ridge_y,-half_d-wall_t)],
          [(0,1,2),(0,2,3)], [(0,0),(1,0),(1,1),(0,1)], roof_mat)
    _box(scene, "cumeeira", (max(.08,width_m*.025), .10, depth_m+wall_t*2), (0,ridge_y,0), roof_color)
    _box(scene, "beiral_frontal", (width_m+wall_t*2,.12,.28), (0,wall_h,half_d+.08), roof_color)

    # Add extruded architectural details based on facade rectangles. Texture crops preserve appearance.
    door, windows = _opening_boxes(image, (x0,y0,x1,y1), width_m, wall_h)
    wood = np.array([105,65,38])
    if door:
        dw, dh = min(door["w"],width_m*.32), min(door["h"],wall_h*.92)
        dx, dy = door["x"], max(dh/2,door["y"])
        _box(scene,"porta_volume",(dw,.08,dh),(dx,dy,zf+.055),wood)
        trim=max(.045,width_m*.012)
        for side_x in (-1,1):
            _box(scene,"batente_porta",(trim,.09,dh+trim),(dx+side_x*(dw/2+trim/2),dy,zf+.12),[75,43,25])
        _box(scene,"verga_porta",(dw+trim*2,.09,trim),(dx,dy+dh/2+trim/2,zf+.12),[75,43,25])
        # Door leaf image patch is placed slightly in front of the facade texture.
        cx0,cy0,cx1,cy1=door["crop"]
        patch=image.convert("RGB").crop((cx0,cy0,cx1,cy1)).convert("RGBA")
        pmat=PBRMaterial(name="textura_porta",baseColorTexture=patch,roughnessFactor=.9,doubleSided=True)
        px0,py0,px1,py1=door["crop"]
        u0=(px0-x0)/fw;u1=(px1-x0)/fw;v0=1-(py1-y0)/fh;v1=1-(py0-y0)/fh
        _quad(scene,"folha_porta",
              [(dx-dw/2,dy-dh/2,zf+.17),(dx+dw/2,dy-dh/2,zf+.17),(dx+dw/2,dy+dh/2,zf+.17),(dx-dw/2,dy+dh/2,zf+.17)],
              [(0,1,2),(0,2,3)],[(0,0),(1,0),(1,1),(0,1)],pmat)
        _box(scene,"maca_porta",(max(.035,trim*.55),.04,max(.035,trim*.55)),(dx+dw*.34,dy,zf+.21),[190,155,70])

    for idx, win in enumerate(windows):
        ww, wh = min(win["w"],width_m*.28), min(win["h"],wall_h*.45)
        wx, wy = win["x"], win["y"]
        trim=max(.035,width_m*.009)
        _box(scene,f"janela_vidro_{idx}",(ww,.06,wh),(wx,wy,zf+.07),[80,135,155])
        for sx in (-1,1):
            _box(scene,f"esquadria_vertical_{idx}",(trim,.10,wh+trim),(wx+sx*(ww/2+trim/2),wy,zf+.14),[55,45,35])
        for sy in (-1,1):
            _box(scene,f"esquadria_horizontal_{idx}",(ww+trim,.10,trim),(wx,wy+sy*(wh/2+trim/2),zf+.14),[55,45,35])
        _box(scene,f"divisoria_janela_{idx}",(trim*.65,.12,wh),(wx,wy,zf+.18),[55,45,35])

    # Approximate camera projection position, with building front facing +Z.
    x_center = (x0+x1)/2
    x_m = float((x_center-image.width/2)*mpp)
    glb_path = out / "edificacao_volumetrica.glb"
    scene.export(glb_path, file_type="glb")
    return {
        "file": glb_path.name, "width_m": width_m, "height_m": height_m,
        "depth_m": depth_m, "dist": float(distance), "x_m": x_m,
        "bbox": [x0,y0,x1,y1], "type": "procedural_volumetric",
        "components": [node for node in scene.graph.nodes_geometry],
        "door_detected": bool(door), "windows_detected": len(windows),
    }
