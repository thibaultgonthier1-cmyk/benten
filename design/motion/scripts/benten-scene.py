# 
#  * BENTEN — scène 3D du fond animé, générée par script Blender (bpy, Python 3).
#  *
#  * PRÉREQUIS
#  *   Blender 4.x installé. Aucun addon, aucune texture externe : tout est construit en code.
#  *
#  * UTILISATION
#  *   Blender ouvert ▸ onglet Scripting ▸ Ouvrir ▸ ce fichier ▸ Exécuter (Alt+P).
#  *   Ou en ligne de commande (recommandé, ça rend tout seul) :
#  *     blender --background --python benten-scene.py
#  *
#  * CE QUE ÇA PRODUIT
#  *   1920×1080, 30 i/s, 6 s (180 images), dans %USERPROFILE%\Desktop\benten-scene\ :
#  *     - un torii sur l'eau, soleil d'or derrière, anneaux concentriques qui s'ouvrent ;
#  *     - caméra en orbite lente (mouvement perpétuel du fond, jamais deux fois le même angle) ;
#  *     - éclairage chaud (or) + reflets ; rendu EEVEE pour rester rapide.
#  *
#  * CE QUE ÇA DONNE DANS L'APP
#  *   Un WebM par catégorie, à la place des images fixes du fond animé. Même emplacement
#  *   (`ViewBackdrop`), mêmes transitions : on garde l'orchestration, on change la source.
#  *
#  * APRÈS LE RENDU (convertir en WebM, boucle propre) :
#  *   ffmpeg -framerate 30 -i frame_%04d.png -c:v libvpx-vp9 -b:v 0 -crf 34 -an benten-scene.webm
# 


import bpy
import math
import os
from mathutils import Vector

OUT_DIR = os.path.join(os.path.expanduser("~"), "Desktop", "benten-scene")
FRAME_START = 1
FRAME_END = 180          # 6 s à 30 i/s
FPS = 30
RES = (1920, 1080)

GOLD = (0.831, 0.667, 0.314, 1.0)
GOLD_LIGHT = (0.941, 0.827, 0.541, 1.0)
IVORY = (0.953, 0.937, 0.910, 1.0)
BLACK = (0.010, 0.009, 0.008, 1.0)


def reset_scene():
    """Scène vide : on repart toujours de zéro, le script est rejouable."""
    bpy.ops.wm.read_factory_settings(use_empty=True)


