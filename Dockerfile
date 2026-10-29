# docs/BUILD_SPEC.md section 4: Node 22 LTS, two processes from one image.
# The image is built once and run as `web` or `worker` depending on the command.
#
# `prisma/` is copied before `npm ci` because the postinstall script generates
# the Prisma client and needs the schema to be there already.

FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# ---

FROM node:22-alpine AS runtime
RUN apk add --no-cache openssl

# The rig builder asks a model through claude-pool (docs/rig-builder.md §
# Image). claude-pool is a single Python script, vendored in ops/claude-pool and
# pinned by hash; the `claude` CLI is pinned by version. The native `claude`
# binary needs libgcc, libstdc++ and ripgrep on Alpine (musl). UNVERIFIED: this
# stage has not been built or run; if `claude` does not start on musl, switch
# this stage to node:22-bookworm-slim (apt-get install python3 ripgrep) and keep
# the rest as it is.
ARG CLAUDE_CODE_VERSION=2.1.312
ARG CLAUDE_POOL_SHA256=2bf027531d540cf010c915e0130cf49ddeaadfb36a3cdcfd0ed0429633598eb8
RUN apk add --no-cache python3 libgcc libstdc++ ripgrep \
 && npm install -g --no-audit --no-fund @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force
ENV USE_BUILTIN_RIPGREP=0
COPY ops/claude-pool/claude-pool /usr/local/bin/claude-pool
RUN echo "${CLAUDE_POOL_SHA256}  /usr/local/bin/claude-pool" | sha256sum -c - \
 && chmod 755 /usr/local/bin/claude-pool
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/build ./build
COPY --from=build /app/public ./public

# The commit this image was built from. Last, so a new SHA does not bust the
# cached layers above. The deploy checks it inside the running container.
ARG GIT_SHA=unknown
ENV APP_VERSION=$GIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA
# Links the GHCR package to the repository (visibility + access follow it).
LABEL org.opencontainers.image.source=https://github.com/recharge-si/recharge-hub

EXPOSE 3000

# Overridden per service in docker-compose.yml.
CMD ["npm", "run", "start"]
