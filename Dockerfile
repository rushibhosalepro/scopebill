FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY web ./web
RUN bun run build

FROM oven/bun:1.4 AS app
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY --from=build /app/dist ./dist
USER bun
EXPOSE 3000
CMD ["bun", "src/server/index.ts"]
