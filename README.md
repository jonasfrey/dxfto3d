Stained Glass Generator
🎯 Project Goal
The goal of this project is to bridge the gap between 2D CAD drawings and multi-color 3D printing. It transforms standard 2D DXF files—composed of lines, arcs, circles, and polylines—into 3D-printable "stained glass" models.

Specifically, it aims to:

Thicken 2D lines into 3D beams (1–2 mm) to act as the stained glass "lead" or frame.
Detect closed regions (faces) formed by crossing or tangent lines.
Extrude those faces into thin panes (0.2–1.0 mm) representing the "glass."
Enable per-pane customization, allowing users to assign specific colors and extrusion heights to individual panes.
Export multi-material 3MF files where the frame and every pane are separate objects, enabling automatic multi-color 3D printing on devices like Bambu Lab (AMS) or Prusa (MMU).
By providing a simple web interface, the tool allows users to upload a DXF, preview the detected 2D/3D geometry, configure colors and thicknesses, and download a ready-to-print 3MF file without needing advanced 3D modeling skills.# dxfto3d
