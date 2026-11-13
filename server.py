"""photo2game — servidor local.

    python server.py            ->  http://localhost:5000

Variáveis de ambiente (opcionais):
    BLENDER=/caminho/blender    executável do Blender (para gerar FBX e .blend)
    PORT=5000                   porta
    PHOTO2GAME_DEPTH=heuristic  modo SEM IA, só para testar o sistema (qualidade baixa)

Fluxo: foto -> /api/generate -> viewer testa o ambiente -> botão Exportar -> o VIEWER monta o GLB
a partir da cena ao vivo e envia para /api/export, que apenas converte para os outros formatos.
"""
import glob
import importlib.util
import json
import mimetypes
import os
import pathlib
import re
import shutil
import time
import subprocess
import sys
import uuid
import zipfile

from flask import Flask, abort, jsonify, request, send_from_directory
from PIL import Image, ImageOps
from werkzeug.exceptions import HTTPException

import depth as depthmod
from mesh_builder import build_relief, sample_colors
from panorama import build_panorama
import scene_assets
import photo_enhance
import ai_reconstruction
import building_reconstruction
import image_to_3d

# No Windows o registro às vezes devolve text/plain para .js e o navegador recusa os módulos.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("model/gltf-binary", ".glb")

ROOT = pathlib.Path(__file__).resolve().parent
VIEWER = ROOT / "viewer"
PROJECTS = ROOT / "projects"
PID_RE = re.compile(r"^[0-9a-f]{8}$")

PROJECTS.mkdir(exist_ok=True)
app = Flask(__name__, static_folder=str(VIEWER), static_url_path="")
app.config.update(MAX_CONTENT_LENGTH=256 * 1024 * 1024, SEND_FILE_MAX_AGE_DEFAULT=0)


@app.errorhandler(Exception)
def on_error(exc):
    if isinstance(exc, HTTPException):
        return jsonify(error=exc.description), exc.code
    app.logger.exception(exc)
    return jsonify(error=f"{type(exc).__name__}: {exc}"), 500


def project_dir(pid: str) -> pathlib.Path:
    if not PID_RE.match(pid):
        abort(404, "Projeto inválido.")
    p = PROJECTS / pid
    if not p.is_dir():
        abort(404, "Projeto não encontrado.")
    return p


def find_blender():
    cands = [os.environ.get("BLENDER"), shutil.which("blender"),
             "/Applications/Blender.app/Contents/MacOS/Blender"]
    cands += sorted(glob.glob(r"C:\Program Files\Blender Foundation\Blender *\blender.exe"), reverse=True)
    return next((c for c in cands if c and os.path.exists(c)), None)


def converter_command(src: pathlib.Path, out: pathlib.Path):
    script = str(ROOT / "convert_export.py")
    exe = find_blender()
    if exe:
        return [exe, "-b", "--factory-startup", "-P", script, "--", str(src), str(out)]
    if importlib.util.find_spec("bpy"):  # módulo bpy instalado via pip
        return [sys.executable, script, "--", str(src), str(out)]
    return None


@app.get("/")
def index():
    return send_from_directory(VIEWER, "index.html")


@app.get("/api/status")
def status():
    return jsonify(depth=depthmod.available_backend(),
                   ai=ai_reconstruction.status(),
                   image_to_3d=image_to_3d.status(),
                   converter=converter_command(ROOT, ROOT) is not None,
                   enhance=photo_enhance.available_enhancements())


@app.get("/projects/<pid>/<path:name>")
def project_file(pid, name):
    return send_from_directory(project_dir(pid), name)


