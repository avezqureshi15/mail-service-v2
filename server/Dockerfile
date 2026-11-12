# mail-service-v2 - API and frontend in one image
#
# Build from the REPOSITORY ROOT, not from server/:
#   docker build --platform linux/amd64 -f server/Dockerfile .
# The frontend is compiled in the first stage, so the context needs web/ too.
#
# NOTHING SECRET IS BAKED IN. The image carries code only; DATABASE_URL, the
# SMTP and IMAP passwords and the signing secrets are supplied as environment
# variables at run time. See DEPLOY.md.

# --- stage 1: compile the frontend -----------------------------------------
# Deliberately no NODE_ENV=production here. Vite is a devDependency, and with
# NODE_ENV=production `npm ci` skips devDependencies - the build would fail on
# a missing vite rather than anything obvious.
FROM node:22-alpine AS web
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- stage 2: runtime ------------------------------------------------------
FROM node:22-alpine

# Tini reaps zombies and forwards SIGTERM, so a shutdown signal reaches Node
# and the app closes its pool rather than being killed.
RUN apk add --no-cache tini

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, in their own layer: rebuilding after a code change then
# reuses the installed modules instead of re-downloading them.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/src ./src
COPY server/scripts ./scripts

# src/index.js resolves the bundle as `<serverRoot>/../web/dist`, and
# serverRoot is /app - so the frontend belongs at /web/dist. Copying it here
# rather than changing that path keeps the layout identical to a checkout,
# where the same code already serves the built frontend in development.
COPY --from=web /build/dist /web/dist

ENV PORT=4000
EXPOSE 4000

USER node

# The one unauthenticated endpoint, which touches no database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
