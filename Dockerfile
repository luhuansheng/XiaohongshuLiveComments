FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node config/rooms.example.json config/settings.example.json ./config/
RUN mkdir -p /app/data /app/outputs && chown -R node:node /app/config /app/data /app/outputs

ENV HOST=0.0.0.0
ENV PORT=8789
EXPOSE 8789
USER node

CMD ["node", "src/cli.cjs"]
