# C++ for code cells (service "cpp" in deploy/docker-compose.yml): g++ with
# AddressSanitizer/UBSan and a small Node bridge that compiles the cell and
# runs the tutor's tests. At run time the container has no internet.
FROM node:24-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ libc6-dev \
 && rm -rf /var/lib/apt/lists/* \
 && g++ --version

USER node
WORKDIR /home/node/bridge
COPY --chown=node:node bridge/bridge.mjs bridge/lh_test.hpp ./

ENV NODE_ENV=production
EXPOSE 3500
CMD ["node", "/home/node/bridge/bridge.mjs"]
