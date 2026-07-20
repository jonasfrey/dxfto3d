"""
DXF processing module.
Parses DXF entities, detects closed regions (faces), and generates 3D meshes.
"""

import math
import os
import logging
import numpy as np
import trimesh
from typing import List, Dict, Any, Tuple

import ezdxf
from ezdxf.path import make_path
from shapely.geometry import LineString, Polygon, MultiLineString, Point
from shapely.ops import polygonize, unary_union, snap
from shapely.validation import make_valid

logger = logging.getLogger(__name__)

# Default 3-color palette. Panes are clustered by area and each area-group gets
# one of these, so panes with the same area share a color (see
# _default_colors_for_faces). Distinct groups cycle through the palette.
DEFAULT_COLORS = ['#FF6B6B', '#4ECDC4', '#F7DC6F']

def _entity_to_linestring(entity) -> LineString:
    """
    Convert a DXF entity to a Shapely LineString.
    Handles LINE, CIRCLE, ARC, LWPOLYLINE, POLYLINE, ELLIPSE, SPLINE.
    """
    try:
        path = make_path(entity)
        vertices = [(v.x, v.y) for v in path.flattening(0.1)]
        if len(vertices) >= 2:
            return LineString(vertices)
    except Exception as e:
        logger.debug(f"make_path failed for {entity.dxftype()}: {e}")

    if entity.dxftype() == 'LINE':
        start = (entity.dxf.start.x, entity.dxf.start.y)
        end = (entity.dxf.end.x, entity.dxf.end.y)
        return LineString([start, end])

    elif entity.dxftype() == 'CIRCLE':
        cx, cy = entity.dxf.center.x, entity.dxf.center.y
        r = entity.dxf.radius
        angles = np.linspace(0, 2 * np.pi, 72, endpoint=False)
        pts = [(cx + r * np.cos(a), cy + r * np.sin(a)) for a in angles]
        return LineString(pts)

    elif entity.dxftype() == 'ARC':
        cx, cy = entity.dxf.center.x, entity.dxf.center.y
        r = entity.dxf.radius
        start_angle = math.radians(entity.dxf.start_angle)
        end_angle = math.radians(entity.dxf.end_angle)
        if end_angle < start_angle:
            end_angle += 2 * np.pi
        num_segments = max(10, int((end_angle - start_angle) / (np.pi / 36)))
        angles = np.linspace(start_angle, end_angle, num_segments)
        pts = [(cx + r * np.cos(a), cy + r * np.sin(a)) for a in angles]
        return LineString(pts)

    elif entity.dxftype() == 'LWPOLYLINE':
        pts = [(p[0], p[1]) for p in entity.get_points()]
        if len(pts) >= 2:
            return LineString(pts)

    elif entity.dxftype() == 'POLYLINE':
        pts = [(v.dxf.location.x, v.dxf.location.y) for v in entity.vertices]
        if len(pts) >= 2:
            return LineString(pts)

    return None

# Faces thinner than this (in mm) can't be printed — the slicer produces an
# empty first layer for them. polygonize() on drawings whose lines don't meet
# cleanly also emits sub-nozzle sliver polygons at intersections, which this
# threshold discards. 0.4 mm ≈ one line from a standard 0.4 mm nozzle.
MIN_FEATURE_WIDTH = 0.4


def _detect_faces(lines: List[LineString], tolerance: float = 0.05) -> List[Polygon]:
    if not lines:
        return []

    snapped_lines = []
    for i, line in enumerate(lines):
        snapped = line
        for j, other in enumerate(lines):
            if i != j:
                snapped = snap(snapped, other, tolerance)
        snapped_lines.append(snapped)

    try:
        merged = unary_union(snapped_lines)
    except Exception:
        merged = unary_union(lines)

    if merged.geom_type == 'MultiLineString':
        segments = list(merged.geoms)
    elif merged.geom_type == 'LineString':
        segments = [merged]
    elif merged.geom_type == 'GeometryCollection':
        segments = []
        for g in merged.geoms:
            if g.geom_type == 'LineString':
                segments.append(g)
            elif g.geom_type == 'MultiLineString':
                segments.extend(g.geoms)
    else:
        segments = snapped_lines

    try:
        faces = list(polygonize(segments))
    except Exception as e:
        logger.warning(f"polygonize failed: {e}")
        faces = []

    valid_faces = []
    for face in faces:
        if not (face.is_valid and not face.is_empty and face.area > 0.01):
            continue
        # Drop panes too thin to print (would cause an "empty initial layer" in
        # the slicer). A shape narrower than MIN_FEATURE_WIDTH everywhere
        # vanishes when eroded by half that width.
        if face.buffer(-MIN_FEATURE_WIDTH / 2).is_empty:
            continue
        valid_faces.append(face)

    return valid_faces

