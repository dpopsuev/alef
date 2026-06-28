FROM node:22-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
COPY packages/ packages/
RUN corepack enable && pnpm install --frozen-lockfile --ignore-scripts

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app .
RUN corepack enable

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -sf http://127.0.0.1:3000/ready || exit 1
ENTRYPOINT ["pnpm", "--filter", "@dpopsuev/alef", "start", "--", "--daemon", "--host", "0.0.0.0", "--serve", "3000"]
