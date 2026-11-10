# mail-service-v2 backend
#
# Runtime only - every dependency is pure JavaScript, so there is no build
# step and no compiler needed in the image.
#
# NOTHING SECRET IS BAKED IN. The image carries code only; DATABASE_URL, the
# SMTP and IMAP passwords and both signing secrets are supplied as
# environment variables by Render at run time. See DEPLOY.md.
FROM node:22-alpine

# Tini reaps zombies and forwards SIGTERM, so Render's shutdown signal
# actually reaches Node and the app closes its pool rather than being killed.
RUN apk add --no-cache tini

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, in their own layer: rebuilding after a code change then
# reuses the installed modules instead of re-downloading them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Only what the server actually runs. .dockerignore keeps .env, tests and
# node_modules out regardless, but copying narrowly is the belt to that brace.
COPY src ./src
COPY scripts ./scripts

# Render overrides this with its own PORT; the default keeps `docker run`
# working on its own.
ENV PORT=4000
EXPOSE 4000

# Drop privileges. The node image ships this user already.
USER node

# Hits the one unauthenticated endpoint, which touches no database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
