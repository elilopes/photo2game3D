"""Profundidade + foto -> relevo 3D texturizado (GLB) e malha de colisão leve.

Convenção (igual à do viewer): Y para cima, a câmera da foto fica em +Z olhando para -Z.
O relevo é centrado em X=0 e apoiado em Y=0; a parte mais próxima da foto fica em Z≈0.
"""
import numpy as np
import trimesh
from PIL import Image
from trimesh.visual import TextureVisuals
from trimesh.visual.material import PBRMaterial


def _axis(n: int, step: int) -> np.ndarray:
    idx = np.arange(0, n, step)
    return idx if idx[-1] == n - 1 else np.append(idx, n - 1)


def _grid_mesh(depth, width_m, height_m, depth_m, step, jump_ratio):
    """Cada amostra da grade vira um vértice. Triângulos que cruzam saltos grandes de
    profundidade são descartados (evita 'pontes de borracha' nas bordas dos objetos)."""
    h, w = depth.shape
    ys, xs = _axis(h, step), _axis(w, step)
    d = depth[np.ix_(ys, xs)]
    gh, gw = d.shape

    x = (xs[None, :] / (w - 1) - 0.5) * width_m + np.zeros((gh, 1))
    y = (1 - ys[:, None] / (h - 1)) * height_m + np.zeros((1, gw))
    z = -(1.0 - d) * depth_m
    verts = np.stack([x, y, z], -1).reshape(-1, 3)

    idx = np.arange(gh * gw).reshape(gh, gw)
    a, b = idx[:-1, :-1].ravel(), idx[:-1, 1:].ravel()
    c, e = idx[1:, :-1].ravel(), idx[1:, 1:].ravel()
    faces = np.concatenate([np.stack([a, c, b], 1), np.stack([b, c, e], 1)])

    if jump_ratio is not None:
        zs = z.ravel()[faces]
        faces = faces[(zs.max(1) - zs.min(1)) < jump_ratio * depth_m]

    uv = np.stack([
        xs[None, :] / (w - 1) + np.zeros((gh, 1)),
        1 - ys[:, None] / (h - 1) + np.zeros((1, gw)),
    ], -1).reshape(-1, 2)
    return verts, faces, uv


def build_relief(img: Image.Image, depth: np.ndarray, width_m: float = 12.0, depth_m: float = 4.0,
                 visual_cells: int = 320, proxy_cells: int = 90, jump_ratio: float = 0.12):
    """Devolve (trimesh.Scene, info). A cena tem dois nós:
       'relevo'      malha visual com a foto como textura;
       'relevo_col'  malha leve, sem buracos, usada só para colisão (o viewer a esconde)."""
    h, w = depth.shape
    height_m = width_m * h / w
    longest = max(w, h)

    tex = img.copy()
    tex.thumbnail((2048, 2048))

    v, f, uv = _grid_mesh(depth, width_m, height_m, depth_m, max(1, round(longest / visual_cells)), jump_ratio)
    visual = trimesh.Trimesh(vertices=v, faces=f, process=False)
    visual.visual = TextureVisuals(uv=uv, material=PBRMaterial(
        baseColorTexture=tex, metallicFactor=0.0, roughnessFactor=1.0, doubleSided=True))
    visual.remove_unreferenced_vertices()

    pv, pf, _ = _grid_mesh(depth, width_m, height_m, depth_m, max(1, round(longest / proxy_cells)), None)
    proxy = trimesh.Trimesh(vertices=pv, faces=pf, process=False)

    scene = trimesh.Scene()
    scene.add_geometry(visual, node_name="relevo", geom_name="relevo")
    scene.add_geometry(proxy, node_name="relevo_col", geom_name="relevo_col")

    info = dict(width_m=width_m, height_m=round(height_m, 3), depth_m=depth_m,
                triangles=int(len(visual.faces)), collision_triangles=int(len(proxy.faces)))
    return scene, info


def _hex(rgb) -> str:
    r, g, b = (int(round(float(c))) for c in rgb)
    return f"#{r:02x}{g:02x}{b:02x}"


def sample_colors(img: Image.Image) -> dict:
    """Cores sugeridas a partir da foto: chão (base da imagem) e céu (topo e meio-alto)."""
    a = np.asarray(img.convert("RGB").resize((64, 64)), dtype=np.float32)
    return dict(
        groundColor=_hex(a[-5:].reshape(-1, 3).mean(0)),
        skyTop=_hex(a[:4].reshape(-1, 3).mean(0)),
        skyHorizon=_hex(a[16:26].reshape(-1, 3).mean(0)),
    )