@app.post("/api/generate")
def generate():
    t_inicio = time.perf_counter()
    f = request.files.get("image")
    if f is None:
        abort(400, "Envie a foto no campo 'image'.")
    try:
        img = ImageOps.exif_transpose(Image.open(f.stream)).convert("RGB")
    except Exception:
        abort(400, "Não consegui abrir esse arquivo como imagem.")
    img.thumbnail((2048, 2048))
    img = photo_enhance.preprocess(img)   # super-resolução + melhora de luz (fallback automático)

    pid = uuid.uuid4().hex[:8]
    proj = PROJECTS / pid
    proj.mkdir(parents=True)
    t_ref = [time.perf_counter()]

    def marca(nome):   # imprime o tempo da etapa e o acumulado no terminal
        agora = time.perf_counter()
        print(f"[geração {pid}] {nome}: {agora - t_ref[0]:.1f} s (total {agora - t_inicio:.1f} s)", flush=True)
        t_ref[0] = agora

    try:
        marca("pré-processamento da foto (super-resolução e luz)")
        photo = proj / "foto.jpg"
        img.save(photo, quality=92)
        depth = depthmod.estimate_depth(str(photo))
        marca("profundidade (modelo de IA)")

        semantic = None
        try:
            semantic = ai_reconstruction.analyze(img, str(proj / "semantica"))
            meta_semantic = semantic
            marca("segmentação semântica concluída")
        except Exception as exc:
            app.logger.warning("segmentação IA indisponível; usando fallback OpenCV: %s", exc)
            meta_semantic = {"available": False, "error": str(exc), "requested_mode": ai_reconstruction.mode()}
        scene, info = build_relief(img, depth)
        (proj / "cenario.glb").write_bytes(scene.export(file_type="glb"))
        marca("relevo e exportação do GLB")
        suggest = sample_colors(img)
        pano_info = build_panorama(img, suggest, str(proj / "panorama.jpg"))
        marca("cores e panorama")
        meta = dict(id=pid, relief=info, suggest=suggest, depth_backend=depthmod.available_backend(),
                    ai_scene=meta_semantic, panorama=f"/projects/{pid}/panorama.jpg", panorama_info=pano_info)

        # Contexto da foto (rural/urban/beach/snow/mixed) — ajusta objetos no viewer
        try:
            context = scene_assets.sample_context(img)
        except Exception:
            context = 'mixed'
        meta['context'] = context
        marca("classificação do contexto")

        # Piso retificado e árvores recortadas da foto
        fov = 55.0
        try:
            gl = scene_assets.detect_ground_row(img)
        except Exception:
            gl = None

        if gl is not None:
            try:
                tile_img, wm, dm = scene_assets.floor_tile(img, gl, fov=fov)
                tile_path = proj / "piso.jpg"
                tile_img.save(tile_path, quality=90)
                meta["floor"] = dict(url=f"/projects/{pid}/piso.jpg", width_m=wm, depth_m=dm)
            except Exception as exc:
                app.logger.warning("floor_tile falhou: %s", exc)

        try:
            tree_list = []
            if context not in ("urban", "alpine", "indoor", "cave"):
                tree_list = ai_reconstruction.extract_trees(
                    img, semantic, str(proj / "semantica"), fov=fov
                ) if semantic else []
            trees_meta = []
            max_trees = int(os.getenv("PHOTO2GAME_MAX_INSTANTMESH_TREES", "4"))
            for idx, tree in enumerate(tree_list[:max_trees]):
                sprite_path = proj / "semantica" / "trees" / tree["file"]
                try:
                    with Image.open(sprite_path) as tree_image:
                        glb = image_to_3d.generate_instantmesh(
                            tree_image, str(proj / "instantmesh" / "trees"), f"tree_{idx}"
                        )
                    trees_meta.append(dict(
                        model_url=f"/projects/{pid}/instantmesh/trees/{glb.name}",
                        width_m=tree["width_m"], height_m=tree["height_m"],
                        x_m=tree["x_m"], z_m=tree["z_m"], bbox=tree["bbox"],
                        reconstruction="instantmesh"
                    ))
                    marca(f"InstantMesh árvore {idx + 1}/{min(len(tree_list), max_trees)}")
                except Exception as exc:
                    app.logger.warning("InstantMesh falhou para árvore %s; usando billboard: %s", idx, exc)
                    trees_meta.append(dict(
                        url=f"/projects/{pid}/semantica/trees/{tree['file']}",
                        width_m=tree["width_m"], height_m=tree["height_m"],
                        x_m=tree["x_m"], z_m=tree["z_m"], bbox=tree["bbox"],
                        reconstruction="billboard_fallback"
                    ))

            if trees_meta:
                meta["trees"] = trees_meta
            else:
                gl_veg = gl if gl is not None else int(img.size[1] * 0.60)
                fallback_trees = scene_assets.extract_trees(img, gl_veg, str(proj / "arvores"), fov=fov)
                meta["trees"] = [
                    dict(url=f"/projects/{pid}/arvores/{t['file']}",
                         width_m=t["width_m"], height_m=t["height_m"],
                         reconstruction="opencv_billboard")
                    for t in fallback_trees
                ]
        except Exception as exc:
            app.logger.warning("extração/reconstrução de árvores falhou: %s", exc)

        # Outros objetos segmentados (mobiliário, veículos, animais etc.) também viram malhas.
        try:
            object_list = ai_reconstruction.extract_objects(
                img, semantic, str(proj / "semantica"), fov=fov,
                max_objects=int(os.getenv("PHOTO2GAME_MAX_INSTANTMESH_OBJECTS", "4"))
            ) if semantic else []
            object_meta = []
            for idx, obj in enumerate(object_list):
                sprite_path = proj / "semantica" / "objects" / obj["file"]
                try:
                    with Image.open(sprite_path) as object_image:
                        glb = image_to_3d.generate_instantmesh(
                            object_image, str(proj / "instantmesh" / "objects"),
                            f"object_{idx}_{re.sub(r'[^a-z0-9]+', '_', obj['label'].lower())[:24]}"
                        )
                    object_meta.append(dict(
                        model_url=f"/projects/{pid}/instantmesh/objects/{glb.name}",
                        width_m=obj["width_m"], height_m=obj["height_m"],
                        x_m=obj["x_m"], z_m=obj["z_m"], bbox=obj["bbox"],
                        label=obj["label"], reconstruction="instantmesh"
                    ))
                except Exception as exc:
                    app.logger.warning("InstantMesh falhou para objeto %s: %s", obj["label"], exc)
                    object_meta.append(dict(
                        url=f"/projects/{pid}/semantica/objects/{obj['file']}",
                        width_m=obj["width_m"], height_m=obj["height_m"],
                        x_m=obj["x_m"], z_m=obj["z_m"], bbox=obj["bbox"],
                        label=obj["label"], reconstruction="billboard_fallback"
                    ))
            if object_meta:
                meta["photo_objects"] = object_meta
        except Exception as exc:
            app.logger.warning("extração/reconstrução de objetos falhou: %s", exc)

        marca("árvores e objetos 3D")

        # Hunyuan3D gera a malha da edificação; o modelo procedural é fallback.
        try:
            facade = ai_reconstruction.extract_house(
                img, semantic, str(proj / "semantica"), fov=fov
            ) if semantic else None
            if facade:
                facade_path = proj / "semantica" / facade["file"]
                try:
                    with Image.open(facade_path) as facade_image:
                        glb = image_to_3d.generate_hunyuan3d(
                            facade_image, str(proj / "hunyuan3d"), "edificacao", texture=True
                        )
                    meta["house"] = dict(
                        model_url=f"/projects/{pid}/hunyuan3d/{glb.name}",
                        width_m=facade["width_m"], height_m=facade["height_m"],
                        depth_m=float(max(facade["width_m"] * 0.55, 2.5)),
                        dist=facade["dist"], x_m=facade["x_m"], bbox=facade["bbox"],
                        reconstruction="hunyuan3d", texture=True
                    )
                    marca("Hunyuan3D edificação concluída")
                except Exception as exc:
                    app.logger.warning("Hunyuan3D indisponível; usando reconstrução procedural: %s", exc)

            if "house" not in meta:
                building = building_reconstruction.build_building(
                    img, semantic, str(proj / "semantica"), fov=fov
                ) if semantic else None
                if building:
                    meta["house"] = dict(
                        model_url=f"/projects/{pid}/semantica/{building['file']}",
                        width_m=building["width_m"], height_m=building["height_m"],
                        depth_m=building["depth_m"], dist=building["dist"], x_m=building["x_m"],
                        bbox=building["bbox"], reconstruction=building["type"],
                        components=building["components"], door_detected=building["door_detected"],
                        windows_detected=building["windows_detected"]
                    )
                else:
                    gl_house = gl if gl is not None else int(img.size[1] * 0.73)
                    house = scene_assets.extract_house(img, gl_house, str(proj / "casa"), fov=fov)
                    if house:
                        meta["house"] = dict(
                            url=f"/projects/{pid}/casa/{house['file']}",
                            width_m=house["width_m"], height_m=house["height_m"],
                            dist=house["dist"], x_m=house["x_m"],
                            segmentation="opencv", reconstruction="facade_proxy"
                        )
        except Exception as exc:
            app.logger.warning("reconstrução da edificação falhou: %s", exc)

        marca("casa")
        (proj / "meta.json").write_text(json.dumps(meta))
    except depthmod.DepthBackendMissing as exc:
        shutil.rmtree(proj, ignore_errors=True)
        abort(503, str(exc))
    except Exception:
        shutil.rmtree(proj, ignore_errors=True)
        raise
    return jsonify(id=pid, relief_url=f"/projects/{pid}/cenario.glb", meta=meta)