def _default_colors_for_faces(faces) -> List[str]:
    """
    Assign each face a default color from the 3-color palette such that faces
    with the same area share the same color.

    Panes are sorted by area and grouped by walking the sorted sequence: a new
    group starts whenever the gap to the running group representative exceeds a
    small relative tolerance. This clusters geometrically-equal panes (whose
    areas differ only by floating-point noise) together, without the boundary
    problems of fixed rounding. Distinct groups then cycle through the palette.
    """
    n = len(faces)
    if n == 0:
        return []

    order = sorted(range(n), key=lambda i: faces[i].area)
    colors = [DEFAULT_COLORS[0]] * n
    group = -1
    rep = None
    for i in order:
        area = faces[i].area
        if rep is None or abs(area - rep) > max(0.5, rep * 0.005):
            group += 1
            rep = area
        colors[i] = DEFAULT_COLORS[group % len(DEFAULT_COLORS)]
    return colors

def process_dxf(dxf_path: str) -> Dict[str, Any]:
    doc = ezdxf.readfile(dxf_path)
    msp = doc.modelspace()

    lines_data = []
    shapely_lines = []

    supported_types = ('LINE', 'CIRCLE', 'ARC', 'LWPOLYLINE', 'POLYLINE', 'ELLIPSE', 'SPLINE')

    for entity in msp:
        if entity.dxftype() not in supported_types:
            continue

        line = _entity_to_linestring(entity)
        if line is None or line.is_empty:
            continue

        points = list(line.coords)
        lines_data.append({
            'points': points,
            'type': entity.dxftype(),
            'color': entity.dxf.color if hasattr(entity.dxf, 'color') else 0
        })
        shapely_lines.append(line)

    if not shapely_lines:
        return {
            'faces': [],
            'lines': [],
            'bounds': {'min_x': 0, 'min_y': 0, 'max_x': 100, 'max_y': 100},
            'error': 'No supported entities found in DXF'
        }

    faces = _detect_faces(shapely_lines)

    all_points = [pt for line in lines_data for pt in line['points']]
    if all_points:
        min_x = min(p[0] for p in all_points)
        min_y = min(p[1] for p in all_points)
        max_x = max(p[0] for p in all_points)
        max_y = max(p[1] for p in all_points)
    else:
        min_x, min_y, max_x, max_y = 0, 0, 100, 100

    default_colors = _default_colors_for_faces(faces)

    face_list = []
    for i, face in enumerate(faces):
        if not face.is_valid or face.is_empty:
            continue

        exterior_coords = list(face.exterior.coords)
        if len(exterior_coords) > 1 and exterior_coords[0] == exterior_coords[-1]:
            exterior_coords = exterior_coords[:-1]

        holes = []
        for interior in face.interiors:
            interior_coords = list(interior.coords)
            if len(interior_coords) > 1 and interior_coords[0] == interior_coords[-1]:
                interior_coords = interior_coords[:-1]
            holes.append(interior_coords)

        face_list.append({
            'id': i,
            'polygon': exterior_coords,
            'holes': holes,
            'area': face.area,
            'default_color': default_colors[i]
        })

    return {
        'faces': face_list,
        'lines': lines_data,
        'bounds': {
            'min_x': min_x, 'min_y': min_y,
            'max_x': max_x, 'max_y': max_y
        }
    }

def _extrude_geometry(geom, height: float) -> List[trimesh.Trimesh]:
    """
    Helper to safely extrude Polygon or MultiPolygon.
    trimesh.creation.extrude_polygon fails on MultiPolygons, so we extract all polygons.
    """
    meshes = []
    if geom.is_empty:
        return meshes
        
    if geom.geom_type == 'Polygon':
        geoms = [geom]
    elif geom.geom_type in ('MultiPolygon', 'GeometryCollection'):
        geoms = [g for g in geom.geoms if g.geom_type == 'Polygon']
    else:
        return meshes

    for poly in geoms:
        if poly.is_empty:
            continue
        if not poly.is_valid:
            try:
                poly = make_valid(poly)
                if poly.is_empty or poly.geom_type != 'Polygon':
                    continue
            except:
                continue
        
        try:
            mesh = trimesh.creation.extrude_polygon(poly, height)
            if mesh is not None and len(mesh.faces) > 0:
                # process() merges vertices, removes degenerate faces and
                # fixes normals in one call (replaces the removed
                # remove_degenerate_faces() from older trimesh versions).
                mesh.process()
                meshes.append(mesh)
        except Exception as e:
            logger.warning(f"Failed to extrude polygon: {e}")
            
    return meshes

