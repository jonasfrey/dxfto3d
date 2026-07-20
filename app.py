"""
FastAPI server for Stained Glass Generator.
Handles DXF upload, 3D model generation, and file export.
"""

import os
import tempfile
import logging
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Dict, Any
from starlette.background import BackgroundTask

from dxf_processor import process_dxf, generate_3d_model

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Stained Glass Generator")

# Serve static frontend files
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def root():
    """Serve the main HTML page."""
    return FileResponse("static/index.html")


@app.get("/api/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}


@app.post("/api/upload")
async def upload_dxf(file: UploadFile = File(...)):
    """
    Upload a DXF file and get back detected lines and faces.
    Returns JSON with face polygons for 2D/3D preview.
    """
    if not file.filename.lower().endswith('.dxf'):
        raise HTTPException(status_code=400, detail="Please upload a .dxf file")

    # Save uploaded file to temp location
    temp_dir = tempfile.mkdtemp()
    dxf_path = os.path.join(temp_dir, "upload.dxf")

    try:
        content = await file.read()
        with open(dxf_path, 'wb') as f:
            f.write(content)

        logger.info(f"Processing DXF: {file.filename} ({len(content)} bytes)")

        # Process the DXF
        result = process_dxf(dxf_path)

        logger.info(f"Found {len(result['faces'])} faces, {len(result['lines'])} line entities")

        return JSONResponse(content=result)

    except Exception as e:
        logger.error(f"DXF processing error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Processing error: {str(e)}")
    finally:
        # Clean up temp DXF file
        if os.path.exists(dxf_path):
            os.remove(dxf_path)
        try:
            os.rmdir(temp_dir)
        except OSError:
            pass


class GenerateRequest(BaseModel):
    """Request body for 3D model generation."""
    faces: List[Dict[str, Any]]
    lines: List[Dict[str, Any]]
    frame_thickness: float = 1.5
    frame_height: float = 2.0
    frame_color: str = "#222222"
    pane_height: float = 0.5
    export_format: str = "3mf"  # "3mf" or "stl"


@app.post("/api/generate")
async def generate_model(request: GenerateRequest):
    """
    Generate a 3D printable file from the configured faces and lines.
    Returns a 3MF (multi-color) or STL (single color) file.
    """
    temp_dir = tempfile.mkdtemp()

    try:
        logger.info(f"Generating 3D model: {len(request.faces)} faces, "
                    f"{len(request.lines)} lines, format={request.export_format}")

        output_path = generate_3d_model(request.dict(), temp_dir)

        if not os.path.exists(output_path):
            raise HTTPException(status_code=500, detail="Model generation failed - no output file")

        file_size = os.path.getsize(output_path)
        logger.info(f"Model generated: {output_path} ({file_size} bytes)")

        filename = f"stained_glass.{request.export_format}"

        # Clean up temp files after response is sent
        def cleanup():
            if os.path.exists(output_path):
                os.remove(output_path)
            try:
                os.rmdir(temp_dir)
            except OSError:
                pass

        media_type = "model/3mf" if request.export_format == "3mf" else "model/stl"

        return FileResponse(
            path=output_path,
            media_type=media_type,
            filename=filename,
            background=BackgroundTask(cleanup)
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Generation error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Generation error: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)