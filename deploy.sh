#!/usr/bin/env bash
#
# Ship whatever is in the working tree.
#
#   ./deploy.sh "commit message"           commit, build, push, deploy, verify
#   ./deploy.sh "message" path [path...]   same, scoped to those paths only
#   ./deploy.sh --dry-run                  run every check, change nothing
#   ./deploy.sh --verify                   check what is live right now
#
# One target: an EC2 instance behind Caddy serving the API and the frontend
# from the same origin. The frontend is compiled INTO the image, so every
# change - backend or frontend - needs a rebuild and a container restart.
#
# This used to deploy the frontend through Netlify and skip the image for
# web-only changes. Netlify then ran out of credits and silently skipped five
# deploys while the old bundle kept answering, so this script reported success
# for code that never shipped. Hence the check near the end: it compares the
# bundle the image contains against the bundle production actually serves.
# Endpoint health alone passes happily against a stale deploy.

set -euo pipefail

# --- configuration ---------------------------------------------------------
EC2_HOST="13.201.235.164"
EC2_USER="ubuntu"
SSH_KEY="$HOME/.ssh/mail-service-v2"
IMAGE="avezqureshi15/mail-service-v2"
SITE="https://13-201-235-164.sslip.io"
REMOTE_ENV="/opt/mail-service/.env"
DOCKER_DESKTOP="/c/Users/Avez Qureshi/AppData/Local/Programs/DockerDesktop/Docker Desktop.exe"

cd "$(dirname "$0")"

bold=$'\033[1m'; red=$'\033[31m'; green=$'\033[32m'; yellow=$'\033[33m'; dim=$'\033[2m'; off=$'\033[0m'
step() { printf '\n%s== %s ==%s\n' "$bold" "$1" "$off"; }
ok()   { printf '   %s%s%s\n' "$green" "$1" "$off"; }
warn() { printf '   %s%s%s\n' "$yellow" "$1" "$off"; }
info() { printf '   %s\n' "$1"; }
die()  { git reset -q >/dev/null 2>&1 || true; printf '\n%sABORTED: %s%s\n\n' "$red" "$1" "$off" >&2; exit 1; }

DRY_RUN=0; VERIFY_ONLY=0; MSG=""
case "${1:-}" in
  --dry-run) DRY_RUN=1; shift ;;
  --verify)  VERIFY_ONLY=1; shift ;;
  "")        ;;
  *)         MSG="$1"; shift ;;
esac