def generate_3d_model(config: Dict[str, Any], output_dir: str) -> str:
    lines_data = config.get('lines', [])
    faces_data = config.get('faces', [])
    frame_thickness = config.get('frame_thickness', 1.5)
    frame_height = config.get('frame_height', 2.0)
    frame_color = config.get('frame_color', '#222222')
    pane_height = config.get('pane_height', 0.5)
    export_format = config.get('export_format', '3mf')

    all_points = []
    for line_data in lines_data:
        all_points.extend(line_data['points'])
    for face_data in faces_data:
        all_points.extend(face_data['polygon'])

    if all_points:
        center_x = sum(p[0] for p in all_points) / len(all_points)
        center_y = sum(p[1] for p in all_points) / len(all_points)
    else:
        center_x, center_y = 0, 0

    meshes_with_colors = []

    # === Create frame meshes (thickened lines) ===
    # Every line segment is extruded, then all pieces are merged into a single
    # mesh so the frame is one selectable object in the exported file (not one
    # object per segment).
    frame_meshes = []
    for line_data in lines_data:
        points = line_data['points']
        if len(points) < 2:
            continue

        offset_points = [(p[0] - center_x, p[1] - center_y) for p in points]
        line = LineString(offset_points)

        half_thickness = frame_thickness / 2
        try:
            thickened = line.buffer(
                half_thickness,
                join_style='mitre',
                mitre_limit=frame_thickness * 2,
                cap_style='flat'
            )
        except Exception:
            thickened = line.buffer(half_thickness)

        if not thickened.is_valid:
            thickened = make_valid(thickened)

        # Use our helper to handle potential MultiPolygons
        frame_meshes.extend(_extrude_geometry(thickened, frame_height))

    if frame_meshes:
        frame_mesh = trimesh.util.concatenate(frame_meshes)
        frame_mesh.process()
        meshes_with_colors.append((frame_mesh, 'Frame', frame_color))

    # === Create pane meshes (extruded faces) ===
    for face_data in faces_data:
        polygon_coords = face_data.get('polygon', [])
        holes = face_data.get('holes', [])
        color = face_data.get('color', face_data.get('default_color', '#FFFFFF'))
        height = face_data.get('height', pane_height)

        if len(polygon_coords) < 3:
            continue

        offset_exterior = [(p[0] - center_x, p[1] - center_y) for p in polygon_coords]
        offset_holes = [
            [(p[0] - center_x, p[1] - center_y) for p in hole]
            for hole in holes
        ]

        try:
            polygon = Polygon(offset_exterior, holes=offset_holes)

            if not polygon.is_valid:
                polygon = make_valid(polygon)

            if polygon.is_empty:
                continue

            # Slight inset to avoid z-fighting with frame
            inset = 0.05  # 0.05mm
            inset_polygon = polygon.buffer(-inset)
            if inset_polygon.is_valid and not inset_polygon.is_empty:
                polygon = inset_polygon

            # Use our helper to handle potential MultiPolygons
            pane_meshes = _extrude_geometry(polygon, height)
            for mesh in pane_meshes:
                meshes_with_colors.append((mesh, f'Pane_{face_data["id"]}', color))

        except Exception as e:
            logger.warning(f"Failed to create pane {face_data.get('id', '?')}: {e}")

    if not meshes_with_colors:
        raise ValueError("No valid meshes could be generated from the input. Check if lines form closed regions.")

    # === Export ===
    output_filename = f"stained_glass.{export_format}"
    output_path = os.path.join(output_dir, output_filename)

    if export_format == '3mf':
        from threemf_exporter import export_3mf
        export_3mf(meshes_with_colors, output_path, title="Stained Glass")
    elif export_format == 'stl':
        all_meshes = [m[0] for m in meshes_with_colors]
        combined = trimesh.util.concatenate(all_meshes)
        combined.process()
        combined.export(output_path, file_type='stl')
    else:
        raise ValueError(f"Unsupported export format: {export_format}")

    return output_path