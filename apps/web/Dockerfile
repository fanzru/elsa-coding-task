# Build from the monorepo root:
#   docker build -f apps/web/Dockerfile -t quiz-web \
#     --build-arg NEXT_PUBLIC_QUIZ_HTTP_URL=https://quiz.example.com \
#     --build-arg NEXT_PUBLIC_QUIZ_WS_URL=wss://quiz.example.com/ws .
# NEXT_PUBLIC_* values are inlined at build time. Leave them unset and the client assumes the
# quiz server is on port 4000 of the host serving the page.

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
ARG NEXT_PUBLIC_QUIZ_HTTP_URL
ARG NEXT_PUBLIC_QUIZ_WS_URL
# Public URL of the web app itself: makes og:image / canonical links absolute.
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_QUIZ_HTTP_URL=$NEXT_PUBLIC_QUIZ_HTTP_URL NEXT_PUBLIC_QUIZ_WS_URL=$NEXT_PUBLIC_QUIZ_WS_URL NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter @quiz/web... \
 && pnpm --filter @quiz/protocol build \
 && pnpm --filter @quiz/web build

FROM node:22-alpine
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
CMD ["node", "apps/web/server.js"]
