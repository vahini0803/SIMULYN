# syntax=docker/dockerfile:1

# ── build ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

RUN corepack enable
WORKDIR /app

# Manifests first, so a dependency install is cached across code changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/executor/package.json ./apps/executor/

RUN pnpm install --frozen-lockfile --filter @simulyn/shared... --filter executor...

COPY packages/shared ./packages/shared
COPY apps/executor ./apps/executor

# The worker never touches the database, but @simulyn/shared re-exports the
# Prisma client, so the client has to exist for its build to typecheck.
RUN pnpm --filter @simulyn/shared db:postgres:generate \
 && pnpm --filter @simulyn/shared build \
 && pnpm --filter executor build

# ── run ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

# Toolchains for student submissions. This is the only image that needs them:
# the executor is where untrusted code actually runs.
RUN apk add --no-cache \
      python3 \
      g++ \
      libstdc++ \
      openjdk17-jdk \
      openssl \
      dumb-init \
 && ln -sf /usr/bin/python3 /usr/bin/python

RUN corepack enable
WORKDIR /app

ENV NODE_ENV=production \
    EXECUTOR_PORT=3002 \
    PYTHON_BIN=/usr/bin/python3 \
    CXX_BIN=/usr/bin/g++ \
    JAVAC_BIN=/usr/lib/jvm/java-17-openjdk/bin/javac \
    JAVA_BIN=/usr/lib/jvm/java-17-openjdk/bin/java

# Untrusted student code runs here, so never as root. The user is created
# before the copy so ownership can be set as the files land.
RUN addgroup -S simulyn && adduser -S simulyn -G simulyn

# Copied wholesale so pnpm's symlinked node_modules stay intact. --chown
# rather than a later `chown -R`: re-owning after the fact rewrites every
# file into a second layer, which nearly doubled the image size.
COPY --from=builder --chown=simulyn:simulyn /app /app

USER simulyn

EXPOSE 3002

# /readyz reports the queue connection; /healthz only reports liveness, so use
# readiness here — a worker that cannot reach Redis is doing nothing useful.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3002/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/executor/dist/main.js"]
