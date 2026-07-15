#!/usr/bin/env bash
#
# Build the songbook PDF with Typst.
#
# Pipeline:  bin/parse-songs.py  ->  build/songs.json  ->  typst  ->  songbook.pdf
#
# Typst is a single self-contained binary with its own bundled fonts, so this
# needs no TeX installation and produces byte-identical output on any machine.
# We pass --ignore-system-fonts so the result never depends on host fonts.
#
# Env:
#   BUILD_DIR   output/scratch dir   (default <repo>/build)
#   TYPST       path to the typst binary (else searched on PATH & common dirs)
#   BOOK_TITLE  title on the cover   (default "The Folksong Anthology")
#   SONGS_DIR   directory holding the song files (default <repo>/, passed through
#               to bin/parse-songs.py — see server.js for the same convention)
#   FLAG_DIAGRAMS/FLAG_AUTHOR/FLAG_HISTORY/FLAG_NOTE/FLAG_CHORDS/FLAG_PDFS
#               "on"/"off", forwarded to book.typ as --input diagrams=/
#               author=/history=/note=/chords=/pdfs= (see server.js's
#               build-flags persistence, set from the manager UI)

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUILD_DIR="${BUILD_DIR:-$ROOT/build}"

log()  { echo "▶ $*"; }
fail() { echo "❌ $*"; exit 1; }

# Keep the build dir inside the repo so Typst's --root can see both src/ and it.
case "$BUILD_DIR" in
  "$ROOT"/*) ;;
  *) log "BUILD_DIR ($BUILD_DIR) is outside repo; using $ROOT/build instead"
     BUILD_DIR="$ROOT/build" ;;
esac
mkdir -p "$BUILD_DIR"

# --- locate typst -------------------------------------------------------------
if [ -z "${TYPST:-}" ]; then
  for cand in "$ROOT/bin/typst" /var/www/bin/typst /usr/local/bin/typst \
              "$HOME/.cargo/bin/typst"; do
    [ -x "$cand" ] && TYPST="$cand" && break
  done
fi
[ -n "${TYPST:-}" ] || TYPST="$(command -v typst 2>/dev/null || true)"
[ -n "${TYPST:-}" ] || fail "typst binary not found (set TYPST=/path/to/typst)"
log "using typst: $TYPST"
"$TYPST" --version || true

# --- 1. parse the song files into structured JSON -----------------------------
log "parsing songs (bin/parse-songs.py)"
command -v python3 >/dev/null 2>&1 || fail "python3 not found"
BUILD_DIR="$BUILD_DIR" python3 bin/parse-songs.py || fail "parse-songs.py failed"

# --- 2. typeset with Typst ----------------------------------------------------
REL_JSON="/${BUILD_DIR#$ROOT/}/songs.json"     # root-relative path for --input
log "typesetting: typst compile src/book.typ"
"$TYPST" compile \
  --ignore-system-fonts \
  --root "$ROOT" \
  --input "data=$REL_JSON" \
  --input "diagrams=${FLAG_DIAGRAMS:-off}" \
  --input "author=${FLAG_AUTHOR:-on}" \
  --input "history=${FLAG_HISTORY:-on}" \
  --input "note=${FLAG_NOTE:-on}" \
  --input "chords=${FLAG_CHORDS:-on}" \
  --input "pdfs=${FLAG_PDFS:-on}" \
  src/book.typ "$BUILD_DIR/songbook.pdf" 2>&1
rc=$?

# --- 3. collect output --------------------------------------------------------
if [ "$rc" -eq 0 ] && [ -f "$BUILD_DIR/songbook.pdf" ]; then
  log "wrote $BUILD_DIR/songbook.pdf ($(wc -c < "$BUILD_DIR/songbook.pdf") bytes)"
  exit 0
fi
fail "typst did not produce a PDF (exit=$rc)"
