# Build from the monorepo root:  docker build -f apps/server/Dockerfile -t quiz-server .
# Stage 1 installs everything the server package needs, compiles it, and prunes to
# production dependencies with `pnpm deploy`. Stage 2 is a small runtime image.

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY apps/server ./apps/server
RUN pnpm install --frozen-lockfile --filter @quiz/server... \
 && pnpm --filter @quiz/protocol build \
 && pnpm --filter @quiz/server build \
 && pnpm --filter @quiz/server deploy --prod --legacy /out

FROM node:22-alpine
ENV NODE_ENV=production PORT=4000 HOST=0.0.0.0
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:4000/healthz >/dev/null || exit 1
CMD ["node", "dist/index.js"]
