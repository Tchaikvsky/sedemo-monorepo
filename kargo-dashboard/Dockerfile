FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
# Mount your config at /app/config.json (or set CONFIG_PATH). Tokens come from env vars.
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
