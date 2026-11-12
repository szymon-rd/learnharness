# Rocq + Iris for code cells (service "rocq" in deploy/docker-compose.yml):
# the Rocq Prover 9.0, coq-lsp (the language server behind the cell's live
# errors and goals), Iris and HeapLang, and a small Node bridge. The first
# build compiles coq-lsp and Iris (10–20 minutes); at run time the
# container has no internet.
FROM node:24-bookworm-slim AS bridge
WORKDIR /bridge
COPY bridge/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY bridge/bridge.mjs ./

FROM rocq/rocq-prover:9.0
ARG COQ_LSP_VERSION=0.2.5+9.0
ARG IRIS_VERSION=4.4.0
# The image pins ocamlfind 1.9.6; coq-lsp needs >= 1.9.8 (Rocq is rebuilt
# against it, still 9.0.1).
RUN opam update -y \
 && opam pin remove -y -n ocamlfind \
 && opam install -y "coq-lsp.${COQ_LSP_VERSION}" "coq-iris.${IRIS_VERSION}" "coq-iris-heap-lang.${IRIS_VERSION}" \
 && opam clean -a -c -s --logs \
 && rocq --version && coq-lsp --version

COPY --from=bridge /usr/local/bin/node /usr/local/bin/node
COPY --from=bridge --chown=rocq:rocq /bridge /home/rocq/bridge
RUN mkdir -p /home/rocq/cells

ENV NODE_ENV=production \
    ROCQ_CELLS=/home/rocq/cells \
    IRIS_VERSION=${IRIS_VERSION}
WORKDIR /home/rocq/bridge
EXPOSE 3600
CMD ["node", "/home/rocq/bridge/bridge.mjs"]
