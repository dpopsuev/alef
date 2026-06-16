FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/ packages/
RUN npm ci --ignore-scripts
EXPOSE 0
HEALTHCHECK --interval=30s --timeout=5s CMD curl -sf http://localhost:${PORT:-3000}/health || exit 1
ENTRYPOINT ["npx", "tsx", "packages/runner/src/main.ts", "--serve", "0"]
