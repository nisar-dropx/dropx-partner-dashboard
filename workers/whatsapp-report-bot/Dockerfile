# Baileys pulls libsignal from git, so the full Node image (which includes git) is used.
FROM node:22-bookworm

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY lib.mjs server.mjs ./

ENV PORT=8090
ENV DATA_DIR=/data
# A new named volume copies this ownership, so the non-root user can write the session.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8090

USER node
CMD ["node", "server.mjs"]
