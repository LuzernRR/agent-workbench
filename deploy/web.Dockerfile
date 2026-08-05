# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS dependencies

WORKDIR /workspace/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --ignore-scripts

FROM node:22-bookworm-slim AS builder

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /workspace
COPY --from=dependencies /workspace/apps/web/node_modules ./apps/web/node_modules
COPY apps/web ./apps/web
COPY packages/contracts ./packages/contracts
WORKDIR /workspace/apps/web
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3100 \
    HOSTNAME=0.0.0.0

RUN groupadd --gid 10001 workbench \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin workbench

WORKDIR /workspace
COPY --from=builder --chown=workbench:workbench /workspace/apps/web/.next/standalone ./
COPY --from=builder --chown=workbench:workbench /workspace/apps/web/public ./apps/web/public
COPY --from=builder --chown=workbench:workbench /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=workbench:workbench /workspace/apps/web/dist ./apps/web/dist

USER 10001:10001
EXPOSE 3100
CMD ["node", "apps/web/server.js"]
