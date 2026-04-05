# syntax = docker/dockerfile:1

ARG NODE_VERSION=22.21.1
FROM node:${NODE_VERSION}-slim AS base

WORKDIR /app

ENV NODE_ENV="production"
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NEXT_TELEMETRY_DISABLED=1


# ── Build stage ────────────────────────────────────────────────────────────────
FROM base AS build

# System deps needed for native node modules
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y \
      build-essential \
      node-gyp \
      pkg-config \
      python-is-python3 && \
    rm -rf /var/lib/apt/lists/*

# Build-time public env vars (baked into the JS bundle by Next.js)
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_PRIVY_APP_ID
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_PRIVY_APP_ID=$NEXT_PUBLIC_PRIVY_APP_ID

COPY .npmrc package-lock.json package.json ./
RUN npm ci --include=dev

COPY . .
RUN npx next build

RUN npm prune --omit=dev


# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM base AS runner

# Install Chromium directly — more reliable than @sparticuz/chromium in containers
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y \
      chromium \
      ca-certificates \
      fonts-liberation && \
    rm -rf /var/lib/apt/lists/*

# Tell playwright-core to use the system Chromium
ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY --from=build /app /app

EXPOSE 3000

CMD ["npm", "run", "start"]
