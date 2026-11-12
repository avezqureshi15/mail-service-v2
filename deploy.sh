#!/usr/bin/env bash
#
# Ship whatever is in the working tree.
#
#   ./deploy.sh "commit message"      commit, push, deploy, verify
#   ./deploy.sh --dry-run             run every check, change nothing
#   ./deploy.sh --verify              just check what is live now
#
# The frontend deploys itself: Netlify builds on every push to main. The
# backend does not - it runs from a Docker image, and Render-style image
# hosts do not redeploy when a tag moves. So this rebuilds and redeploys the
# image ONLY when something under server/ actually changed. A frontend-only
# change skips the image entirely, which takes the deploy from ~4 minutes to
# ~20 seconds and leaves the running backend untouched.
#
# Every guard below exists because it caught something real.

set -euo pipefail

# --- configuration ---------------------------------------------------------
EC2_HOST="13.201.235.164"
EC2_USER="ubuntu"
SSH_KEY="$HOME/.ssh/mail-service-v2"
IMAGE="avezqureshi15/mail-service-v2"
SITE="https://mail-service-v2.netlify.app"
REMOTE_ENV="/opt/mail-service/.env"
DOCKER_DESKTOP="/c/Users/Avez Qureshi/AppData/Local/Programs/DockerDesktop/Docker Desktop.exe"

cd "$(dirname "$0")"

bold=$'\033[1m'; red=$'\033[31m'; green=$'\033[32m'; yellow=$'\033[33m'; dim=$'\033[2m'; off=$'\033[0m'
step() { printf '\n%s== %s ==%s\n' "$bold" "$1" "$off"; }
ok()   { printf '   %s%s%s\n' "$green" "$1" "$off"; }
warn() { printf '   %s%s%s\n' "$yellow" "$1" "$off"; }
die()  { git reset -q >/dev/null 2>&1 || true; printf '
%sABORTED: %s%s

' "$red" "$1" "$off" >&2; exit 1; }
info() { printf '   %s\n' "$1"; }

DRY_RUN=0; VERIFY_ONLY=0; MSG=""
case "${1:-}" in
  --dry-run) DRY_RUN=1; shift ;;
  --verify)  VERIFY_ONLY=1; shift ;;
  "")        ;;
  *)         MSG="$1"; shift ;;
esac

