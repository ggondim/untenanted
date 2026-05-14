# syntax=docker/dockerfile:1.6

FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /repo

# --- deps stage: install all workspace deps ---
FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY tsconfig.base.json turbo.json ./
COPY packages/types/package.json packages/types/
COPY packages/middleware/package.json packages/middleware/
COPY packages/adapter-zitadel/package.json packages/adapter-zitadel/
COPY packages/sdk/package.json packages/sdk/
COPY packages/api/package.json packages/api/
RUN pnpm install --frozen-lockfile=false

# --- build stage ---
FROM deps AS build
COPY packages/types packages/types
COPY packages/middleware packages/middleware
COPY packages/adapter-zitadel packages/adapter-zitadel
COPY packages/sdk packages/sdk
COPY packages/api packages/api
RUN pnpm --filter @untenanted/types build && \
    pnpm --filter @untenanted/middleware build && \
    pnpm --filter @untenanted/adapter-zitadel build && \
    pnpm --filter @untenanted/api build

# --- runtime ---
FROM node:20-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml /repo/pnpm-lock.yaml* ./
COPY --from=build /repo/packages/types/package.json packages/types/package.json
COPY --from=build /repo/packages/types/dist packages/types/dist
COPY --from=build /repo/packages/middleware/package.json packages/middleware/package.json
COPY --from=build /repo/packages/middleware/dist packages/middleware/dist
COPY --from=build /repo/packages/adapter-zitadel/package.json packages/adapter-zitadel/package.json
COPY --from=build /repo/packages/adapter-zitadel/dist packages/adapter-zitadel/dist
COPY --from=build /repo/packages/api/package.json packages/api/package.json
COPY --from=build /repo/packages/api/dist packages/api/dist

RUN pnpm install --prod --frozen-lockfile=false --filter @untenanted/api...

EXPOSE 3000
WORKDIR /app/packages/api
CMD ["node", "dist/main.js"]
