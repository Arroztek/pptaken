# syntax=docker/dockerfile:1
# PPTaken image: multi-stage build of the pnpm workspace, production dependencies only, non-root, no package
# manager in the final image. Build from the repository root:
#   docker build -f docker/Dockerfile -t pptaken .
# Published as ghcr.io/arroztek/pptaken (linux/amd64 + linux/arm64, one native build per architecture; see
# .github/workflows/release.yml). Multi-arch notes: better-sqlite3 13 ships its prebuilt binaries inside the
# npm package, including linuxmusl-x64 and linuxmusl-arm64, so no compilation happens on either architecture (the build
# tools below are only a fallback) and nothing here is architecture specific. Only the musl binaries are kept.

FROM node:22-alpine AS build
# Compilers only in this stage, as a fallback for a native dependency without a prebuilt binary (none today).
RUN apk add --no-cache python3 make g++ && corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# The server and every workspace package it depends on; the web app when it is part of the checkout.
RUN pnpm --filter "@pptaken/server..." build \
 && if [ -f apps/web/package.json ]; then pnpm --filter "@pptaken/web..." build; fi
RUN pnpm --filter @pptaken/server deploy --prod --legacy /out \
 && mkdir -p /out/fonts && cp -r packages/ui/fonts/. /out/fonts/ \
 && if [ -d apps/web/dist ]; then cp -r apps/web/dist /out/web; else mkdir -p /out/web; fi \
 && rm -rf /out/src /out/test /out/browser /out/tsconfig*.json \
 && cd /out/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 \
 && rm -rf deps src build/Release/obj build/Release/obj.target build/Release/.deps build/deps build/test_extension.node \
 && find prebuilds -type f ! -name 'linuxmusl-*' -delete

FROM node:22-alpine
# Static labels so local builds are linked to the repository too; the release workflow adds version, revision and
# creation time (docker/metadata-action).
LABEL org.opencontainers.image.source="https://github.com/Arroztek/pptaken" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.title="PPTaken" \
      org.opencontainers.image.description="Self-hosted presentation player driven by AI agents over MCP."
ENV NODE_ENV=production \
    PPTAKEN_PORT=8080 \
    PPTAKEN_DATA_DIR=/data \
    PPTAKEN_WEB_DIR=/app/web \
    PPTAKEN_FONTS_DIR=/app/fonts
# No package managers in the final layer (security §8).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && printf '#!/bin/sh\nexec node /app/dist/main.js "$@"\n' > /usr/local/bin/pptaken && chmod 755 /usr/local/bin/pptaken \
 && mkdir -p /data && chown node:node /data && chmod 700 /data
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:${PPTAKEN_PORT}/healthz || exit 1
CMD ["node", "dist/main.js"]
