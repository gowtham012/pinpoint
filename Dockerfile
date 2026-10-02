# For MCP directories (Glama) that build a server to list its tools and score it. Pinpoint itself
# is local by design — the bridge talks to your browser and Simulator on 127.0.0.1 — so a hosted
# container is only good for inspection; to use it, follow the README.
FROM node:22-alpine
WORKDIR /app
COPY bridge/package.json bridge/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY bridge/ ./
ENTRYPOINT ["node", "cli.js", "mcp"]
