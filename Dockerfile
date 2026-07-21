# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

WORKDIR /app

RUN corepack enable

ADD beta-cursos-deploy.tar.gz /app/

RUN pnpm install --no-frozen-lockfile

RUN pnpm build
RUN pnpm prune --prod

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

RUN apt-get update \
    && apt-get install --yes --no-install-recommends dumb-init gosu \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /app /app

RUN chmod 0755 /app/railway/docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--", "/app/railway/docker-entrypoint.sh"]
CMD ["node", "railway/server.mjs"]
