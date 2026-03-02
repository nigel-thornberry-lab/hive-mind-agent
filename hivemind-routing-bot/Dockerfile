# Run the chain-listening bot 24/7. Seed must be provided at runtime (secret or mount).
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV NODE_ENV=production
# Chain-listening bot: pings and replies to messages. Seed via BOT_SEED_FILE or BOT_SEED.
CMD ["node", "dist/src/bot-loop.js"]
