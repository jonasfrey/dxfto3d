"""
3MF file exporter with multi-material support.
Creates a 3MF file where each mesh is a separate object with its own color.
This format is required for multi-color 3D printing with Bambu AMS / Prusa MMU.
"""

import zipfile
from xml.sax.saxutils import escape
from typing import List, Tuple
import trimesh


def export_3mf(
    meshes_with_colors: List[Tuple[trimesh.Trimesh, str, str]],
    output_path: str,
    title: str = "Stained Glass"
) -> None:
    """
    Export multiple meshes with individual colors to a 3MF file.

    Args:
        meshes_with_colors: List of (mesh, name, color_hex) tuples
        output_path: Path to write the .3mf file
        title: Model title for metadata
    """
    # === [Content_Types].xml ===
    content_types = '''<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>'''

    # === _rels/.rels ===
    rels = '''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0"
    Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>'''

    # Deduplicate colors so we emit one entry per distinct color (instead of one
    # per mesh). All resources (the colorgroup and every object) share ONE 3MF
    # resource-id namespace, so the colorgroup takes id=1 and objects start at 2.
    COLORGROUP_ID = 1
    color_to_index = {}
    colors = []   # list of hex colors in p-index order
    for mesh, name, color in meshes_with_colors:
        hex_color = _normalize_color(color)
        if hex_color not in color_to_index:
            color_to_index[hex_color] = len(colors)
            colors.append(hex_color)

    # === 3D/3dmodel.model ===
    # Bambu Studio (2.5+) auto-assigns filaments from *face coloring* declared
    # with the material extension — it ignores object-level base materials. So we
    # publish a <m:colorgroup> and tag every triangle with its color index via
    # pid (the colorgroup) + p1 (the color slot). metadata is core namespace.
    model_xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    model_xml += '<model unit="millimeter"'
    model_xml += ' xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"'
    model_xml += ' xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">\n'

    # Metadata
    model_xml += f'  <metadata name="Title">{escape(title)}</metadata>\n'
    model_xml += '  <metadata name="Application">Stained Glass Generator</metadata>\n'
    model_xml += '  <metadata name="Description">DXF to 3D Stained Glass</metadata>\n'

    # Resources
    model_xml += '  <resources>\n'

    # Color group - one <m:color> per distinct color (#RRGGBBAA).
    model_xml += f'    <m:colorgroup id="{COLORGROUP_ID}">\n'
    for hex_color in colors:
        model_xml += f'      <m:color color="{hex_color}FF"/>\n'
    model_xml += '    </m:colorgroup>\n'

    # Objects - each mesh is a separate object. Every triangle carries the same
    # color index (flat face color); the object also declares it via pid/pindex
    # so generic viewers still show the color.
    obj_id = COLORGROUP_ID + 1
    object_ids = []
    for i, (mesh, name, color) in enumerate(meshes_with_colors):
        cindex = color_to_index[_normalize_color(color)]
        model_xml += f'    <object id="{obj_id}" type="model" name="{escape(name)}" pid="{COLORGROUP_ID}" pindex="{cindex}">\n'
        model_xml += '      <mesh>\n'

        # Vertices
        model_xml += '        <vertices>\n'
        for v in mesh.vertices:
            model_xml += f'          <vertex x="{v[0]:.6f}" y="{v[1]:.6f}" z="{v[2]:.6f}"/>\n'
        model_xml += '        </vertices>\n'

        # Triangles - pid+p1 give each triangle a flat color from the colorgroup.
        model_xml += '        <triangles>\n'
        for f in mesh.faces:
            model_xml += (f'          <triangle v1="{f[0]}" v2="{f[1]}" v3="{f[2]}"'
                          f' pid="{COLORGROUP_ID}" p1="{cindex}"/>\n')
        model_xml += '        </triangles>\n'

        model_xml += '      </mesh>\n'
        model_xml += '    </object>\n'
        object_ids.append(obj_id)
        obj_id += 1

    model_xml += '  </resources>\n'

    # Build - list all objects with identity transform
    model_xml += '  <build>\n'
    for oid in object_ids:
        # Transform: identity matrix (3x4) flattened -> 1 0 0 0 1 0 0 0 1 0 0 0
        model_xml += f'    <item objectid="{oid}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n'
    model_xml += '  </build>\n'
    model_xml += '</model>'

    # === Write ZIP archive ===
    with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('[Content_Types].xml', content_types)
        zf.writestr('_rels/.rels', rels)
        zf.writestr('3D/3dmodel.model', model_xml)


def _normalize_color(color: str) -> str:
    """
    Ensure color is in #RRGGBB format (required by 3MF spec).
    """
    if not color:
        return '#FFFFFF'

    color = color.strip()

    if not color.startswith('#'):
        color = '#' + color

    # Expand short form #RGB to #RRGGBB
    if len(color) == 4:
        color = '#' + color[1]*2 + color[2]*2 + color[3]*2

    # Validate length
    if len(color) != 7:
        color = '#FFFFFF'

    return color.upper()