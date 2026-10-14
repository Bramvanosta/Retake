# The Northfield fixture as an image, for its Docker sandbox (projects/northfield-fixture/sandbox/docker/) and for
# trying a docker-compose sandbox end to end. Node alone, no npm install: the server needs no npm package at run time
# (bundle.mjs), and the UI bundle is the one built on this machine (public/build/: run `node build.mjs`, or start the
# fixture once, before `studio sandbox up … --build`). Build context: this folder (.dockerignore keeps only what the
# server reads). No Chromium in the image: the quote PDF route (/quotes/<id>/quote.pdf) answers 500 here.
#
#   docker build -t demo-studio-northfield-fixture fixtures/wholesale
#   docker run --rm -p 127.0.0.1:4401:4401 -p 127.0.0.1:4402:4402 demo-studio-northfield-fixture
FROM node:22-alpine

WORKDIR /fixture
COPY . .
RUN test -f public/build/build.json || { echo 'No UI bundle in public/build: run "node fixtures/wholesale/build.mjs" on the host first' >&2; exit 1; }

# Every interface of the container (Docker publishes the ports); the same port numbers inside and outside keep the
# fixture's own absolute URLs (links in its mails, the apps' boot URLs) right on the host.
ENV NORTHFIELD_HOST=0.0.0.0 \
    NORTHFIELD_CONSOLE_PORT=4401 \
    NORTHFIELD_SHOP_PORT=4402 \
    NORTHFIELD_AUTH_CONSOLE_PORT=4403 \
    NORTHFIELD_AUTH_SHOP_PORT=4404
EXPOSE 4401 4402 4403 4404
USER node

# 127.0.0.1, not localhost: busybox wget resolves localhost to ::1 first, where the server does not listen.
HEALTHCHECK --interval=2s --timeout=3s --start-period=30s --retries=10 \
  CMD wget -qO- "http://127.0.0.1:${NORTHFIELD_CONSOLE_PORT}/api/health" > /dev/null || exit 1
CMD ["node", "server.mjs", "--no-build"]
