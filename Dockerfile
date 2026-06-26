# Conclave coordination server — bus (WS) + HTTP API for tasks, conversations, and data
# exchange (blobs). Deploy on any reachable host (VM / tailscale node).
#
#   docker build -t wenpeishao/conclave:0.2 .
#   docker run -d --name conclave -p 8787:8787 -p 8088:8088 \
#       -e CONCLAVE_TOKEN=<connect> -e CONCLAVE_ADMIN_TOKEN=<admin> \
#       -v conclave-data:/data wenpeishao/conclave:0.2
#
# Passing BOTH tokens => SECURE mode (per-agent signed identities + zones); the CMD's `serve`
# reads them from the env. Omit CONCLAVE_ADMIN_TOKEN for legacy shared-token mode (private nets).
# Then enroll nodes with `conclave invite` / `conclave join --enroll` (see deploy/README.md).
FROM node:22-slim

WORKDIR /app

# Install deps first (cached layer). tsx runs the TypeScript at runtime.
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund && npm cache clean --force

# App source (node_modules / tests / examples excluded via .dockerignore).
COPY src ./src
COPY sdk ./sdk
COPY spec ./spec
COPY README.md STATUS.md LICENSE ./

ENV CONCLAVE_DATA=/data \
    NODE_ENV=production
# CONCLAVE_TOKEN (connect) gates connections; CONCLAVE_ADMIN_TOKEN additionally turns on SECURE
# mode (per-agent signed identities). `serve` in the CMD reads both. 8787 = WS bus, 8088 = HTTP API.
EXPOSE 8787 8088
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8088/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/cli.ts", "serve", "--port", "8787", "--http", "8088", "--data", "/data"]
