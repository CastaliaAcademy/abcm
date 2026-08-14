FROM oven/bun:1.3.14 AS dependencies

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS build

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.3.14 AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV HOME=/tmp

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist

USER bun
EXPOSE 8787

CMD ["bun", "run", "dist/cli/rest-server.js"]
