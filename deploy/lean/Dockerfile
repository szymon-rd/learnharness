# Lean 4 + Mathlib for code cells (service "lean" in deploy/docker-compose.yml).
# The first build downloads the toolchain, Mathlib's source and its prebuilt
# cache (several GB) and takes 10–20 minutes; later deploys reuse the image
# until this folder changes. At run time the container has no internet.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Everything below belongs to the unprivileged "node" user from the base image.
USER node
ENV ELAN_HOME=/home/node/.elan \
    PATH=/home/node/.elan/bin:$PATH
WORKDIR /home/node

COPY --chown=node:node project/lean-toolchain /home/node/project/lean-toolchain
RUN curl -sSfL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -o /tmp/elan-init.sh \
 && sh /tmp/elan-init.sh -y --no-modify-path --default-toolchain "$(cat /home/node/project/lean-toolchain)" \
 && rm /tmp/elan-init.sh \
 && lean --version

WORKDIR /home/node/project
COPY --chown=node:node project/lakefile.toml ./
# Resolve Mathlib (pinned in lakefile.toml), fetch its prebuilt .olean cache,
# then load all of Mathlib once to prove the install is complete.
RUN lake update \
 && lake exe cache get \
 && printf 'import Mathlib\n#eval Lean.versionString\n' > /tmp/Warm.lean \
 && lake env lean /tmp/Warm.lean \
 && rm /tmp/Warm.lean \
 && rm -rf /home/node/.cache

WORKDIR /home/node/bridge
COPY --chown=node:node bridge/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --chown=node:node bridge/bridge.mjs ./

ENV NODE_ENV=production \
    LEAN_PROJECT=/home/node/project
EXPOSE 3300
CMD ["node", "/home/node/bridge/bridge.mjs"]
