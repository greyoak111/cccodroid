# Template only, build from the repository root. Review/pin the exact supported
# Node image digest for the deployment's architecture before using in production.
ARG NODE_IMAGE=node:24.11.0-alpine
FROM ${NODE_IMAGE}
WORKDIR /opt/cccodroid-relay
COPY remote-relay/package.json remote-relay/package-lock.json ./remote-relay/
RUN npm --prefix remote-relay ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY remote-relay/src ./remote-relay/src
# Inner TLS is terminated by the devices only; the relay imports no gateway code.
USER node
EXPOSE 8765
CMD ["node", "remote-relay/src/cli.mjs", "--config", "/run/relay-config/relay.json"]
