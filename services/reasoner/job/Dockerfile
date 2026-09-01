# D4 — Cloud Run deploy image for the reasoner worker / recommendation-request API
# (services/reasoner/job/server.ts). NOT built, run, or pushed anywhere by this step — see
# IMPLEMENTATION_PLAN.md D4's own notes for the exact `gcloud run deploy` command an operator
# runs, and what must exist first (a Cloud Tasks queue, Secret Manager access for the
# `sync-functions`-equivalent service account, the env vars server.ts/apiRuntime.ts read).
#
# Deliberately runs the TypeScript source directly via `tsx` (already a real dependency of the
# root project) rather than a compiled-JS + esbuild-bundle step like functions/'s own deploy
# shim (functions/scripts/bundle.mjs) — Cloud Run, unlike Cloud Functions Gen2, places no
# constraint on the container's own entrypoint or module system, so there is nothing here for a
# bundle to work around. `npm ci` alone (no `--omit=dev`) is intentional: `tsx` is a
# devDependency, and this container's whole job is to run it.

FROM node:22-slim
WORKDIR /app

# Only the root project's manifest — functions/ is a separate npm project this service never
# touches (same "two projects, two dependency trees" reality B1's own bundle notes describe).
COPY package.json package-lock.json ./
RUN npm ci

# The root project only — shared/, services/, scripts/ (no web/, no functions/, matching what
# this service actually imports via the @shared/@services path aliases in tsconfig.json).
COPY tsconfig.json ./
COPY shared ./shared
COPY services ./services
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 8080
CMD ["npx", "tsx", "services/reasoner/job/server.ts"]
