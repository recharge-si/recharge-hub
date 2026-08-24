# CLAUDE.md section 4: Node 22 LTS, two processes from one image.
# The image is built once and run as `web` or `worker` depending on the command.

FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY prisma ./prisma
RUN npx prisma generate

COPY . .
RUN npm run build

# ---

FROM node:22-alpine AS runtime
RUN apk add --no-cache openssl
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY prisma ./prisma
RUN npx prisma generate

COPY --from=build /app/build ./build
COPY --from=build /app/public ./public

EXPOSE 3000

# Overridden per service in docker-compose.yml.
CMD ["npm", "run", "docker-start"]
