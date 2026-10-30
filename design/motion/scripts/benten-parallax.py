# BENTEN — scène de parallaxe : les images Magnific deviennent un décor 3D animé
#
# PRINCIPE
#   Magnific produit des images (peintures encre et or). Blender les place sur des PLANS à des
#   profondeurs différentes, puis la caméra avance lentement : les plans glissent les uns par
#   rapport aux autres — c'est la parallaxe, ce qui donne l'impression de volume sans modéliser
#   quoi que ce soit. On rend en boucle de 6 s, l'app la joue en fond.
#
# UTILISATION
#   blender --background --python benten-parallax.py
#
#   Les images sont cherchées dans design/illustrations/ (les rendus Magnific). Si une image
#   manque, un dégradé d'or procédural la remplace : le script ne casse jamais.
#
# APRÈS LE RENDU
#   ffmpeg -framerate 30 -i frame_%04d.png -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 36 -an scene.webm

import bpy
import os
import math

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def find_illustrations(root):
    """
    Les images Magnific peuvent vivre à deux endroits : dans le dépôt principal, ou dans un
    worktree de travail (les sources ne sont pas versionnées, 208 Mo). On essaie dans l'ordre et
    on retient le premier dossier qui contient vraiment des images.
    """
    candidates = [os.environ.get("BENTEN_ILLUSTRATIONS", ""), os.path.join(root, "design", "illustrations")]
    worktrees = os.path.join(root, ".claude", "worktrees")
    if os.path.isdir(worktrees):
        for name in os.listdir(worktrees):
            candidates.append(os.path.join(worktrees, name, "design", "illustrations"))
    for candidate in candidates:
        if candidate and os.path.isdir(candidate):
            if any(item.lower().endswith(".png") for item in os.listdir(candidate)):
                return candidate
    return os.path.join(root, "design", "illustrations")


ILLUSTRATIONS = find_illustrations(ROOT)
OUT_DIR = os.path.join(os.path.expanduser("~"), "Desktop", "benten-benten-scene")

FRAMES = 180
FPS = 30
RES = (1920, 1080)

# Plans : (nom du fichier cherché, profondeur, largeur du plan, hauteur du plan)
# Plus la profondeur est négative, plus le plan est LOIN : il bougera moins à l'écran.
LAYERS = [
    ("benten-biwa-1.png", -11.0, 13.2, 7.4, 0.0),   # fond : la peinture entiere
    ("goutte-or-1.png", -6.2, 4.6, 2.6, 5.2, -3.0),  # milieu : la goutte, dans le coin noir

]


def pick_image(name):
    """Chemin d'une image Magnific, ou None (le script continue sans elle)."""
    path = os.path.join(ILLUSTRATIONS, name)
    return path if os.path.exists(path) else None


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def make_gold_gradient(name):
    """Repli procédural : un dégradé d'or, pour que la scène existe même sans images."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes["Principled BSDF"]
    gradient = nodes.new("ShaderNodeTexGradient")
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (0.52, 0.41, 0.19, 1)
    ramp.color_ramp.elements[1].color = (0.94, 0.83, 0.54, 1)
    links.new(gradient.outputs["Color"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


def make_image_material(name, image_path):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 1.0
    bsdf.inputs["Metallic"].default_value = 0.0
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = bpy.data.images.load(image_path, check_existing=True)
    texture.extension = "CLIP"
    links.new(texture.outputs["Color"], bsdf.inputs["Base Color"])
    # Un peu d'émission : les peintures gardent leur éclat une fois en fond sombre.
    links.new(texture.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = 0.35
    return mat


def add_plane(name, width, height, depth, material, offset_x=0.0, offset_y=0.0):
    """
    Un plan est créé COUCHÉ (dans le plan XY) : il faut le redresser de 90° autour de X pour qu'il
    fasse face à la caméra. Sans ça, la caméra le voit par la tranche et l'image est écrasée.
    """
    # Centrés sur l'axe de la caméra (z = 1,2) : sinon un grand plan a son centre bien
    # au-dessus de l'objectif et la caméra ne voit que du vide.
    bpy.ops.mesh.primitive_plane_add(size=1, location=(offset_x, depth, 1.2 + offset_y))
    plane = bpy.context.active_object
    plane.name = name
    plane.rotation_euler = (math.radians(90), 0, 0)
    plane.scale = (width, height, 1)
    plane.data.materials.append(material)
    return plane


def build():
    clear_scene()
    scene = bpy.context.scene
    scene.render.resolution_x, scene.render.resolution_y = RES
    scene.render.fps = FPS
    scene.frame_start, scene.frame_end = 1, FRAMES
    engines = [item.identifier for item in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in engines else "BLENDER_EEVEE"
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.filepath = os.path.join(OUT_DIR, "frame_")

    world = bpy.data.worlds.new("laque")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.01, 0.009, 0.008, 1)
    scene.world = world

    used = []
    for index, entry in enumerate(LAYERS):
        file_name, depth, width, height = entry[0], entry[1], entry[2], entry[3]
        offset_x = entry[4] if len(entry) > 4 else 0.0
        offset_y = entry[5] if len(entry) > 5 else 0.0
        path = pick_image(file_name)
        if path:
            material = make_image_material(f"plan_{index}", path)
            used.append(file_name)
        else:
            material = make_gold_gradient(f"plan_{index}")
        add_plane(f"plan_{index}", width, height, depth, material, offset_x, offset_y)

    # Caméra : reculée, elle avance de 1,2 m sur la durée — la parallaxe vient de là.
    bpy.ops.object.camera_add(location=(0, 4.0, 1.35))
    camera = bpy.context.active_object
    scene.camera = camera
    camera.data.lens = 55
    # La caméra regarde vers -Y : les plans sont devant elle, à des profondeurs négatives.
    camera.rotation_euler = (math.radians(-90), 0, 0)
    camera.location.y = 4.0
    camera.keyframe_insert("location", frame=1)
    camera.location.y = 2.8
    camera.keyframe_insert("location", frame=FRAMES)

    # Lumière très douce : on éclaire les plans sans cramer l'or.
    bpy.ops.object.light_add(type="AREA", location=(0, 3, 5))
    lamp = bpy.context.active_object
    lamp.data.energy = 260
    lamp.data.size = 8
    lamp.data.color = (1.0, 0.9, 0.72)

    os.makedirs(OUT_DIR, exist_ok=True)
    print("[benten] plans utilisés :", ", ".join(used) if used else "aucun (dégradés procéduraux)")
    return scene


if __name__ == "__main__":
    build()
    bpy.ops.render.render(animation=True)
    print("[benten] rendu terminé dans", OUT_DIR)










