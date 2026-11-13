FROM node:22-bookworm-slim

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
# The portal serves a Let's Encrypt chain rooted at ISRG Root YE (newer than Node's
# bundled CA list, and not sent by the server). The bundled PEM holds that root
# cross-signed by the universally-trusted ISRG Root X2, so pointing NODE_EXTRA_CA_CERTS
# at it lets global fetch validate the chain WITHOUT disabling TLS verification.
ENV NODE_EXTRA_CA_CERTS=/app/isrg-root-ye.pem

EXPOSE 8080

CMD ["node", "server.mjs"]
