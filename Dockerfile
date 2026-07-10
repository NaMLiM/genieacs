# syntax=docker/dockerfile:1
# GenieACS — Minimal Dockerfile for clean upstream/master
# (Adapted from the fork's multi-stage Dockerfile on the `dev` branch)

FROM node:22-alpine AS build
WORKDIR /opt/genieacs

RUN apk add --no-cache tini git

COPY package.json npm-shrinkwrap.json ./
RUN npm ci && npm cache clean --force

COPY tsconfig.json eslint.config.mjs ./
COPY README.md LICENSE CHANGELOG.md ./
COPY build/ build/
COPY bin/ bin/
COPY lib/ lib/
COPY ui/ ui/
COPY seed/ seed/
COPY public/ public/

# Build requires git metadata; create a minimal dummy repo
RUN git init && git config user.email docker@genieacs.local && git config user.name "Docker Build" && \
    git add -A && git commit -m "build" --allow-empty && \
    npm run build && rm -rf .git

FROM node:22-alpine AS prod
WORKDIR /opt/genieacs

RUN apk add --no-cache tini

COPY --from=build /opt/genieacs/node_modules node_modules/
COPY --from=build /opt/genieacs/dist/ ./

# Add binaries to PATH
ENV PATH=/opt/genieacs/bin:$PATH

EXPOSE 7547 7557 7567 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "genieacs.js"]
