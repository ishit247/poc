# One file, two images (see docker-compose.yml):
#   --target api      API + the migrate/seed scripts (same image, different command)
#   --target counter  built counter app behind nginx, which also proxies /api to the API
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/counter/package.json apps/counter/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

FROM deps AS src
COPY . .

FROM src AS counter-build
RUN pnpm --filter @pos/counter build

# The API runs from TypeScript source through tsx, as in development: the repo has no compile step for it.
FROM src AS api
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "--import", "tsx", "apps/api/src/server.ts"]

FROM nginx:alpine AS counter
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=counter-build /app/apps/counter/dist /usr/share/nginx/html
EXPOSE 80