# Optional paths to deploy. Default is everything - but another agent or an
# open editor may be mid-change in this same working tree, and committing
# their half-finished file alongside yours is how unfinished work reaches
# production. Naming paths scopes the whole run to them, tests included.
PATHS=( "$@" )
[ ${#PATHS[@]} -eq 0 ] && PATHS=( "." )

ssh_ec2() { ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new "$EC2_USER@$EC2_HOST" "$@"; }

# ---------------------------------------------------------------------------
verify_live() {
  step "Verifying what is live"
  local fail=0
  for pair in "/|200" "/campaigns|200" "/contacts|200" "/api/healthz|200" "/u/test|400"; do
    local path="${pair%%|*}" want="${pair##*|}"
    local got; got=$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$SITE$path" || echo 000)
    if [ "$got" = "$want" ]; then printf '   %-18s %s\n' "$path" "$got"
    else printf '   %s%-18s %s  expected %s%s\n' "$red" "$path" "$got" "$want" "$off"; fail=1; fi
  done
  # Proves Netlify is reaching our origin rather than serving a cached shell.
  local via; via=$(curl -s -m 30 -o /dev/null -D - "$SITE/api/healthz" 2>/dev/null | tr -d '\r' | grep -i '^via:' || true)
  [ -n "$via" ] && info "${dim}origin: $via${off}"
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
  ok "nothing to deploy - working tree clean and in sync with origin"
  verify_live; exit 0
fi

[ -n "$DIRTY" ] && info "$(echo "$DIRTY" | wc -l | tr -d ' ') uncommitted file(s)"
[ "$AHEAD" != "0" ] && info "$AHEAD commit(s) not yet pushed"

# Does anything the IMAGE contains change? .dockerignore excludes test/, so a
# test-only change still rebuilds - harmless, and simpler than replicating
# those rules here.
SERVER_CHANGED=0
if [ -n "$(git status --porcelain -- "${PATHS[@]}" | grep -E '^.. server/' || true)" ] || \
   { [ "$AHEAD" != "0" ] && [ -n "$(git diff --name-only origin/main..HEAD -- server/)" ]; }; then
  SERVER_CHANGED=1
fi

if [ "$SERVER_CHANGED" = 1 ]; then
  info "server/ changed  ->  image rebuild + EC2 deploy required"
else
  ok "server/ untouched  ->  Netlify only, backend left alone"
fi

# ---------------------------------------------------------------------------
step "Blocker checks"

# npm ci (used in the Dockerfile) refuses to run when package.json and the
# lockfile disagree. Caught before a four-minute build fails at step 5.
if [ -n "$(git status --porcelain server/package.json)" ] && \
   [ -z "$(git status --porcelain server/package-lock.json)" ]; then
  if git diff server/package.json | grep -qE '^\+\s*"[^"]+":\s*"\^?[0-9]'; then
    die "server/package.json adds a dependency but package-lock.json is unchanged.
         'npm ci' in the Docker build will fail. Run: npm install --prefix server"
  fi
fi
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
      if [ "$DRY_RUN" = 0 ]; then
        ssh_ec2 "grep -q '^$v=' $REMOTE_ENV" 2>/dev/null || MISSING="$MISSING $v(ec2)"
      fi
    done
    [ -n "$MISSING" ] && die "required env var missing:$MISSING
         The container will refuse to start and production will go down.
         Add it to server/.env and to $REMOTE_ENV on the instance first."
    ok "all new required vars present locally and on EC2"
  else
    ok "no new required env vars"
  fi
fi

# Destructive migrations are not necessarily wrong - 007 dropped a column on
# purpose, carefully - but they are never routine. Surface them.
NEW_MIGRATIONS=$(git status --porcelain server/src/db/migrations/ | awk '{print $2}' || true)
if [ -n "$NEW_MIGRATIONS" ]; then
  warn "new migration(s): $(echo "$NEW_MIGRATIONS" | xargs -n1 basename | tr '\n' ' ')"
  DANGER=$(grep -liE "^\s*(DROP|TRUNCATE|DELETE FROM|ALTER TABLE .* DROP)" $NEW_MIGRATIONS 2>/dev/null || true)
  if [ -n "$DANGER" ]; then
    warn "DESTRUCTIVE statements in: $(echo "$DANGER" | xargs -n1 basename | tr '\n' ' ')"
    warn "read it before shipping - this runs against the live database at boot"
    [ "$DRY_RUN" = 0 ] && { printf '   continue? [y/N] '; read -r a </dev/tty; [ "$a" = y ] || die "stopped at your request"; }
  fi
fi

# ---------------------------------------------------------------------------
step "Build and test"

if [ "$SERVER_CHANGED" = 1 ]; then
  info "running server tests ..."
  TEST_OUT=$(cd server && npm test 2>&1) || { echo "$TEST_OUT" | tail -30; die "tests failed"; }
  ok "$(echo "$TEST_OUT" | grep -E '^(ℹ|# ) pass' | head -1 | tr -s ' ')"
else
  info "${dim}server unchanged - skipping server tests${off}"
fi

WEB_CHANGED=0
if [ -n "$(git status --porcelain -- "${PATHS[@]}" | grep -E '^.. web/' || true)" ] \
   || [ "${PATHS[0]}" = "." ]; then WEB_CHANGED=1; fi

ASSET=""
if [ "$WEB_CHANGED" = 1 ]; then
  info "building frontend ..."
  BUILD_OUT=$(cd web && npm run build 2>&1) || { echo "$BUILD_OUT" | tail -20; die "frontend build failed"; }
  ASSET=$(ls -t web/dist/assets/index-*.js 2>/dev/null | head -1 | xargs -r basename)
  ok "built  $ASSET"
else
  info "${dim}web/ unchanged - skipping frontend build${off}"
fi

# ---------------------------------------------------------------------------
step "Secret scan"

# The GitHub repo is public. .gitignore is necessary but not sufficient - a
# credential pasted into source would sail past it.
if [ -f server/.env ]; then
  git add -- "${PATHS[@]}"
  printf '   %sstaging:%s\n' "$dim" "$off"
  git diff --cached --name-status | sed 's/^/     /'
  LEAKS=$(node --input-type=module -e '
    import { execSync } from "node:child_process"; import fs from "node:fs";
    const env = fs.readFileSync("server/.env","utf8");
    const get = k => (env.match(new RegExp("^"+k+"=(.*)$","m")) ?? [])[1]?.trim() ?? "";
    const names = [...env.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map(m => m[1]);
    const secrets = {};
    // Only keys that actually name a credential. Matching on value length
    // instead flagged SMTP_HOST (smtp.gmail.com) wherever the docs mention it
    // and blocked the deploy - a check that cries wolf gets switched off,
    // which is worse than not having one.
    const SENSITIVE = /(PASSWORD|SECRET|_KEY|TOKEN|CIPHER|CREDENTIAL)/;
    for (const k of names) {
      if (!SENSITIVE.test(k) && k !== "DATABASE_URL") continue;
      const v = get(k);
      if (v && v.length >= 8) secrets[k] = v;
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

if [ "$DRY_RUN" = 1 ]; then
  printf '\n%sdry run - nothing committed, pushed or deployed%s\n\n' "$yellow" "$off"
  git reset -q; exit 0
fi

# ---------------------------------------------------------------------------
step "Commit and push"

if [ -n "$DIRTY" ]; then
  [ -n "$MSG" ] || die "there are uncommitted changes but no commit message.
         Usage: ./deploy.sh \"what this change does\""
  git commit -q -m "$MSG" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
  ok "committed $(git rev-parse --short HEAD)"
else
  info "nothing new to commit"
fi

git push -q origin "$BRANCH" || die "push failed"
ok "pushed to origin/$BRANCH  ->  Netlify will rebuild"

# ---------------------------------------------------------------------------
if [ "$SERVER_CHANGED" = 1 ]; then
  step "Backend image"

  if ! docker info >/dev/null 2>&1; then
    info "Docker engine down - starting Docker Desktop ..."
    [ -f "$DOCKER_DESKTOP" ] && powershell -NoProfile -Command "Start-Process '$DOCKER_DESKTOP'" >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 6; done
  fi
  docker info >/dev/null 2>&1 || die "Docker is not running"

  TAG="$(date +%Y%m%d-%H%M)"
  info "building (linux/amd64 - EC2 will not run an arm64 image) ..."
  # Exit codes checked explicitly: piping docker into tail once reported
  # success for a build that had failed.
  docker build --platform linux/amd64 -t "$IMAGE:latest" -t "$IMAGE:$TAG" server >/tmp/deploy-build.log 2>&1 \
    || { tail -20 /tmp/deploy-build.log; die "image build failed"; }
  ok "built $IMAGE:$TAG"

  docker push "$IMAGE:latest" >/tmp/deploy-push.log 2>&1 || { tail -10 /tmp/deploy-push.log; die "push of :latest failed"; }
  docker push "$IMAGE:$TAG"    >/dev/null 2>&1 || warn "pinned tag push failed (:latest is up to date)"
  DIGEST=$(grep -o 'sha256:[a-f0-9]\{64\}' /tmp/deploy-push.log | tail -1)
  ok "pushed  ${DIGEST:0:23}"

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
sudo docker logs mail-service 2>&1 | tail -8 | sed 's/^/   /'
REMOTE
  ok "backend deployed"
else
  step "Backend"
  info "${dim}server/ unchanged - image and EC2 left exactly as they were${off}"
fi

# ---------------------------------------------------------------------------
if [ -n "$ASSET" ]; then
step "Waiting for Netlify"
for i in $(seq 1 40); do
  LIVE=$(curl -s -m 20 "$SITE/" 2>/dev/null | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1 || true)
  [ "$LIVE" = "/assets/$ASSET" ] && { ok "live after ~$((i*8))s  $ASSET"; break; }
  sleep 8
done
[ "$LIVE" = "/assets/$ASSET" ] || warn "still serving $LIVE - Netlify may still be building"
else
  step "Netlify"
  info "${dim}no frontend change in scope - not waiting on a build${off}"
fi

verify_live

printf '\n%sDeployed.%s  %s\n' "$green" "$off" "$(git rev-parse --short HEAD)"
printf '  frontend  %s\n' "$SITE"
[ "$SERVER_CHANGED" = 1 ] && printf '  backend   %s (redeployed)\n' "$EC2_HOST" || printf '  backend   %s (untouched)\n' "$EC2_HOST"
printf '\n'
