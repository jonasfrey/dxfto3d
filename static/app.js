/**
 * Stained Glass Generator - Frontend Application
 * Handles DXF upload, 2D/3D preview, color assignment, and export.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Application state
const appData = {
    faces: [],
    lines: [],
    bounds: {},
    selectedFaceIndex: null,   // currently selected pane (for color/height editing)
    hoveredFaceIndex: null,    // pane under the cursor in the 2D view or list
    paint: {
        color: '#D32B2B',          // active paint color (hex), derived from hue
        hue: 0,                    // active hue 0-360 (only hue is user-selectable)
        height: 0.5,               // active pane thickness (mm)
        palette: [0, 174, 48]      // palette hues (3 by default)
    },
    view: { zoom: 1, panX: 0, panY: 0 },         // 2D pan/zoom (canvas px, on top of fit)
    config: {
        frame_thickness: 1.5,
        frame_height: 2.0,
        frame_color: '#222222',
        pane_height: 0.5
    }
};

// Three.js globals
let scene, camera, renderer, controls;
let meshGroup;

// Last 2D view transform (DXF -> canvas), stored so click/hover handlers can
// map a mouse position back to a pane via hit-testing.
let view2d = null;

// ============================================================
// FILE UPLOAD
// ============================================================

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
        handleFileUpload(e.dataTransfer.files[0]);
    }
});
fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        handleFileUpload(e.target.files[0]);
    }
});

async function handleFileUpload(file) {
    const status = document.getElementById('upload-status');
    status.innerHTML = '<div class="loading"></div> Processing DXF file...';

    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Upload failed');
        }

        const data = await response.json();

        if (data.error) {
            throw new Error(data.error);
        }

        appData.faces = data.faces;
        appData.lines = data.lines;
        appData.bounds = data.bounds;
        appData.selectedFaceIndex = null;
        appData.hoveredFaceIndex = null;
        appData.view.zoom = 1;
        appData.view.panX = 0;
        appData.view.panY = 0;

        status.innerHTML = `<div class="success">✓ Found ${data.faces.length} panes and ${data.lines.length} line entities</div>`;

        // Show subsequent sections
        document.getElementById('config-section').style.display = 'block';
        document.getElementById('preview-section').style.display = 'block';
        document.getElementById('export-section').style.display = 'block';

        // Initialize previews
        draw2DPreview();
        init3DPreview();
        populatePaneList();

        // Scroll to config
        document.getElementById('config-section').scrollIntoView({ behavior: 'smooth' });

    } catch (error) {
        status.innerHTML = `<div class="error">✗ ${error.message}</div>`;
    }
}

// ============================================================
// CONFIGURATION CONTROLS
// ============================================================

document.getElementById('frame-thickness').addEventListener('input', (e) => {
    appData.config.frame_thickness = parseFloat(e.target.value);
    document.getElementById('frame-thickness-val').textContent = e.target.value;
    update3DPreview();
});

document.getElementById('frame-height').addEventListener('input', (e) => {
    appData.config.frame_height = parseFloat(e.target.value);
    document.getElementById('frame-height-val').textContent = e.target.value;
    update3DPreview();
});

document.getElementById('pane-height').addEventListener('input', (e) => {
    appData.config.pane_height = parseFloat(e.target.value);
    document.getElementById('pane-height-val').textContent = e.target.value;
    draw2DPreview();
    update3DPreview();
});

document.getElementById('frame-color').addEventListener('input', (e) => {
    appData.config.frame_color = e.target.value;
    draw2DPreview();
    update3DPreview();
});

// ============================================================
// PAINT TOOL — color palette (hue-only) + thickness palette
// ============================================================

// Only hue is user-selectable: saturation/lightness are fixed, so every palette
// color is a pure hue. The hue slider covers the full 0-360° range.
const PAINT_SAT = 0.65;
const PAINT_LIGHT = 0.5;
const THICKNESS_OPTIONS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

function hslToHex(h, s = PAINT_SAT, l = PAINT_LIGHT) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r, g, b;
    if (h < 60)       [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else              [r, g, b] = [c, 0, x];
    const ch = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return '#' + ch(r) + ch(g) + ch(b);
}

function hexToHsl(hex) {
    hex = String(hex).replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
    }
    return { h: h * 360, s, l };
}

// Thickness → lightness delta for the 2D preview only: 0.2 mm is brightest,
// 1.0 mm is darkest, neutral at 0.6 mm.
function thicknessBrightnessDelta(thickness) {
    const t = Math.max(0, Math.min(1, (thickness - 0.2) / 0.8));   // 0 at 0.2mm .. 1 at 1.0mm
    return (0.5 - t) * 0.30;                                       // +0.15 .. -0.15
}

// Fill color for a pane in the 2D preview: its real color with lightness shifted
// by its thickness. The 3D view and export use the unmodulated color.
function previewColorForFace(face) {
    const base = face.color || face.default_color || '#FFFFFF';
    const thickness = face.height ?? appData.config.pane_height;
    const { h, s, l } = hexToHsl(base);
    const l2 = Math.max(0.05, Math.min(0.95, l + thicknessBrightnessDelta(thickness)));
    return hslToHex(h, s, l2);
}

// Set the active color from a hue, sync the slider/value/current swatch.
function selectColor(hue) {
    appData.paint.hue = hue;
    appData.paint.color = hslToHex(hue);
    const slider = document.getElementById('hue-slider');
    if (slider) slider.value = hue;
    const val = document.getElementById('hue-val');
    if (val) val.textContent = Math.round(hue) + '°';
    const cur = document.getElementById('current-color');
    if (cur) cur.style.background = appData.paint.color;
    renderColorPalette();   // refresh the active ring
}

function selectThickness(t) {
    appData.paint.height = t;
    renderThicknessPalette();
}

function renderColorPalette() {
    const el = document.getElementById('color-palette');
    if (!el) return;
    el.innerHTML = '';
    appData.paint.palette.forEach((hue) => {
        const sw = document.createElement('div');
        sw.className = 'swatch' + (Math.round(hue) === Math.round(appData.paint.hue) ? ' active' : '');
        sw.style.background = hslToHex(hue);
        sw.title = `Hue ${Math.round(hue)}° — click to select`;
        sw.addEventListener('click', () => selectColor(hue));

        // Remove (×); keep at least one swatch.
        const rm = document.createElement('span');
        rm.className = 'swatch-remove';
        rm.textContent = '×';
        rm.title = 'Remove color';
        rm.addEventListener('click', (e) => {
            e.stopPropagation();
            if (appData.paint.palette.length <= 1) return;
            const wasActive = Math.round(appData.paint.hue) === Math.round(hue);
            appData.paint.palette = appData.paint.palette.filter(h => h !== hue);
            renderColorPalette();
            if (wasActive) selectColor(appData.paint.palette[0]);
        });
        sw.appendChild(rm);
        el.appendChild(sw);
    });
}

function renderThicknessPalette() {
    const el = document.getElementById('thickness-palette');
    if (!el) return;
    el.innerHTML = '';
    THICKNESS_OPTIONS.forEach((t) => {
        const sw = document.createElement('div');
        const active = Math.abs(t - appData.paint.height) < 1e-9;
        sw.className = 'swatch t-swatch' + (active ? ' active' : '');
        sw.textContent = t.toFixed(1);
        sw.title = `${t.toFixed(1)} mm`;
        sw.addEventListener('click', () => selectThickness(t));
        el.appendChild(sw);
    });
}

// Hue slider: pick any hue (only hue is selectable).
document.getElementById('hue-slider').addEventListener('input', (e) => {
    selectColor(parseFloat(e.target.value));
});

// Add the current hue to the palette.
document.getElementById('add-color').addEventListener('click', () => {
    const hue = Math.round(appData.paint.hue);
    if (!appData.paint.palette.some(h => Math.round(h) === hue)) {
        appData.paint.palette.push(hue);
        renderColorPalette();
    }
});

document.getElementById('reset-view').addEventListener('click', () => {
    appData.view.zoom = 1;
    appData.view.panX = 0;
    appData.view.panY = 0;
    draw2DPreview();
});

// Initial palette render + sync active color from the default hue.
renderColorPalette();
renderThicknessPalette();
selectColor(appData.paint.hue);

// ============================================================
// 2D PREVIEW (Canvas)
// ============================================================

function draw2DPreview() {
    const canvas = document.getElementById('canvas-2d');
    const ctx = canvas.getContext('2d');

    const bounds = appData.bounds;
    const padding = 30;
    const rangeX = (bounds.max_x - bounds.min_x) || 100;
    const rangeY = (bounds.max_y - bounds.min_y) || 100;
    const scaleX = (canvas.width - 2 * padding) / rangeX;
    const scaleY = (canvas.height - 2 * padding) / rangeY;
    const baseScale = Math.min(scaleX, scaleY);
    const baseOffsetX = (canvas.width - rangeX * baseScale) / 2 - bounds.min_x * baseScale;
    const baseOffsetY = (canvas.height - rangeY * baseScale) / 2 - bounds.min_y * baseScale;

    const { zoom, panX, panY } = appData.view;

    // Forward transform: base fit, then user zoom (about the canvas origin) and
    // pan. The inverse lives in paneAtCanvasPoint for hit-testing.
    const tx = (x) => (x * baseScale + baseOffsetX) * zoom + panX;
    const ty = (y) => (canvas.height - (y * baseScale + baseOffsetY)) * zoom + panY;

    view2d = { baseScale, baseOffsetX, baseOffsetY, zoom, panX, panY };

    // Background
    ctx.fillStyle = '#f8f8f8';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw faces (panes)
    appData.faces.forEach((face, i) => {
        const isSelected = appData.selectedFaceIndex === i;
        const isHovered = appData.hoveredFaceIndex === i;

        ctx.beginPath();
        face.polygon.forEach((pt, j) => {
            if (j === 0) ctx.moveTo(tx(pt[0]), ty(pt[1]));
            else ctx.lineTo(tx(pt[0]), ty(pt[1]));
        });
        ctx.closePath();
        // Encode thickness as brightness in the 2D preview only (thin=bright,
        // thick=dark). The real color is unchanged for the 3D view and export.
        ctx.fillStyle = previewColorForFace(face);
        ctx.fill();

        // Outline: highlight selected/hovered panes, thin stroke otherwise
        if (isSelected) {
            ctx.strokeStyle = '#667eea';
            ctx.lineWidth = 3;
        } else if (isHovered) {
            ctx.strokeStyle = '#9aa6e8';
            ctx.lineWidth = 2;
        } else {
            ctx.strokeStyle = '#666';
            ctx.lineWidth = 0.5;
        }
        ctx.stroke();

        // Draw holes
        if (face.holes) {
            face.holes.forEach(hole => {
                ctx.beginPath();
                hole.forEach((pt, j) => {
                    if (j === 0) ctx.moveTo(tx(pt[0]), ty(pt[1]));
                    else ctx.lineTo(tx(pt[0]), ty(pt[1]));
                });
                ctx.closePath();
                ctx.fillStyle = '#f8f8f8';
                ctx.fill();
                ctx.strokeStyle = '#666';
                ctx.lineWidth = 0.5;
                ctx.stroke();
            });
        }

        // Pane number at its centroid (so list rows map to drawing regions)
        const label = paneLabelPos(face.polygon);
        if (label) {
            const cx = tx(label[0]);
            const cy = ty(label[1]);
            ctx.beginPath();
            ctx.arc(cx, cy, 10, 0, Math.PI * 2);
            ctx.fillStyle = isSelected ? '#667eea' : 'rgba(255,255,255,0.85)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(0,0,0,0.25)';
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.fillStyle = isSelected ? '#fff' : '#333';
            ctx.font = 'bold 12px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(i + 1), cx, cy + 0.5);
        }
    });

    // Draw lines (frame)
    ctx.strokeStyle = appData.config.frame_color;
    ctx.lineWidth = Math.max(1.0, appData.config.frame_thickness * baseScale * 0.5 * zoom);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    appData.lines.forEach(line => {
        ctx.beginPath();
        line.points.forEach((pt, j) => {
            if (j === 0) ctx.moveTo(tx(pt[0]), ty(pt[1]));
            else ctx.lineTo(tx(pt[0]), ty(pt[1]));
        });
        ctx.stroke();
    });
}

// ============================================================
// PANE SELECTION (click in 2D view ↔ list row sync)
// ============================================================

// Centroid-ish position (mean of vertices) for placing the pane number label.
function paneLabelPos(polygon) {
    if (!polygon || polygon.length === 0) return null;
    let sx = 0, sy = 0;
    for (const p of polygon) { sx += p[0]; sy += p[1]; }
    return [sx / polygon.length, sy / polygon.length];
}

// Ray-casting point-in-polygon test.
function pointInPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], yi = poly[i][1];
        const xj = poly[j][0], yj = poly[j][1];
        const intersect = ((yi > y) !== (yj > y)) &&
            (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// Inside the exterior ring and not inside any hole.
function pointInPane(x, y, face) {
    if (!face.polygon || !pointInPolygon(x, y, face.polygon)) return false;
    if (face.holes) {
        for (const hole of face.holes) {
            if (pointInPolygon(x, y, hole)) return false;
        }
    }
    return true;
}

// Convert a canvas drawing-buffer coordinate to DXF coordinates (inverting the
// zoom/pan transform), then find the pane containing it. Returns face index/null.
function paneAtCanvasPoint(canvasX, canvasY) {
    if (!view2d || !appData.faces.length) return null;
    const canvas = document.getElementById('canvas-2d');
    const { baseScale, baseOffsetX, baseOffsetY, zoom, panX, panY } = view2d;
    // Invert: tx(x) = (x*baseScale+baseOffsetX)*zoom + panX
    const fx = (canvasX - panX) / zoom;                       // = x*baseScale + baseOffsetX
    const fyBase = canvas.height - (canvasY - panY) / zoom;   // = y*baseScale + baseOffsetY
    const dxfX = (fx - baseOffsetX) / baseScale;
    const dxfY = (fyBase - baseOffsetY) / baseScale;

    // If regions overlap, prefer the smallest (innermost) pane.
    let best = null;
    let bestArea = Infinity;
    appData.faces.forEach((face, i) => {
        const area = face.area ?? Infinity;
        if (pointInPane(dxfX, dxfY, face) && area < bestArea) {
            bestArea = area;
            best = i;
        }
    });
    return best;
}

function canvasCoordsFromEvent(e) {
    const canvas = document.getElementById('canvas-2d');
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    return [x, y];
}

// Select a pane (or null to clear): highlight + scroll its list row, and
// refresh both previews so the selection shows everywhere.
function selectFace(index) {
    appData.selectedFaceIndex = index;

    const items = document.querySelectorAll('.pane-item');
    items.forEach((el, i) => el.classList.toggle('selected', i === index));
    if (index != null && items[index]) {
        items[index].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    draw2DPreview();
    update3DPreview();
}

// Paint bucket: apply the active color + thickness to the pane at a point.
function paintAt(canvasX, canvasY) {
    const idx = paneAtCanvasPoint(canvasX, canvasY);
    if (idx == null) { selectFace(null); return; }   // empty space → clear selection
    const face = appData.faces[idx];
    face.color = appData.paint.color;
    face.height = appData.paint.height;
    // Keep the pane-list inputs in sync with the painted values.
    const ci = document.querySelector(`.pane-color-input[data-face-id="${idx}"]`);
    const hi = document.querySelector(`.pane-height-input[data-face-id="${idx}"]`);
    if (ci) ci.value = appData.paint.color;
    if (hi) hi.value = appData.paint.height;
    selectFace(idx);   // highlight + scroll row; redraws 2D + 3D
}

const canvas2d = document.getElementById('canvas-2d');
canvas2d.style.cursor = 'grab';

// Active drag state: { lastX, lastY, startX, startY, moved }. A movement beyond
// a small threshold turns a click into a pan, so jitter still paints.
let drag = null;

canvas2d.addEventListener('mousedown', (e) => {
    if (!appData.faces.length) return;
    const [x, y] = canvasCoordsFromEvent(e);
    drag = { lastX: x, lastY: y, startX: x, startY: y, moved: false };
    canvas2d.style.cursor = 'grabbing';
    if (appData.hoveredFaceIndex !== null) {
        appData.hoveredFaceIndex = null;   // drop hover while dragging
    }
});

canvas2d.addEventListener('mousemove', (e) => {
    const [x, y] = canvasCoordsFromEvent(e);
    if (drag) {
        if (!drag.moved && Math.hypot(x - drag.startX, y - drag.startY) > 4) {
            drag.moved = true;
        }
        if (drag.moved) {
            appData.view.panX += x - drag.lastX;
            appData.view.panY += y - drag.lastY;
            drag.lastX = x;
            drag.lastY = y;
            draw2DPreview();
        }
        return;
    }
    // Hover: highlight the pane under the cursor
    if (!appData.faces.length || !view2d) return;
    const idx = paneAtCanvasPoint(x, y);
    canvas2d.style.cursor = idx != null ? 'pointer' : 'grab';
    if (idx !== appData.hoveredFaceIndex) {
        appData.hoveredFaceIndex = idx;
        draw2DPreview();
    }
});

// mouseup on window so a drag always ends even if released off-canvas.
window.addEventListener('mouseup', (e) => {
    if (!drag) return;
    if (!drag.moved && e.target === canvas2d) {
        const [x, y] = canvasCoordsFromEvent(e);
        paintAt(x, y);                       // click (no drag) → paint bucket
    }
    drag = null;
    canvas2d.style.cursor = 'grab';
});

canvas2d.addEventListener('mouseleave', () => {
    if (appData.hoveredFaceIndex !== null) {
        appData.hoveredFaceIndex = null;
        draw2DPreview();
    }
});

// Zoom toward the cursor with the mouse wheel.
canvas2d.addEventListener('wheel', (e) => {
    if (!appData.faces.length) return;
    e.preventDefault();
    const [cx, cy] = canvasCoordsFromEvent(e);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const oldZoom = appData.view.zoom;
    const newZoom = Math.min(20, Math.max(0.2, oldZoom * factor));
    // Keep the world point under the cursor fixed.
    appData.view.panX = cx - (cx - appData.view.panX) * (newZoom / oldZoom);
    appData.view.panY = cy - (cy - appData.view.panY) * (newZoom / oldZoom);
    appData.view.zoom = newZoom;
    draw2DPreview();
}, { passive: false });

// ============================================================
// 3D PREVIEW (Three.js)
// ============================================================

function init3DPreview() {
    const container = document.getElementById('canvas-3d-container');

    // Clear any existing renderer
    container.innerHTML = '';

    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf0f0f0);

    // Camera
    const width = container.clientWidth || 500;
    const height = container.clientHeight || 400;
    camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 10000);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    // Controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // Lights
    const ambientLight = new THREE.AmbientLight(0x404040, 1.5);
    scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight1.position.set(1, 1, 2);
    scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.5);
    dirLight2.position.set(-1, -1, 1);
    scene.add(dirLight2);

    // Grid helper
    const grid = new THREE.GridHelper(200, 20, 0xcccccc, 0xdddddd);
    grid.rotation.x = Math.PI / 2;
    scene.add(grid);

    meshGroup = new THREE.Group();
    scene.add(meshGroup);

    update3DPreview();

    // Animation loop
    function animate() {
        requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
    }
    animate();

    // Handle resize
    window.addEventListener('resize', onWindowResize);
}

function onWindowResize() {
    if (!renderer || !camera) return;
    const container = document.getElementById('canvas-3d-container');
    const width = container.clientWidth;
    const height = container.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
}

function update3DPreview() {
    if (!meshGroup) return;

    // Clear existing meshes
    while (meshGroup.children.length > 0) {
        const child = meshGroup.children[0];
        meshGroup.remove(child);
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
    }

    const bounds = appData.bounds;
    const centerX = (bounds.min_x + bounds.max_x) / 2;
    const centerY = (bounds.min_y + bounds.max_y) / 2;

    // === Create frame meshes ===
    const frameMaterial = new THREE.MeshStandardMaterial({
        color: appData.config.frame_color,
        metalness: 0.3,
        roughness: 0.6
    });

    const frameThickness = appData.config.frame_thickness;
    const frameHeight = appData.config.frame_height;

    appData.lines.forEach(line => {
        const points = line.points;
        if (points.length < 2) return;

        for (let i = 0; i < points.length - 1; i++) {
            const p1 = new THREE.Vector3(
                points[i][0] - centerX,
                points[i][1] - centerY,
                0
            );
            const p2 = new THREE.Vector3(
                points[i + 1][0] - centerX,
                points[i + 1][1] - centerY,
                0
            );

            const direction = new THREE.Vector3().subVectors(p2, p1);
            const length = direction.length();

            if (length < 0.01) continue;

            // Box with length along local X, thickness along Y, height along Z.
            // Rotating around Z then lays the beam flat in the XY plane with the
            // correct height (Z-up), matching the exported 3MF.
            const geometry = new THREE.BoxGeometry(
                length,
                frameThickness,
                frameHeight
            );

            const mesh = new THREE.Mesh(geometry, frameMaterial);

            // Position at midpoint, raised to sit on build plate
            const midpoint = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
            midpoint.z = frameHeight / 2;
            mesh.position.copy(midpoint);

            // Orient: rotate around Z so local +X (the length axis) follows the segment
            const angle = Math.atan2(direction.y, direction.x);
            mesh.rotation.z = angle;

            meshGroup.add(mesh);
        }
    });

    // === Create pane meshes ===
    appData.faces.forEach((face, i) => {
        if (face.polygon.length < 3) return;

        const shape = new THREE.Shape();
        face.polygon.forEach((pt, i) => {
            const x = pt[0] - centerX;
            const y = pt[1] - centerY;
            if (i === 0) shape.moveTo(x, y);
            else shape.lineTo(x, y);
        });

        // Add holes
        if (face.holes && face.holes.length > 0) {
            face.holes.forEach(hole => {
                const path = new THREE.Path();
                hole.forEach((pt, i) => {
                    const x = pt[0] - centerX;
                    const y = pt[1] - centerY;
                    if (i === 0) path.moveTo(x, y);
                    else path.lineTo(x, y);
                });
                shape.holes.push(path);
            });
        }

        const height = face.height || appData.config.pane_height;
        const extrudeSettings = {
            depth: height,
            bevelEnabled: false
        };

        const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
        // Shape is defined in the XY plane and ExtrudeGeometry extrudes along
        // +Z, so the pane already lies flat on the build plate (Z-up), matching
        // the exported 3MF. No rotation needed.

        const color = face.color || face.default_color || '#FFFFFF';
        const isSelected = appData.selectedFaceIndex === i;
        const material = new THREE.MeshStandardMaterial({
            color: color,
            transparent: true,
            // Selected pane: fully opaque + a faint self-colored glow so it
            // stands out from the translucent neighbours.
            opacity: isSelected ? 1.0 : 0.7,
            emissive: isSelected ? new THREE.Color(color) : new THREE.Color(0x000000),
            emissiveIntensity: isSelected ? 0.3 : 0,
            metalness: 0.1,
            roughness: 0.3,
            side: THREE.DoubleSide
        });

        const mesh = new THREE.Mesh(geometry, material);
        meshGroup.add(mesh);

        // Accent outline on the selected pane so it's visible in 3D too.
        if (isSelected) {
            const edges = new THREE.EdgesGeometry(geometry);
            const outline = new THREE.LineSegments(
                edges,
                new THREE.LineBasicMaterial({ color: 0x667eea })
            );
            meshGroup.add(outline);
        }
    });

    // Auto-frame camera
    const box = new THREE.Box3().setFromObject(meshGroup);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 100;

    camera.position.set(
        center.x + maxDim * 0.5,
        center.y - maxDim * 0.8,
        center.z + maxDim * 1.2
    );
    camera.lookAt(center);
    controls.target.copy(center);
    controls.update();
}

// ============================================================
// PANE LIST (Color & Height Assignment)
// ============================================================

function populatePaneList() {
    const list = document.getElementById('pane-list');
    list.innerHTML = '';
    document.getElementById('pane-count').textContent = appData.faces.length;

    appData.faces.forEach((face, i) => {
        const item = document.createElement('div');
        item.className = 'pane-item';
        if (appData.selectedFaceIndex === i) item.classList.add('selected');
        item.innerHTML = `
            <label class="pane-label">Pane ${i + 1}</label>
            <input type="color"
                   value="${face.color || face.default_color || '#FFFFFF'}"
                   data-face-id="${i}"
                   class="pane-color-input">
            <label class="pane-height-label">H:</label>
            <input type="number"
                   min="0.2" max="1.0" step="0.1"
                   value="${face.height || appData.config.pane_height}"
                   data-face-id="${i}"
                   class="pane-height-input">
            <span class="pane-height-unit">mm</span>
            <span class="pane-area">Area: ${face.area.toFixed(1)} mm²</span>
        `;

        // Clicking a row selects the pane (but not when clicking the inputs,
        // which handle their own color/height editing).
        item.addEventListener('click', (e) => {
            if (e.target.tagName === 'INPUT') return;
            selectFace(i);
        });
        // Hovering a row highlights the matching pane in the 2D view.
        item.addEventListener('mouseenter', () => {
            appData.hoveredFaceIndex = i;
            draw2DPreview();
        });
        item.addEventListener('mouseleave', () => {
            appData.hoveredFaceIndex = null;
            draw2DPreview();
        });

        list.appendChild(item);
    });

    // Event listeners for color changes
    list.querySelectorAll('.pane-color-input').forEach(input => {
        input.addEventListener('input', (e) => {
            const id = parseInt(e.target.dataset.faceId);
            appData.faces[id].color = e.target.value;
            draw2DPreview();
            update3DPreview();
        });
    });

    // Event listeners for height changes
    list.querySelectorAll('.pane-height-input').forEach(input => {
        input.addEventListener('input', (e) => {
            const id = parseInt(e.target.dataset.faceId);
            appData.faces[id].height = parseFloat(e.target.value);
            draw2DPreview();
            update3DPreview();
        });
    });
}

// Bulk actions
document.getElementById('apply-all-height').addEventListener('click', () => {
    const height = appData.config.pane_height;
    appData.faces.forEach(face => {
        face.height = height;
    });
    populatePaneList();
    draw2DPreview();
    update3DPreview();
});

document.getElementById('randomize-colors').addEventListener('click', () => {
    const colors = [
        '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8',
        '#F7DC6F', '#BB8FCE', '#85C1E9', '#82E0AA', '#F8B739',
        '#D7BDE2', '#A3E4D7', '#FAD7A0', '#AED6F1', '#F9E79F'
    ];
    appData.faces.forEach((face) => {
        face.color = colors[Math.floor(Math.random() * colors.length)];
    });
    populatePaneList();
    draw2DPreview();
    update3DPreview();
});

document.getElementById('reset-colors').addEventListener('click', () => {
    appData.faces.forEach(face => {
        face.color = face.default_color;
    });
    populatePaneList();
    draw2DPreview();
    update3DPreview();
});

// ============================================================
// EXPORT
// ============================================================

document.getElementById('generate-btn').addEventListener('click', async () => {
    const btn = document.getElementById('generate-btn');
    const status = document.getElementById('generate-status');
    const format = document.getElementById('export-format').value;

    btn.disabled = true;
    btn.textContent = 'Generating...';
    status.innerHTML = '<div class="loading"></div> Generating 3D model...';

    try {
        const requestBody = {
            faces: appData.faces,
            lines: appData.lines,
            frame_thickness: appData.config.frame_thickness,
            frame_height: appData.config.frame_height,
            frame_color: appData.config.frame_color,
            pane_height: appData.config.pane_height,
            export_format: format
        };

        const response = await fetch('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Generation failed');
        }

        // Download the file
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `stained_glass.${format}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);

        const sizeMB = (blob.size / 1024 / 1024).toFixed(2);
        status.innerHTML = `<div class="success">✓ Model generated! (${sizeMB} MB) Check your downloads.</div>`;

    } catch (error) {
        status.innerHTML = `<div class="error">✗ ${error.message}</div>`;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Generate & Download';
    }
});