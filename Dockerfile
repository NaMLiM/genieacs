# syntax=docker/dockerfile:1
# GenieACS Fork — Multi-stage Dockerfile

# ── Stage 0: dependencies (prod only) ────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /opt/genieacs

RUN apk add --no-cache tini
COPY package.json npm-shrinkwrap.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── Stage 1: build (prod + dev deps) ─────────────────────────────
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

# ── Stage 2: production image ────────────────────────────────────
FROM node:22-alpine AS prod
WORKDIR /opt/genieacs

RUN apk add --no-cache tini

COPY --from=deps /opt/genieacs/node_modules node_modules/
COPY --from=build /opt/genieacs/dist/ ./

EXPOSE 7547 7557 7567 3000

ENTRYPOINT ["/sbin/tini", "--"]

# ── Stage 3: dev image (hot-reload) ──────────────────────────────
FROM node:22-alpine AS dev
WORKDIR /opt/genieacs

RUN apk add --no-cache tini git curl

# Install all deps (prod + dev)
COPY package.json npm-shrinkwrap.json ./
RUN npm ci && npm cache clean --force

# Build once at image creation
COPY tsconfig.json eslint.config.mjs ./
COPY README.md LICENSE CHANGELOG.md ./
COPY build/ build/
COPY bin/ bin/
COPY lib/ lib/
COPY ui/ ui/
COPY seed/ seed/
COPY public/ public/

RUN git init && git config user.email docker@genieacs.local && git config user.name "Docker Build" && \
    git add -A && git commit -m "build" --allow-empty && \
    npm run build && rm -rf .git

# Override config defaults so services bind to 0.0.0.0
ENV GENIEACS_CWMP_INTERFACE=0.0.0.0
ENV GENIEACS_NBI_INTERFACE=0.0.0.0
ENV GENIEACS_FS_INTERFACE=0.0.0.0
ENV GENIEACS_UI_INTERFACE=0.0.0.0
ENV GENIEACS_MONGODB_CONNECTION_URL=mongodb://mongodb:27017/genieacs

EXPOSE 7547 7557 7567 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "genieacs-cwmp & genieacs-nbi & genieacs-fs & genieacs-ui & wait"]
