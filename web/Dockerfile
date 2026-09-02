# Cloud Run image for the D6 web app: the API/SSE server AND the built frontend, in one
# service on one origin.
#
# Why one service rather than Firebase Hosting + a separate API:
#   - the live-status channel is SSE. A Hosting rewrite in front of a streaming response
#     reintroduces the 60s-class ceiling sec 16.1 exists to keep the reasoner away from, and a
#     separate origin would need CORS on that stream.
#   - same origin means the frontend's existing relative `/api/...` calls work unchanged in
#     production, exactly as they do behind Vite's dev proxy.
#
# Build context is the REPO ROOT (the server imports @shared/@services), same as the reasoner
# worker's image - see scripts/cloudbuild.web.yaml.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY shared ./shared
COPY services ./services
COPY scripts ./scripts
COPY web ./web
# Vite inlines VITE_* at BUILD time, so the Firebase web config has to be present here, not at
# runtime. These are public client identifiers (a Firebase web apiKey identifies a project, it
# does not authorize anything) - access is enforced by Auth, firestore.rules' deny-all, and the
# API's own token check.
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_APP_ID
ENV VITE_FIREBASE_API_KEY=$VITE_FIREBASE_API_KEY \
    VITE_FIREBASE_AUTH_DOMAIN=$VITE_FIREBASE_AUTH_DOMAIN \
    VITE_FIREBASE_PROJECT_ID=$VITE_FIREBASE_PROJECT_ID \
    VITE_FIREBASE_APP_ID=$VITE_FIREBASE_APP_ID \
    VITE_USE_AUTH_EMULATOR=0
RUN npx vite build --config web/vite.config.ts

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY shared ./shared
COPY services ./services
COPY scripts ./scripts
COPY web ./web
COPY --from=build /app/web/dist ./web/dist

ENV NODE_ENV=production
ENV WEB_STATIC_DIR=/app/web/dist
EXPOSE 8080
# PORT is supplied by Cloud Run; server.ts already reads it.
CMD ["npx", "tsx", "web/server/server.ts"]