@app.route("/api/scene/<pid>", methods=["GET", "PUT"])
def scene_state(pid):
    """Ajustes do usuário (scene.json). O viewer salva sozinho e reabre com ?projeto=<id>."""
    path = project_dir(pid) / "scene.json"
    if request.method == "PUT":
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            abort(400, "JSON inválido.")
        path.write_text(json.dumps(data))
        return jsonify(ok=True)
    if not path.exists():
        return jsonify(scene=None, meta=json.loads((project_dir(pid) / "meta.json").read_text())
                       if (project_dir(pid) / "meta.json").exists() else None)
    meta = project_dir(pid) / "meta.json"
    return jsonify(scene=json.loads(path.read_text()), meta=json.loads(meta.read_text()) if meta.exists() else None)


def obj_fallback(glb: pathlib.Path, out: pathlib.Path):
    """Sem Blender: gera o OBJ (estático) direto pelo trimesh."""
    import trimesh

    loaded = trimesh.load(str(glb), force="scene")
    loaded.export(str(out / "cenario_completo.obj"))


@app.post("/api/export/<pid>")
def export(pid):
    # 'novo' = cena que não veio de uma foto (ex.: GLB carregado para teste)
    if pid == "novo":
        pid = uuid.uuid4().hex[:8]
        (PROJECTS / pid).mkdir(parents=True)
    proj = project_dir(pid)

    glb = request.files.get("glb")
    if glb is None:
        abort(400, "O viewer não enviou o GLB da cena.")
    try:
        scene_json = json.loads(request.form.get("scene", "{}"))
    except ValueError:
        abort(400, "scene inválido.")

    out = proj / "export"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir()
    glb_path = out / "cenario_completo.glb"
    glb.save(glb_path)
    (out / "cena.json").write_text(json.dumps(scene_json, indent=2, ensure_ascii=False))
    (proj / "scene.json").write_text(json.dumps(scene_json))

    warnings = []
    cmd = converter_command(glb_path, out)
    done = set()
    if cmd is None:
        warnings.append("Blender não encontrado: FBX e .blend não foram gerados. Instale o Blender e defina "
                        "BLENDER=/caminho/blender (ou pip install bpy) e exporte de novo.")
    else:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        for line in proc.stdout.splitlines():
            if line.startswith("P2G_OK "):
                done.add(line.split()[1])
            elif line.startswith("P2G_FAIL "):
                warnings.append("Falha ao gerar " + line[len("P2G_FAIL "):])
        if proc.returncode != 0 and not done:
            warnings.append("O Blender terminou com erro: " + (proc.stderr or proc.stdout)[-400:])
    if "obj" not in done:
        try:
            obj_fallback(glb_path, out)
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"Não consegui gerar o OBJ: {exc}")

    with zipfile.ZipFile(out / "photo2game_exportacao.zip", "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(out.iterdir()):
            if p.name != "photo2game_exportacao.zip":
                z.write(p, p.name)

    files = [dict(name=p.name, size=p.stat().st_size, url=f"/projects/{pid}/export/{p.name}")
             for p in sorted(out.iterdir())]
    return jsonify(id=pid, files=files, warnings=warnings)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    print(f"photo2game em http://localhost:{port}  (profundidade: {depthmod.available_backend()}, "
          f"conversor: {'ok' if converter_command(ROOT, ROOT) else 'sem Blender'})")
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)

