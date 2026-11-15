FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# These shared modules are imported by the backend using ../../ paths.
COPY sales-metrics.js lead-identity.js lead-answer-utils.js pricing-engine.js /app/
COPY --chown=node:node backend/src ./src
RUN mkdir -p data && chown node:node data

USER node
EXPOSE 3001
CMD ["node", "src/index.js"]
