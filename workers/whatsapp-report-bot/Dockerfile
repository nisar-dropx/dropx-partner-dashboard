# Baileys pulls libsignal from git, so the full Node image (which includes git) is used.
# Hosts build this in their own cloud (Railway, Render, Fly); no local Docker is needed.
FROM node:22-bookworm

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY lib.mjs auth-state.mjs server.mjs ./

# The worker keeps no important state on disk (the WhatsApp login lives in the portal),
# so no volume is needed. /tmp holds a short image cache only.
ENV PORT=8090
EXPOSE 8090

USER node
CMD ["node", "server.mjs"]
