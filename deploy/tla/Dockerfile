# TLA+ tools for code cells (service "tla" in deploy/docker-compose.yml):
# SANY (parser), TLC (model checker) and the PlusCal translator, all in
# tla2tools.jar, plus a small Node bridge that runs them. At run time the
# container has no internet.
FROM node:24-bookworm-slim

ARG TLA_TOOLS_VERSION=1.7.4
ARG TLA_TOOLS_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88

RUN apt-get update \
 && apt-get install -y --no-install-recommends openjdk-17-jre-headless curl ca-certificates \
 && mkdir -p /opt/tla \
 && curl -sSfL "https://github.com/tlaplus/tlaplus/releases/download/v${TLA_TOOLS_VERSION}/tla2tools.jar" -o /opt/tla/tla2tools.jar \
 && echo "${TLA_TOOLS_SHA256}  /opt/tla/tla2tools.jar" | sha256sum -c - \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

USER node
WORKDIR /home/node/bridge
COPY --chown=node:node bridge/bridge.mjs ./

ENV NODE_ENV=production \
    TLA_JAR=/opt/tla/tla2tools.jar \
    TLA_TOOLS_VERSION=${TLA_TOOLS_VERSION}
EXPOSE 3400
CMD ["node", "/home/node/bridge/bridge.mjs"]
