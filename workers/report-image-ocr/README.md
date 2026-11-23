# Report Image OCR (Tesseract)

Local OCR for Dark Store completion screenshots. **No Gemini / Groq.**

Used by the portal scrapers for:

- Cycle count, SBC & SRC
- Expiry removed
- DG fuel level

Stowing pendency is text-only and does not need this service.

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

If `REPORT_IMAGE_OCR_URL` is unset, the portal falls back to in-process `tesseract.js`.

## Render

Create a Web Service from this folder (`Dockerfile`), set `REPORT_IMAGE_OCR_TOKEN`, and put the public URL into the portal env as `REPORT_IMAGE_OCR_URL`.
