FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Build-time CSP mode (see csp.config.js): --build-arg RATIO_CSP_MODE=report-only
ARG RATIO_CSP_MODE=
ENV RATIO_CSP_MODE=$RATIO_CSP_MODE
RUN npm run build && mkdir -p /app/state && chown node:node /app/state

FROM build AS simulation
# Local simulation image only. Production deployments must never set RATIO_SIMULATION_IMAGE, RATIO_SIMULATION or a development/test RATIO_ENV.
ENV NODE_ENV=production RATIO_ENV=development RATIO_SIMULATION=1 RATIO_SIMULATION_IMAGE=1 RATIO_SIMULATION_DB=/app/state/customer.sqlite
USER node
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "-p", "3000"]

# Customer engagement artifact (R12). Same build stage plus the worker CLI (dist-worker, also the migrator), dev
# dependencies pruned. Production mode, engagement mode, NO simulation variable. The compose file adds the read-only
# root filesystem, the dropped capabilities and the read-only config mounts; /state is the only writable path.
FROM build AS engagement-build
RUN npm run worker:build && npm prune --omit=dev && mkdir -p /state && chown node:node /state

FROM engagement-build AS engagement
ENV NODE_ENV=production RATIO_MODE=engagement RATIO_ENGAGEMENT_CONFIG=/config/engagement.json RATIO_ENV=production
VOLUME ["/state"]
USER node
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "-p", "3000"]
