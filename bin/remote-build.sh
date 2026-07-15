#!/usr/bin/env bash
#
# Orchestrate a songbook build on the *old* compute server from the *new* app
# server.  The book is typeset with Typst (a single self-contained binary), so
# the old server only needs bin/typst — no TeX installation.
#
#   1. rsync sources (songs + src + bin) to the build host
#   2. run bin/build.sh there (as www-data, using the remote typst binary)
#   3. rsync the resulting PDF back into our local build/ dir
#
# Invoked by server.js in place of build.sh when BUILD_SCRIPT points here.
# Streams the remote build log to stdout so the UI shows it live.
#
# Env (set in ecosystem.config.cjs):
#   OLD_HOST           build host (default 73.144.157.250 — the old server IP)
#   OLD_USER           ssh user on build host (default isidore)
#   REMOTE_BUILD_DIR   work dir on build host (default /var/www/folksong-build)
#   REMOTE_TYPST       typst binary on build host (default /var/www/bin/typst)
#   BUILD_SSH_KEY      ssh key for the build host (default /var/www/.ssh/id_ed25519)
#   BOOK_TITLE         songbook cover title
#   BUILD_DIR          local output dir (default <repo>/build)
#   SONGS_DIR          directory holding the song files (default: this repo's root)

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${BUILD_DIR:-$ROOT/build}"
SONGS_DIR="${SONGS_DIR:-$ROOT}"
OLD_HOST="${OLD_HOST:-73.144.157.250}"
OLD_USER="${OLD_USER:-isidore}"
REMOTE_DIR="${REMOTE_BUILD_DIR:-/var/www/folksong-build}"
REMOTE_TYPST="${REMOTE_TYPST:-/var/www/bin/typst}"
BOOK_TITLE="${BOOK_TITLE:-The Folksong Anthology}"
SSH_KEY="${BUILD_SSH_KEY:-/var/www/.ssh/id_ed25519}"

SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15)

log() { echo "▶ $*"; }
fail() { echo "❌ $*"; exit 1; }

mkdir -p "$BUILD_DIR"

log "build host: $OLD_USER@$OLD_HOST:$REMOTE_DIR"

# 1. push app sources (as www-data on the remote so the tree is www-data-owned).
#    Songs live separately (SONGS_DIR) and are synced in their own step below,
#    each with its own --delete, so a rename/delete in one tree can't be read
#    as "missing" and wipe out the other.
log "syncing app sources → build host"
rsync -rlz --delete \
  --rsync-path="sudo -u www-data rsync" \
  -e "${SSH[*]}" \
  --exclude 'build/' --exclude 'node_modules/' --exclude '.git/' \
  --exclude 'public/' --exclude '*.pdf' --exclude '.github/' \
  "$ROOT/" "$OLD_USER@$OLD_HOST:$REMOTE_DIR/" 2>&1 \
  || fail "source sync failed"

# 1b. push songs into their own subdirectory on the build host.
log "syncing songs → build host"
rsync -rlz --delete \
  --rsync-path="sudo -u www-data rsync" \
  -e "${SSH[*]}" \
  "$SONGS_DIR/" "$OLD_USER@$OLD_HOST:$REMOTE_DIR/songs/" 2>&1 \
  || fail "songs sync failed"

# 2. run the typst build on the remote as www-data.
log "running typst build on remote host…"
"${SSH[@]}" "$OLD_USER@$OLD_HOST" \
  "sudo -u www-data env BUILD_DIR='$REMOTE_DIR/build' TYPST='$REMOTE_TYPST' BOOK_TITLE='$BOOK_TITLE' SONGS_DIR='$REMOTE_DIR/songs' bash '$REMOTE_DIR/bin/build.sh'" 2>&1
rc=$?
log "remote build exit=$rc"

# 3. fetch the PDF back.
log "fetching songbook.pdf"
rsync -rlz -e "${SSH[*]}" \
  "$OLD_USER@$OLD_HOST:$REMOTE_DIR/build/songbook.pdf" "$BUILD_DIR/songbook.pdf" 2>&1 \
  || log "no PDF fetched"

if [ -f "$BUILD_DIR/songbook.pdf" ] && [ "$rc" -eq 0 ]; then
  log "wrote $BUILD_DIR/songbook.pdf ($(wc -c < "$BUILD_DIR/songbook.pdf") bytes)"
  exit 0
fi
fail "remote build did not produce a PDF"
