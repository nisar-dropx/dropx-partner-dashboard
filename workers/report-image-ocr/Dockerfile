FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .

ENV PORT=10000
ENV REPORT_IMAGE_OCR_CONCURRENCY=1
ENV REPORT_IMAGE_OCR_MAX_LONG_EDGE=1600
ENV REPORT_IMAGE_OCR_MAX_UPLOAD_MB=8
EXPOSE 10000
# Single worker keeps peak RSS inside Render free (~512 MB).
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers 1 --limit-concurrency 16"]
