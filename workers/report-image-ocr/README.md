# Report Image OCR (Tesseract)

Local OCR for Dark Store completion screenshots. **No Gemini / Groq.**

Used by the portal scrapers for:

- Cycle count, SBC & SRC
- Expiry removed
- DG fuel level

Stowing pendency is text-only and does not need this service.

## Free-tier memory (Render)

Render free web services have ~512 MB RAM. This service is tuned for that budget:

| Setting | Default | Why |
| --- | --- | --- |
| `REPORT_IMAGE_OCR_CONCURRENCY` | `1` | One Tesseract job at a time |
| `REPORT_IMAGE_OCR_MAX_LONG_EDGE` | `1600` | Cap decode/upscale buffers |
| `REPORT_IMAGE_OCR_MAX_UPLOAD_MB` | `8` | Reject oversized uploads early |
| uvicorn `--workers` | `1` | No multi-process RSS duplication |

Do **not** raise concurrency above `2` on free. Prefer leaving the portal's `tesseract.js` fallback for bulk spikes rather than paying for a larger instance.

## Run locally

```bash
# Windows: install Tesseract from https://github.com/UB-Mannheim/tesseract/wiki
# then set TESSERACT_CMD if needed, e.g. C:\Program Files\Tesseract-OCR\tesseract.exe
pip install -r requirements.txt
uvicorn main:app --reload --port 8091
```

## Portal env

```
REPORT_IMAGE_OCR_URL=https://your-ocr.onrender.com
REPORT_IMAGE_OCR_TOKEN=long-random-token
```

If `REPORT_IMAGE_OCR_URL` is unset, or the remote OCR OOMs / times out, the portal falls back to in-process `tesseract.js`.

## Render

Create a Web Service from this folder (`Dockerfile`), set `REPORT_IMAGE_OCR_TOKEN`, keep the free-tier env defaults above, and put the public URL into the portal env as `REPORT_IMAGE_OCR_URL`.

Redeploy helper (repo root):

```bash
node scripts/deploy-report-image-ocr-render.mjs
```
