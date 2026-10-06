FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && mkdir -p /app/state && chown node:node /app/state

FROM build AS simulation
ENV NODE_ENV=production RATIO_ENV=development RATIO_SIMULATION=1 RATIO_SIMULATION_DB=/app/state/customer.sqlite
USER node
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "-p", "3000"]
