FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build:docker

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    ROKIT_BRIDGE_HOST=0.0.0.0 \
    ROKIT_BRIDGE_PORT=8787

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-electron/server ./dist-electron/server

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/health >/dev/null || exit 1

CMD ["npm", "run", "start:prod"]
