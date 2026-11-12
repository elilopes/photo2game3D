"""Converte o GLB exportado pelo viewer em FBX, OBJ e .blend.

NÃO recria nada: o GLB já é a cena aprovada no teste ao vivo; aqui só mudamos de formato.
Roda dentro do Blender (3.6+ / 4.x / 5.x):

    blender -b --factory-startup -P convert_export.py -- cenario_completo.glb pasta_saida

ou com o módulo `bpy` instalado via pip:

    python convert_export.py -- cenario_completo.glb pasta_saida
"""
import os
import sys

import bpy

src, out_dir = sys.argv[sys.argv.index("--") + 1:][:2]
os.makedirs(out_dir, exist_ok=True)
base = os.path.join(out_dir, "cenario_completo")


def stage(name, fn):
    """Cada formato é independente: se um falhar, os outros continuam."""
    try:
        fn()
        print("P2G_OK", name, flush=True)
    except Exception as exc:  # noqa: BLE001
        print("P2G_FAIL", name, "-", str(exc).replace("\n", " "), flush=True)


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)

# Mantém todas as animações (Parado, Andar, Correr, Pular, Aterrissar) no .blend e no FBX.
last = 1
for act in bpy.data.actions:
    act.use_fake_user = True
    last = max(last, int(act.frame_range[1]))
bpy.context.scene.frame_start = 1
bpy.context.scene.frame_end = last


def save_blend():
    bpy.ops.wm.save_as_mainfile(filepath=base + ".blend", compress=True)


def export_fbx():
    kwargs = dict(
        filepath=base + ".fbx", use_selection=False,
        object_types={"ARMATURE", "MESH", "LIGHT", "EMPTY"},
        add_leaf_bones=False, bake_anim=True, bake_anim_use_all_actions=True,
        bake_anim_use_nla_strips=False, path_mode="COPY", embed_textures=True,
        axis_forward="-Z", axis_up="Y",
    )
    try:
        bpy.ops.export_scene.fbx(**kwargs)
    except TypeError:  # opção renomeada/removida em alguma versão: tenta o mínimo
        for key in ("bake_anim_use_nla_strips", "embed_textures", "object_types"):
            kwargs.pop(key, None)
        bpy.ops.export_scene.fbx(**kwargs)


def export_obj():
    # OBJ não guarda esqueleto nem animação: sai a geometria (personagem na pose de repouso).
    if hasattr(bpy.ops.wm, "obj_export"):  # Blender 3.2+
        bpy.ops.wm.obj_export(filepath=base + ".obj", export_materials=True, path_mode="COPY")
    else:
        bpy.ops.export_scene.obj(filepath=base + ".obj", use_materials=True, path_mode="COPY")


stage("blend", save_blend)
stage("fbx", export_fbx)
stage("obj", export_obj)
