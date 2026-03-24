FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src

RUN npm ci
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg tini \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV DOWNLOAD_DIR=/tmp/telegram-mcp

WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build

USER node

ENTRYPOINT ["tini", "--"]
CMD ["node", "build/index.js"]
