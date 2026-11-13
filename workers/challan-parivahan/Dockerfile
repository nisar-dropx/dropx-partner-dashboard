FROM node:20-bookworm-slim

WORKDIR /app

# tesseract.js runs its OCR engine as WASM, so no system tesseract is needed.
# ca-certificates lets us reach the Parivahan and Supabase HTTPS endpoints.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY parivahan.mjs captcha.mjs tls.mjs server.mjs ./
COPY scripts ./scripts
# Bundled cross-signed root so Node can validate the portal's ISRG Root YE chain.
COPY isrg-root-ye.pem ./isrg-root-ye.pem
# Bundled English OCR model so the container never downloads language data at runtime.
COPY eng.traineddata ./eng.traineddata

ENV NODE_ENV=production
ENV PORT=8080
ENV TESSDATA_PATH=/app
# The portal uses a Let's Encrypt chain rooted at ISRG Root YE, newer than Node's
# bundled CA list. Debian's ca-certificates package keeps the current roots, so point
# Node at the system trust store instead of disabling TLS verification.
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

EXPOSE 8080

CMD ["node", "server.mjs"]