# Optional paths. Default is everything - but another agent or an open editor
# may be mid-change in this same working tree, and committing their
# half-finished file alongside yours is how unfinished work reaches
# production. Naming paths scopes the whole run to them.
PATHS=( "$@" )
[ ${#PATHS[@]} -eq 0 ] && PATHS=( "." )

ssh_ec2() { ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new "$EC2_USER@$EC2_HOST" "$@"; }

# The bundle filename the running site serves. Vite content-hashes it, so it
# is a fingerprint of exactly which build is live.
live_bundle() {
  curl -s -m 30 "$SITE/" 2>/dev/null | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1
}

verify_live() {
  step "Verifying what is live"
  local fail=0
  for pair in "/|200" "/campaigns|200" "/contacts|200" "/predictor|200" "/api/healthz|200" "/api/dashboard|401" "/u/test|400"; do
    local path="${pair%%|*}" want="${pair##*|}" got
    got=$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$SITE$path" || echo 000)
    if [ "$got" = "$want" ]; then printf '   %-18s %s\n' "$path" "$got"
    else printf '   %s%-18s %s  expected %s%s\n' "$red" "$path" "$got" "$want" "$off"; fail=1; fi
  done
  info "${dim}bundle: $(live_bundle)${off}"
  [ "$fail" = 1 ] && die "production is not healthy"
  ok "all endpoints healthy"
}

if [ "$VERIFY_ONLY" = 1 ]; then verify_live; exit 0; fi

# ---------------------------------------------------------------------------
step "What changed"

git fetch -q origin || die "cannot reach origin"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "main" ] || warn "on branch '$BRANCH', not main"

DIRTY=$(git status --porcelain -- "${PATHS[@]}")
AHEAD=$(git log --oneline origin/main..HEAD 2>/dev/null | wc -l | tr -d ' ')

if [ -z "$DIRTY" ] && [ "$AHEAD" = "0" ]; then
  info "working tree clean and in sync with origin"
  info "${dim}rebuilding anyway, so a previously-failed deploy cannot stay stuck${off}"
else
  [ -n "$DIRTY" ] && info "$(echo "$DIRTY" | wc -l | tr -d ' ') uncommitted file(s)"
  [ "$AHEAD" != "0" ] && info "$AHEAD commit(s) not yet pushed"
fi

SERVER_CHANGED=0
if [ -n "$(git status --porcelain -- "${PATHS[@]}" | grep -E '^.. server/' || true)" ] || \
   { [ "$AHEAD" != "0" ] && [ -n "$(git diff --name-only origin/main..HEAD -- server/)" ]; }; then
  SERVER_CHANGED=1
fi

# ---------------------------------------------------------------------------
step "Blocker checks"

# npm ci - used in both Dockerfile stages - refuses to run when package.json
# and the lockfile disagree. Caught before a four-minute build fails midway.
for half in server web; do
  if [ -n "$(git status --porcelain $half/package.json)" ] && \
     [ -z "$(git status --porcelain $half/package-lock.json)" ]; then
    if git diff $half/package.json | grep -qE '^\+\s*"[^"]+":\s*"\^?[0-9]'; then
      die "$half/package.json adds a dependency but its lockfile is unchanged.
         'npm ci' in the Docker build will fail. Run: npm install --prefix $half"
    fi
  fi
done
ok "package.json / lockfile consistent"

# A newly REQUIRED env var that is not on the box means the container will not
# boot - production goes down on deploy. This is how SECRETS_KEY was caught.
if [ "$SERVER_CHANGED" = 1 ] && [ -f server/src/config/env.js ]; then
  NEW_REQUIRED=$(git diff HEAD -- server/src/config/env.js 2>/dev/null \
    | grep -E "^\+" | grep -v "^+++" | grep -oE "[A-Z][A-Z0-9_]{2,}: required\(" \
    | sed 's/: required(//' || true)
  if [ -n "$NEW_REQUIRED" ]; then
    warn "new REQUIRED env var(s): $(echo "$NEW_REQUIRED" | tr '\n' ' ')"
    MISSING=""
    for v in $NEW_REQUIRED; do
      grep -q "^$v=" server/.env 2>/dev/null || MISSING="$MISSING $v(local)"
      [ "$DRY_RUN" = 0 ] && { ssh_ec2 "grep -q '^$v=' $REMOTE_ENV" 2>/dev/null || MISSING="$MISSING $v(ec2)"; }
    done
    [ -n "$MISSING" ] && die "required env var missing:$MISSING
         The container will refuse to start and production will go down.
         Add it to server/.env and to $REMOTE_ENV on the instance first."
    ok "new required vars present locally and on EC2"
  fi
fi

# Destructive migrations are not necessarily wrong - 007 dropped a column on
# purpose, carefully - but they are never routine.
NEW_MIGRATIONS=$(git status --porcelain server/src/db/migrations/ | awk '{print $2}' || true)
if [ -n "$NEW_MIGRATIONS" ]; then
  warn "new migration(s): $(echo "$NEW_MIGRATIONS" | xargs -n1 basename | tr '\n' ' ')"
  DANGER=$(grep -liE "^\s*(DROP|TRUNCATE|DELETE FROM|ALTER TABLE .* DROP)" $NEW_MIGRATIONS 2>/dev/null || true)
  if [ -n "$DANGER" ]; then
    warn "DESTRUCTIVE statements in: $(echo "$DANGER" | xargs -n1 basename | tr '\n' ' ')"
    warn "it runs against the live database at boot - read it first"
    [ "$DRY_RUN" = 0 ] && { printf '   continue? [y/N] '; read -r a </dev/tty; [ "$a" = y ] || die "stopped at your request"; }
  fi
fi

# ---------------------------------------------------------------------------
step "Tests"
if [ "$SERVER_CHANGED" = 1 ]; then
  info "running server tests ..."
  TEST_OUT=$(cd server && npm test 2>&1) || {
    echo "$TEST_OUT" | grep -E "✖|error:" | head -12 | sed 's/^/     /'
    die "tests failed"
  }
  ok "$(echo "$TEST_OUT" | grep -E '^(ℹ|# ) pass' | head -1 | tr -s ' ')"
else
  info "${dim}server/ unchanged - skipping server tests${off}"
fi
# The frontend is compiled inside the image, so a broken build fails the
# docker build rather than needing a separate check here.

if [ "$DRY_RUN" = 1 ]; then
  printf '\n%sdry run - nothing committed, built or deployed%s\n\n' "$yellow" "$off"
  exit 0
fi

# ---------------------------------------------------------------------------
step "Commit and push"

if [ -n "$DIRTY" ]; then
  [ -n "$MSG" ] || die "there are uncommitted changes but no commit message.
         Usage: ./deploy.sh \"what this change does\" [paths...]"
  git add -- "${PATHS[@]}"
  printf '   %sstaging:%s\n' "$dim" "$off"
  git diff --cached --name-status | sed 's/^/     /'

  # The repo is public. .gitignore is necessary but not sufficient - a
  # credential pasted into source would sail straight past it.
  if [ -f server/.env ]; then
    LEAKS=$(node --input-type=module -e '
      import { execSync } from "node:child_process"; import fs from "node:fs";
      const env = fs.readFileSync("server/.env","utf8");
      const get = k => (env.match(new RegExp("^"+k+"=(.*)$","m")) ?? [])[1]?.trim() ?? "";
      // Only keys that actually name a credential. Matching on value length
      // instead flagged SMTP_HOST (smtp.gmail.com) wherever the docs mention
      // it and blocked the deploy - a check that cries wolf gets switched off.
      const SENSITIVE = /(PASSWORD|SECRET|_KEY|TOKEN|CIPHER|CREDENTIAL)/;
      const secrets = {};
      for (const m of env.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)) {
        const k = m[1];
        if (!SENSITIVE.test(k) && k !== "DATABASE_URL") continue;
        const v = get(k); if (v && v.length >= 8) secrets[k] = v;
      }
      const dbpw = (get("DATABASE_URL").match(/:\/\/[^:]+:([^@]+)@/) ?? [])[1];
      if (dbpw) secrets["DATABASE_PASSWORD"] = dbpw;
      const staged = execSync("git diff --cached --name-only",{encoding:"utf8"}).trim().split("\n").filter(Boolean);
      const bad = [];
      for (const [k,v] of Object.entries(secrets))
        for (const f of staged) {
          try { if (execSync(`git show :"${f}"`,{encoding:"utf8",maxBuffer:256e6}).includes(v)) bad.push(`${k} -> ${f}`); } catch {}
        }
      console.log(bad.join("\n"));
    ' 2>/dev/null || true)
    [ -n "$LEAKS" ] && die "a live secret appears in staged content:
$LEAKS"
    ok "no live secret in staged files"
  fi

  git commit -q -m "$MSG" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
  ok "committed $(git rev-parse --short HEAD)"
fi

git push -q origin "$BRANCH" 2>/dev/null && ok "pushed to origin/$BRANCH" || info "nothing to push"

# ---------------------------------------------------------------------------
step "Build image"

if ! docker info >/dev/null 2>&1; then
  info "Docker engine down - starting Docker Desktop ..."
  [ -f "$DOCKER_DESKTOP" ] && powershell -NoProfile -Command "Start-Process '$DOCKER_DESKTOP'" >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 6; done
fi
docker info >/dev/null 2>&1 || die "Docker is not running"

TAG="$(date +%Y%m%d-%H%M)"
info "building (context = repo root; stage 1 compiles the frontend) ..."
# Exit codes checked explicitly: piping docker into tail once reported
# success for a build that had in fact failed.
docker build --platform linux/amd64 -f server/Dockerfile \
  -t "$IMAGE:latest" -t "$IMAGE:$TAG" . >/tmp/deploy-build.log 2>&1 \
  || { tail -25 /tmp/deploy-build.log; die "image build failed"; }

# Which bundle did this build produce? Compared against production below.
BUILT_BUNDLE=$(docker run --rm --entrypoint sh "$IMAGE:latest" \
  -c 'ls /web/dist/assets/index-*.js 2>/dev/null | head -1 | xargs -r basename' | tr -d '\r\n')
ok "built $IMAGE:$TAG  (bundle $BUILT_BUNDLE)"

docker push "$IMAGE:latest" >/tmp/deploy-push.log 2>&1 \
  || { tail -10 /tmp/deploy-push.log; die "push of :latest failed"; }
docker push "$IMAGE:$TAG" >/dev/null 2>&1 || warn "pinned tag push failed (:latest is current)"
ok "pushed $(grep -o 'sha256:[a-f0-9]\{16\}' /tmp/deploy-push.log | tail -1)"

# ---------------------------------------------------------------------------
step "Deploy to EC2"
ssh_ec2 "bash -s" <<REMOTE || die "EC2 deploy failed"
set -e
sudo docker pull -q $IMAGE:latest >/dev/null
sudo docker rm -f mail-service >/dev/null 2>&1 || true
sudo docker run -d --name mail-service \
  --env-file $REMOTE_ENV \
  -p 127.0.0.1:4000:4000 \
  --memory 600m --memory-swap 600m \
  --restart unless-stopped \
  $IMAGE:latest >/dev/null
sleep 18
test "\$(sudo docker inspect -f '{{.State.Status}}' mail-service)" = running
echo "   container running"
sudo docker logs mail-service 2>&1 | tail -6 | sed 's/^/   /'
REMOTE
ok "deployed"

# ---------------------------------------------------------------------------
# The check that would have caught the Netlify outage.
step "Confirming the new build is actually serving"
LIVE=""
for _ in $(seq 1 15); do
  LIVE=$(live_bundle)
  [ "$LIVE" = "/assets/$BUILT_BUNDLE" ] && break
  sleep 4
done
if [ "$LIVE" = "/assets/$BUILT_BUNDLE" ]; then
  ok "live bundle matches this build: $BUILT_BUNDLE"
else
  die "production serves '$LIVE' but this build produced '/assets/$BUILT_BUNDLE'.
         The deploy did not take. A green health check here means nothing -
         the old build answers just as happily."
fi

verify_live

printf '\n%sDeployed.%s  %s\n' "$green" "$off" "$(git rev-parse --short HEAD)"
printf '  %s\n' "$SITE"
printf '  frontend and API both served from EC2 %s\n\n' "$EC2_HOST"
