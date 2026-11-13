# syntax=docker/dockerfile:1
# Phase-0 skeleton: builds the workspace and runs the server as a non-root user.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY packages/schema/package.json packages/schema/
RUN pnpm install --frozen-lockfile --filter @pptaken/server...
COPY apps/server apps/server
COPY packages/schema packages/schema
RUN pnpm --filter @pptaken/schema build && pnpm --filter @pptaken/server build \
 && pnpm --filter @pptaken/server deploy --prod --legacy /out

FROM node:22-alpine
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/main.js"]
