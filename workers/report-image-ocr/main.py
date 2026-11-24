"""
Local OCR service for Dark Store report screenshots.
No Gemini / Groq — Tesseract only. Deploy on Render or the WorkSpaces VM.

  POST /ocr  multipart file=image
  GET  /health

Bulk inbound: concurrent requests are limited so Tesseract stays stable under load.
"""

from __future__ import annotations

import asyncio
import io
import os
import re
from typing import Optional

import pytesseract
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image, ImageEnhance, ImageFilter, ImageOps

app = FastAPI(title="DropX Report Image OCR", version="1.1.0")
TOKEN = (os.environ.get("REPORT_IMAGE_OCR_TOKEN") or "").strip()
TESSERACT_CMD = (os.environ.get("TESSERACT_CMD") or "").strip()
# Keep Tesseract from thrashing when many screenshots arrive together.
OCR_CONCURRENCY = max(1, int(os.environ.get("REPORT_IMAGE_OCR_CONCURRENCY") or "2"))
_ocr_lock = asyncio.Semaphore(OCR_CONCURRENCY)

if TESSERACT_CMD:
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD


def require_token(authorization: Optional[str] = Header(default=None)) -> None:
    if not TOKEN:
        return
    expected = f"Bearer {TOKEN}"
    if (authorization or "").strip() != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")


def preprocess(image: Image.Image) -> Image.Image:
    """Boost contrast on handheld / dashboard screenshots for Tesseract."""
    image = ImageOps.exif_transpose(image)
    image = image.convert("L")
    # Upscale small phone captures so digits stay legible.
    width, height = image.size
    scale = 1.0
    if max(width, height) < 1200:
        scale = 1200 / max(width, height)
    elif max(width, height) > 2200:
        scale = 2200 / max(width, height)
    if abs(scale - 1.0) > 0.05:
        image = image.resize(
            (max(1, int(width * scale)), max(1, int(height * scale))),
            Image.Resampling.LANCZOS,
        )
    image = ImageOps.autocontrast(image)
    image = ImageEnhance.Sharpness(image).enhance(1.4)
    image = image.filter(ImageFilter.MedianFilter(size=3))
    return image


def run_ocr(image: Image.Image) -> str:
    config = "--oem 3 --psm 6 -c preserve_interword_spaces=1"
    text = pytesseract.image_to_string(image, lang="eng", config=config)
    # Collapse noisy blank lines but keep row structure for label/number pairing.
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines()]
    return "\n".join(line for line in lines if line)


_TESSERACT_VERSION: Optional[str] = None


def _tesseract_version_cached() -> str:
    global _TESSERACT_VERSION
    if _TESSERACT_VERSION is None:
        _TESSERACT_VERSION = str(pytesseract.get_tesseract_version())
    return _TESSERACT_VERSION


@app.get("/health")
def health() -> dict:
    # Keep this cheap — Render's free-tier health probe times out at ~5s and must
    # not wait behind a busy OCR semaphore or a cold Tesseract spawn every time.
    try:
        version = _tesseract_version_cached()
    except Exception as exc:  # noqa: BLE001 — surface install problems in health
        return {"ok": False, "error": str(exc)}
    return {
        "ok": True,
        "tesseract": version,
        "concurrency": OCR_CONCURRENCY,
        "busy": OCR_CONCURRENCY - _ocr_lock._value,  # noqa: SLF001 — probe only
    }


@app.post("/ocr")
async def ocr(
    file: UploadFile = File(...),
    _: None = Depends(require_token),
) -> JSONResponse:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(raw) > 12 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image larger than 12 MB")

    async with _ocr_lock:
        try:
            image = Image.open(io.BytesIO(raw))
            prepared = preprocess(image)
            # Tesseract is CPU-bound — keep the event loop free for health checks.
            text = await asyncio.to_thread(run_ocr, prepared)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=f"OCR failed: {exc}") from exc

    if not text.strip():
        raise HTTPException(status_code=422, detail="No text found in image")
    return JSONResponse({"text": text, "engine": "tesseract"})
