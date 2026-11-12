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
        scene, info = build_relief(img, depth)
        (proj / "cenario.glb").write_bytes(scene.export(file_type="glb"))
        marca("relevo e exportação do GLB")
        suggest = sample_colors(img)
        pano_info = build_panorama(img, suggest, str(proj / "panorama.jpg"))
        marca("cores e panorama")
        meta = dict(id=pid, relief=info, suggest=suggest, depth_backend=depthmod.available_backend(),
                    panorama=f"/projects/{pid}/panorama.jpg", panorama_info=pano_info)

        # Contexto da foto (rural/urban/beach/snow/mixed) — ajusta objetos no viewer
        try:
            context = scene_assets.sample_context(img)
        except Exception:
            context = 'mixed'
        meta['context'] = context
        marca("classificação do contexto")

        # Piso retificado e árvores recortadas da foto (não abortam se falharem)
        fov = 55.0
        try:
            gl = scene_assets.detect_ground_row(img)
        except Exception:
            gl = None

        if gl is not None:
            # Chão detectado pela heurística de campo → retifica perspectiva
            try:
                tile_img, wm, dm = scene_assets.floor_tile(img, gl, fov=fov)
                tile_path = proj / "piso.jpg"
                tile_img.save(tile_path, quality=92)
                meta["floor"] = dict(url=f"/projects/{pid}/piso.jpg", width_m=wm, depth_m=dm)
            except Exception as exc:
                app.logger.warning("floor_tile falhou: %s", exc)
        else:
            # Sem chão detectado: usa piso genérico (porção inferior da foto — rua, areia, neve, etc.)
            try:
                tile_img, wm, dm = scene_assets.universal_floor(img)
                tile_path = proj / "piso.jpg"
                tile_img.save(tile_path, quality=92)
                meta["floor"] = dict(url=f"/projects/{pid}/piso.jpg", width_m=wm, depth_m=dm, universal=True)
                app.logger.info("universal_floor gerado para contexto '%s'", context)
            except Exception as exc:
                app.logger.warning("universal_floor falhou: %s", exc)

        marca("piso retificado")
        # Extrai elementos da foto (vegetação p/ contextos rurais; para urbano retorna lista vazia por design)
        # gl_veg: se não detectou linha de chão, usa 60% da altura como corte para a extração
        gl_veg = gl if gl is not None else int(img.size[1] * 0.60)
        try:
            if context in ('urban', 'alpine', 'indoor', 'cave'):      # fachada verde / tufos de grama não são árvores; interior e caverna não têm
                raise RuntimeError(f"extração de árvores pulada no contexto '{context}'")
            trees_dir = proj / "arvores"
            tree_list = scene_assets.extract_trees(img, gl_veg, str(trees_dir), fov=fov)
            meta["trees"] = [
                dict(url=f"/projects/{pid}/arvores/{t['file']}", width_m=t["width_m"], height_m=t["height_m"])
                for t in tree_list
            ]
        except Exception as exc:
            app.logger.warning("extract_trees falhou: %s", exc)

        marca("árvores")
        # Casa principal da foto (recorte com transparência, usado como fachada 3D no viewer)
        try:
            gl_house = gl if gl is not None else int(img.size[1] * 0.73)
            house = scene_assets.extract_house(img, gl_house, str(proj / "casa"), fov=fov)
            if house:
                meta["house"] = dict(url=f"/projects/{pid}/casa/{house['file']}", width_m=house["width_m"],
                                     height_m=house["height_m"], dist=house["dist"], x_m=house["x_m"])
        except Exception as exc:
            app.logger.warning("extract_house falhou: %s", exc)

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

