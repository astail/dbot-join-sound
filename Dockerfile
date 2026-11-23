# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

RUN mkdir sounds && chown node:node sounds

# ビルドしたコードの出所を Bot のステータスに出すため。ハッシュが変わるたびに
# 以降の層が無効化されるので、依存のインストールより後ろに置く
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT

USER node

CMD ["node", "dist/index.js"]
