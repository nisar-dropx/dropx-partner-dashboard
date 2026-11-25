"""
Local OCR service for Dark Store report screenshots.
No Gemini / Groq — Tesseract only. Deploy on Render free or the WorkSpaces VM.

  POST /ocr  multipart file=image
  GET  /health

Free-tier Render is ~512 MB. Defaults keep a single Tesseract job in that budget:
concurrency 1, long-edge ≤1600, no MedianFilter buffers, images closed after use.
"""

from __future__ import annotations

import asyncio
import gc
import io
import os
import re
from typing import Optional

import pytesseract
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image, ImageEnhance, ImageFile, ImageOps

# Refuse pathological pixel bombs before decode finishes expanding them.
Image.MAX_IMAGE_PIXELS = 40_000_000
ImageFile.LOAD_TRUNCATED_IMAGES = False

app = FastAPI(title="DropX Report Image OCR", version="1.2.0")
TOKEN = (os.environ.get("REPORT_IMAGE_OCR_TOKEN") or "").strip()
TESSERACT_CMD = (os.environ.get("TESSERACT_CMD") or "").strip()

# Free Render: one OCR at a time. Cap at 2 even if misconfigured higher.
DEFAULT_CONCURRENCY = 1
MAX_CONCURRENCY = 2
# Match the portal sharp preprocess so remote work is not re-inflated.
DEFAULT_MIN_LONG_EDGE = 1000
DEFAULT_MAX_LONG_EDGE = 1600
DEFAULT_MAX_UPLOAD_MB = 8
HARD_MAX_UPLOAD_MB = 12


def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw, 10)
    except ValueError:
        return default
    return max(minimum, min(maximum, value))


OCR_CONCURRENCY = _env_int(
    "REPORT_IMAGE_OCR_CONCURRENCY",
    DEFAULT_CONCURRENCY,
    minimum=1,
    maximum=MAX_CONCURRENCY,
)
MIN_LONG_EDGE = _env_int(
    "REPORT_IMAGE_OCR_MIN_LONG_EDGE",
    DEFAULT_MIN_LONG_EDGE,
    minimum=400,
    maximum=1600,
)
MAX_LONG_EDGE = _env_int(
    "REPORT_IMAGE_OCR_MAX_LONG_EDGE",
    DEFAULT_MAX_LONG_EDGE,
    minimum=MIN_LONG_EDGE,
    maximum=2200,
)
MAX_UPLOAD_BYTES = (
    _env_int(
        "REPORT_IMAGE_OCR_MAX_UPLOAD_MB",
        DEFAULT_MAX_UPLOAD_MB,
        minimum=1,
        maximum=HARD_MAX_UPLOAD_MB,
    )
    * 1024
    * 1024
)
_ocr_lock = asyncio.Semaphore(OCR_CONCURRENCY)

if TESSERACT_CMD:
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD


def require_token(authorization: Optional[str] = Header(default=None)) -> None:
    if not TOKEN:
        return
    expected = f"Bearer {TOKEN}"
    if (authorization or "").strip() != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")


def _close_image(image: Optional[Image.Image]) -> None:
    if image is None:
        return
    try:
        image.close()
    except Exception:  # noqa: BLE001 — best-effort cleanup under OOM pressure
        pass


def preprocess(image: Image.Image) -> Image.Image:
    """Boost contrast on handheld / dashboard screenshots for Tesseract.

    Avoid MedianFilter — it allocates another full-frame buffer and blows past
    free-tier RAM when stacked with Tesseract's own working set.
    Always copy into a private grayscale frame so closing never touches the
    caller's Image handle (Pillow may return the same object for no-op convert).
    """
    oriented = ImageOps.exif_transpose(image)
    try:
        working = oriented.convert("L").copy()
    finally:
        if oriented is not image:
            _close_image(oriented)

    width, height = working.size
    long_edge = max(width, height)
    if long_edge <= 0:
        _close_image(working)
        raise ValueError("Image has no usable dimensions")

    scale = 1.0
    if long_edge < MIN_LONG_EDGE:
        scale = MIN_LONG_EDGE / long_edge
    elif long_edge > MAX_LONG_EDGE:
        scale = MAX_LONG_EDGE / long_edge

    if abs(scale - 1.0) > 0.05:
        resized = working.resize(
            (max(1, int(width * scale)), max(1, int(height * scale))),
            Image.Resampling.LANCZOS,
        )
        if resized is not working:
            _close_image(working)
        working = resized

    contrasted = ImageOps.autocontrast(working)
    if contrasted is not working:
        _close_image(working)
        working = contrasted

    sharpened = ImageEnhance.Sharpness(working).enhance(1.4)
    if sharpened is not working:
        _close_image(working)
        working = sharpened
    return working


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
    busy = OCR_CONCURRENCY - _ocr_lock._value  # noqa: SLF001 — probe only
    return {
        "ok": True,
        "tesseract": version,
        "concurrency": OCR_CONCURRENCY,
        "busy": max(0, busy),
        "min_long_edge": MIN_LONG_EDGE,
        "max_long_edge": MAX_LONG_EDGE,
        "max_upload_mb": MAX_UPLOAD_BYTES // (1024 * 1024),
    }


@app.post("/ocr")
async def ocr(
    file: UploadFile = File(...),
    _: None = Depends(require_token),
) -> JSONResponse:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Image larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB",
        )

    image: Optional[Image.Image] = None
    prepared: Optional[Image.Image] = None
    text = ""

    async with _ocr_lock:
        try:
            try:
                with Image.open(io.BytesIO(raw)) as opened:
                    opened.load()
                    image = opened.copy()
            except Image.DecompressionBombError as exc:
                raise HTTPException(
                    status_code=413,
                    detail="Image pixel dimensions are too large",
                ) from exc
            finally:
                # Drop the upload buffer before Tesseract allocates its working set.
                raw = b""

            prepared = preprocess(image)
            _close_image(image)
            image = None
            # Tesseract is CPU-bound — keep the event loop free for health checks.
            text = await asyncio.to_thread(run_ocr, prepared)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=f"OCR failed: {exc}") from exc
        finally:
            _close_image(prepared)
            prepared = None
            _close_image(image)
            image = None
            gc.collect()

    if not text.strip():
        raise HTTPException(status_code=422, detail="No text found in image")
    return JSONResponse({"text": text, "engine": "tesseract"})
