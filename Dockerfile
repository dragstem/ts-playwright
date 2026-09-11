FROM node:22-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

RUN corepack enable

WORKDIR /app

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/server/tsconfig.json apps/server/tsconfig.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY packages/runner/package.json packages/runner/package.json
COPY packages/runner/tsconfig.json packages/runner/tsconfig.json

RUN pnpm install --frozen-lockfile --filter @ts-playwright/server...

FROM deps AS build

COPY apps/server/src apps/server/src
COPY packages/shared/src packages/shared/src
COPY packages/runner/src packages/runner/src

RUN pnpm run build:server

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV APP_HOST=0.0.0.0
ENV APP_PORT=8000
ENV APP_STORAGE_DIR=/data

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates docker.io tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/runner/package.json ./packages/runner/package.json
COPY --from=build /app/packages/runner/dist ./packages/runner/dist

# Phase 1 / P1-T08: run as the non-root `node` user (uid 1000, already present in the base image).
# Under rootless Docker the container's user is further remapped to an unprivileged host uid,
# so the server never runs as host-root even when talking to the Docker socket.
# Docker socket access: rootless maps the mounted socket to this user; for a root-socket setup
# pass the host docker GID via compose `group_add` (see deploy/ubuntu/RUNBOOK.md).
RUN mkdir -p /data && chown -R node:node /data /app

EXPOSE 8000
VOLUME ["/data"]

USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/server/dist/index.js"]