def make_material(name, color, emission=0.0, roughness=0.55, metallic=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission > 0:
        # L'émission fait le « soleil d'or » sans avoir besoin d'un éclairage complexe.
        bsdf.inputs["Emission Color"].default_value = color
        bsdf.inputs["Emission Strength"].default_value = emission
    return mat


def add_box(name, size, location, material):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (size[0] / 2, size[1] / 2, size[2] / 2)
    obj.data.materials.append(material)
    return obj


def build_torii(material):
    """Torii : kasagi (haute, large), shimaki, nuki, deux piliers. Proportions du logo."""
    parts = []
    parts.append(add_box("kasagi", (7.4, 0.5, 0.5), (0, 0, 3.1), material))
    parts.append(add_box("shimaki", (6.3, 0.36, 0.24), (0, 0, 2.72), material))
    parts.append(add_box("nuki", (6.9, 0.34, 0.32), (0, 0, 1.9), material))
    parts.append(add_box("pilier_g", (0.48, 0.48, 2.9), (-2.5, 0, 0.9), material))
    parts.append(add_box("pilier_d", (0.48, 0.48, 2.9), (2.5, 0, 0.9), material))
    return parts


def build_scene():
    reset_scene()

    scene = bpy.context.scene
    scene.render.resolution_x, scene.render.resolution_y = RES
    scene.render.fps = FPS
    scene.frame_start, scene.frame_end = FRAME_START, FRAME_END
    scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in [
        item.identifier for item in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items
    ] else "BLENDER_EEVEE"
    scene.render.film_transparent = True  # l'app pose le fond laqué elle-même
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = os.path.join(OUT_DIR, "frame_")
    scene.render.image_settings.color_mode = "RGBA"

    # Fond noir : même sans transparence, la composition reste juste.
    world = bpy.data.worlds.new("laque")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = BLACK
    world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
    scene.world = world

    or_mat = make_material("or", GOLD, emission=1.6, roughness=0.35, metallic=0.4)
    ivoire_mat = make_material("ivoire", IVORY, emission=0.55, roughness=0.42)
    eau_mat = make_material("eau", (0.012, 0.011, 0.014, 1), roughness=0.06, metallic=0.85)

    # Soleil : sphère émissive derrière le torii.
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1.9, location=(0, 4.2, 2.15))
    soleil = bpy.context.active_object
    soleil.name = "soleil"
    soleil.data.materials.append(or_mat)

    build_torii(ivoire_mat)

    # Eau : plan avec ondulation lente — c'est ce qui « vit » à l'écran.
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
    eau = bpy.context.active_object
    eau.name = "eau"
    eau.data.materials.append(eau_mat)
    wave = eau.modifiers.new("ondulation", type="WAVE")
    wave.height = 0.06
    wave.width = 1.6
    wave.speed = 0.012
    wave.use_normal = True

    # Anneaux concentriques : trois tores fins qui rappellent la corde pincée.
    for i, radius in enumerate((3.4, 4.6, 5.8)):
        bpy.ops.mesh.primitive_torus_add(
            major_radius=radius,
            minor_radius=0.012,
            location=(0, 3.2, 0.02),
            major_segments=128,
            minor_segments=8,
        )
        anneau = bpy.context.active_object
        anneau.name = f"anneau_{i}"
        anneau.data.materials.append(or_mat)
        anneau.scale = (1, 1, 1)
        # Ouverture progressive : chaque anneau s'élargit et s'efface (via l'échelle).
        anneau.keyframe_insert("scale", frame=FRAME_START)
        anneau.scale = (1.35, 1.35, 1)
        anneau.keyframe_insert("scale", frame=FRAME_END)

    # Caméra en orbite lente : le fond ne montre jamais deux fois le même cadrage.
    bpy.ops.object.camera_add(location=(0, -9.5, 3.4))
    camera = bpy.context.active_object
    scene.camera = camera
    camera.data.lens = 42

    # Cible fixe (le torii) via une contrainte « Track To ».
    bpy.ops.object.empty_add(location=(0, 0, 1.8))
    cible = bpy.context.active_object
    cible.name = "cible"
    track = camera.constraints.new(type="TRACK_TO")
    track.target = cible
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"

    # Orbite : rotation autour de la cible, 12° seulement (mouvement lent, jamais brusque).
    pivot = bpy.data.objects.new("pivot", None)
    bpy.context.collection.objects.link(pivot)
    camera.parent = pivot
    pivot.keyframe_insert("rotation_euler", frame=FRAME_START)
    pivot.rotation_euler = (0, 0, math.radians(12))
    pivot.keyframe_insert("rotation_euler", frame=FRAME_END)

    # Éclairage d'appoint : une lumière chaude de face, très douce.
    bpy.ops.object.light_add(type="AREA", location=(3, -6, 6))
    lampe = bpy.context.active_object
    lampe.data.energy = 160
    lampe.data.color = (1.0, 0.86, 0.62)
    lampe.data.size = 6

    os.makedirs(OUT_DIR, exist_ok=True)
    return scene


if __name__ == "__main__":
    scene = build_scene()
    print("[benten] scène construite — rendu de", FRAME_END - FRAME_START + 1, "images vers", OUT_DIR)
    bpy.ops.render.render(animation=True)
    print("[benten] terminé. Convertir en WebM :")
    print(
        '  ffmpeg -framerate 30 -i "%s" -c:v libvpx-vp9 -b:v 0 -crf 34 -an benten-scene.webm'
        % os.path.join(OUT_DIR, "frame_%04d.png")
    )


