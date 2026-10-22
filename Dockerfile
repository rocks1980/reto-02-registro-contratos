FROM oven/bun:1.4

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --production

COPY . .

EXPOSE 3000

CMD ["bun", "run", "src/server.ts"]
