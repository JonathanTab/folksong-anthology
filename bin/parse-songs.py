#!/usr/bin/env python3
"""
Parse the folksong-anthology song files into a single structured JSON document
that the Typst template (src/book.typ) renders into the songbook PDF.

A song file is a plain, extension-less file in the repo root (same rule the web
manager uses).  The historical text format is loose, so this parser is
deliberately forgiving and normalises everything into a clean structure:

    { generated, title, songs: [ Song ] }

    Song = {
      name, title, author, meta{author,history,note,...},
      chords: [str],                 # unique chords used, first-seen order
      blocks: [ Block ]
    }
    Block = { type: "verse"|"chorus"|"bridge",
              lines: [ [ {chord, text} ] ] }         # a line is a list of segments
          | { type: "chorus-ref"|"bridge-ref", label: str }

Two verse conventions both appear in the corpus and are both handled:
  * blank-line-separated verses (The Fox, Edelweiss);
  * run-on verses delimited by (Chorus)/[Chorus] markers (Whiskey in the Jar,
    Battle Hymn), where a bare "(Chorus)" line is a *repeat cue*, not content.

The song *title* is always the file name (cleaned of editorial markers) — song
files no longer carry a title line.  Metadata is a small set of `{...}`
directives at the top of the file: `{author: ...}`, `{history: ...}` (a short
prose blurb), `{note: ...}` (free-form), and `{flags: ...}` (workflow tags,
set explicitly — never inferred from content or the file name).
Scanned sheet-music PDFs live alongside the text song files in SONGS_DIR (same
rule, but *with* a `.pdf` extension).  Typst >=0.14 can embed a PDF page
directly as an image (`image(path, page: n)`), so each PDF song just needs its
page count (via Ghostscript, since Typst has no "how many pages" query) and a
path relative to the Typst compile root (`--root .`, see bin/build.sh) that
`src/book.typ` can hand to `image()`.  PDF songs are merged into the same
`songs` array as text songs (tagged `kind: "pdf"` vs `kind: "lyric"`) and
sorted together by title, so the book interleaves them alphabetically like any
other song.
"""

import glob
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SONGS_DIR = os.environ.get("SONGS_DIR", ROOT)

BOOK_TITLE = os.environ.get("BOOK_TITLE", "The Folksong Anthology")

# Files that live at the root but are not songs (matches server.js RESERVED).
RESERVED = {"LICENSE", "Makefile", "Dockerfile", "Procfile", "server",
            "CHANGELOG", "README"}

# A chord token inside parentheses: (G) (Am7) (F#m) (Bb) (Csus4) (D/F#) (G7/B)...
CHORD_RE = re.compile(
    r"\(\s*"
    r"([A-G](?:#|##|b|bb)?"                 # root + accidental
    r"(?:maj|min|sus|aug|dim|add|m)?"       # quality
    r"\d{0,2}"                              # extension number
    r"(?:sus\d)?"                           # e.g. 7sus4
    r"(?:add\d{1,2})?"                      # e.g. maj7add9
    r"(?:/[A-G](?:#|b)?)?)"                 # slash bass
    r"\s*\)"
)

# A whole-line repeat cue: "(Chorus)", "[Chorus]", "(Chorus 2x)", "(Chorus).".
CUE_RE = re.compile(r"^\s*[\(\[]\s*(chorus|bridge)([^)\]]*)[\)\]]\s*[.,]?\s*$",
                    re.IGNORECASE)
# An inline section marker that *begins* a block: "[Chorus] first line..."
MARK_RE = re.compile(r"^\s*[\(\[]\s*(chorus|bridge)\s*[\)\]]\s*[:-]?\s*",
                     re.IGNORECASE)
# A metadata directive line: "{author: Trad.}", "{history: ...}", "{note:
# ...}"... The value may be empty ("{note: }") — new songs are stubbed out
# with every known metadata directive present but blank (see server.js's
# defaultNewSongContent).
DIRECTIVE_RE = re.compile(r"^\s*\{\s*([a-zA-Z][\w-]*)\s*:\s*(.*?)\s*\}\s*$")

# Parenthetical editorial markers to strip from a file name to get the title.
EDITORIAL = re.compile(
    r"\s*[\(\[][^)\]]*\b(needs?|add|find|confirm|check|decide|jonathan|"
    r"chords?|cords|lyrics|notation|chorus|bridge|verse|tbd|wip)\b[^)\]]*[\)\]]",
    re.IGNORECASE,
)
# ProseMirror "new post" boilerplate that some empty stubs contain.
BOILERPLATE = "Enter text in [Markdown]"

# The workflow flags a song may carry, set explicitly with a `{flags: ...}`
# directive — never inferred from content or the file name. "stub" was folded
# into "needs-lyrics": a short/empty song just needs lyrics, no separate flag.
KNOWN_FLAGS = ("needs-lyrics", "needs-chords", "notation", "ready")


def parse_flags(value):
    """Split a `{flags: ...}` directive value into a list of flag slugs."""
    if not value:
        return []
    return [f.strip().lower() for f in re.split(r"[,\s]+", value) if f.strip()]


def is_song_file(name):
    if not name or name.startswith("."):
        return False
    if os.path.splitext(name)[1]:
        return False
    if name in RESERVED:
        return False
    return os.path.isfile(os.path.join(SONGS_DIR, name))


def is_pdf_song_file(name):
    if not name or name.startswith("."):
        return False
    if os.path.splitext(name)[1].lower() != ".pdf":
        return False
    return os.path.isfile(os.path.join(SONGS_DIR, name))


GS_BIN = shutil.which("gs")


def pdf_page_count(path):
    """Page count via Ghostscript (Typst has no way to ask a PDF its length)."""
    if not GS_BIN:
        return None
    escaped = path.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    ps = f"({escaped}) (r) file runpdfbegin pdfpagecount = quit"
    try:
        out = subprocess.run(
            [GS_BIN, "-q", "-dNODISPLAY", f"--permit-file-read={path}", "-c", ps],
            capture_output=True, text=True, timeout=20,
        )
        return int(out.stdout.strip())
    except (subprocess.SubprocessError, ValueError, OSError):
        return None


CROPS_DIR = os.path.join(SONGS_DIR, ".crops")


PAGE_SIZE_DPI = 72  # 1 point == 1px at 72dpi, so pixel dims are points directly


def _png_dimensions(data):
    if len(data) < 24 or data[12:16] != b"IHDR":
        return None
    w, h = struct.unpack(">II", data[16:24])
    return (w, h) if w > 0 and h > 0 else None


def pdf_page_size(path):
    """Page size in points, derived from the *same* kind of raster server.js
    generates for the crop-mode preview (rendered at a DPI where pixels map
    1:1 to points), not Ghostscript's `bbox` device — bbox reports the ink
    content's bounding box (an auto-trim), which is usually smaller than the
    nominal page and would silently mismatch what the crop UI actually
    showed the user, throwing off the scale of every saved crop rectangle.
    Assumes a uniform page size across the document, so only page 1 is
    queried."""
    if not GS_BIN:
        return None
    try:
        out = subprocess.run(
            [GS_BIN, "-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=png16m", f"-r{PAGE_SIZE_DPI}",
             "-dFirstPage=1", "-dLastPage=1", f"--permit-file-read={path}",
             "-sOutputFile=%stdout%", path],
            capture_output=True, timeout=20,
        )
        return _png_dimensions(out.stdout)
    except (subprocess.SubprocessError, OSError):
        return None


def load_crops(name):
    """Read the per-page crop sidecar for a PDF song, if any (written by the
    manager UI's crop editor via server.js). Returns {} when absent/empty —
    the caller treats that as "no crop, render pages unchanged"."""
    try:
        with open(os.path.join(CROPS_DIR, name + ".json"), encoding="utf-8") as f:
            data = json.load(f)
        pages = data.get("pages") or {}
        return pages if isinstance(pages, dict) else {}
    except (OSError, ValueError):
        return {}


def parse_pdf_song(name):
    """A scanned sheet-music PDF: title from the file name, page count via gs,
    and a Typst-root-relative path for `image(path, page: n)` in book.typ."""
    abs_path = os.path.join(SONGS_DIR, name)
    stem = os.path.splitext(name)[0]
    title = clean_title(stem)

    rel = os.path.relpath(abs_path, ROOT)
    if rel.startswith(".."):
        return None, "outside typst root (--root . can't reach SONGS_DIR)"

    pages = pdf_page_count(abs_path)
    if not pages or pages < 1:
        return None, "gs page count failed (ghostscript missing or unreadable PDF)"

    song = {
        "name": name,
        "title": title,
        "kind": "pdf",
        "path": "/" + rel.replace(os.sep, "/"),
        "pages": pages,
    }

    crops = load_crops(name)
    if crops:
        page_size = pdf_page_size(abs_path)
        if page_size:
            song["crops"] = crops
            song["pageSize"] = page_size
        # else: crop sidecar exists but we couldn't read a page size (e.g.
        # gs missing) — skip cropping rather than fail the whole song.

    return song, None


def clean_title(raw):
    t = EDITORIAL.sub("", raw).strip()
    return t or raw.strip()


def raw_segments(line):
    """[(chord, text)] where chord applies to the start of the following text."""
    segs = []
    pending = ""
    last = 0
    for m in CHORD_RE.finditer(line):
        segs.append((pending, line[last:m.start()]))
        pending = m.group(1)
        last = m.end()
    segs.append((pending, line[last:]))
    return segs


def split_segments(line):
    """Tokenise a lyric line into render-ready chord/word tokens.

    Each token = {chord, word, sp}.  `chord` is placed above the first character
    of `word`; `sp` is True when a *breakable* space precedes the token.  Tokens
    without a preceding space glue together, so a mid-word chord such as
    "for(D)ever" renders as one word "forever" with D over the second syllable.
    """
    tokens = []
    pending_space = False
    for chord, text in raw_segments(line):
        chord_to_place = chord if chord else None
        cur = ""
        tok_chord = ""
        tok_sp = False
        for ch in text:
            if ch == " ":
                if cur:
                    tokens.append({"chord": tok_chord, "word": cur, "sp": tok_sp})
                    cur = ""
                pending_space = True
            else:
                if not cur:
                    tok_sp = pending_space
                    pending_space = False
                    if chord_to_place is not None:
                        tok_chord = chord_to_place
                        chord_to_place = None
                    else:
                        tok_chord = ""
                cur += ch
        if cur:
            tokens.append({"chord": tok_chord, "word": cur, "sp": tok_sp})
        elif chord_to_place is not None:
            # a chord with no following word (e.g. a trailing chord on the line)
            tokens.append({"chord": chord_to_place, "word": "", "sp": pending_space})
            pending_space = False
    if not tokens:
        tokens = [{"chord": "", "word": "", "sp": False}]
    return tokens


def collect_chords(blocks):
    seen = []
    for b in blocks:
        for line in b.get("lines", []):
            for tok in line:
                c = tok["chord"]
                if c and c not in seen:
                    seen.append(c)
    return seen


def parse_body(body):
    """Turn the body text into a list of blocks (verses/choruses/cues)."""
    lines = body.split("\n")
    blocks = []
    cur_type = "verse"
    cur = []          # list of raw lyric strings

    def flush():
        nonlocal cur, cur_type
        real = [l for l in cur if l.strip() != ""]
        if real:
            blocks.append({
                "type": cur_type,
                "lines": [split_segments(l) for l in real],
            })
        cur = []
        cur_type = "verse"

    for raw in lines:
        if raw.strip() == "":
            flush()
            continue

        cue = CUE_RE.match(raw)
        if cue:
            flush()
            kind = cue.group(1).lower()
            extra = cue.group(2).strip()
            label = kind.capitalize()
            times = re.search(r"(\d+)\s*x|x\s*(\d+)", extra, re.IGNORECASE)
            if times:
                n = times.group(1) or times.group(2)
                label += f" (×{n})"
            blocks.append({"type": kind + "-ref", "label": label})
            continue

        mark = MARK_RE.match(raw)
        if mark:
            flush()
            cur_type = mark.group(1).lower()
            rest = MARK_RE.sub("", raw, count=1)
            if rest.strip():
                cur.append(rest)
            continue

        cur.append(raw)

    flush()
    return blocks


def parse_song(name, text):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if BOILERPLATE in text:
        return None

    lines = text.split("\n")
    if not any(l.strip() for l in lines):
        return None

    # The title is always the file name; song files carry no title line.
    title = clean_title(name)

    # Metadata directives (author/history/note/flags) lead the file.
    i = 0
    meta = {}
    while i < len(lines):
        if lines[i].strip() == "":
            i += 1
            continue
        d = DIRECTIVE_RE.match(lines[i])
        if not d:
            break
        meta[d.group(1).lower()] = d.group(2).strip()
        i += 1

    while i < len(lines) and lines[i].strip() == "":
        i += 1

    body = "\n".join(lines[i:])
    blocks = parse_body(body)
    if not blocks:
        return None

    author = meta.get("author", "")
    flags = sorted(set(parse_flags(meta.get("flags"))))

    return {
        "name": name,
        "title": title,
        "kind": "lyric",
        "author": author,
        "meta": meta,
        "flags": flags,
        "chords": collect_chords(blocks),
        "blocks": blocks,
    }


def main():
    names = sorted(n for n in os.listdir(SONGS_DIR) if is_song_file(n))
    songs = []
    skipped = []
    for name in names:
        try:
            with open(os.path.join(SONGS_DIR, name), encoding="utf-8") as fh:
                text = fh.read()
        except (OSError, UnicodeDecodeError) as e:
            skipped.append((name, f"read-error: {e}"))
            continue
        song = parse_song(name, text)
        if song is None:
            skipped.append((name, "empty/stub"))
            continue
        songs.append(song)

    # De-duplicate by cleaned title (keep the richest version).
    by_key = {}
    for s in songs:
        key = s["title"].strip().lower()
        weight = sum(len(l) for b in s["blocks"] for l in b.get("lines", []))
        prev = by_key.get(key)
        if prev is None or weight > prev[0]:
            by_key[key] = (weight, s)
    songs = [v[1] for v in by_key.values()]

    if not GS_BIN:
        print("no `gs` (ghostscript) on PATH — PDF songs will be skipped",
              file=sys.stderr)
    pdf_names = sorted(n for n in os.listdir(SONGS_DIR) if is_pdf_song_file(n))
    for name in pdf_names:
        pdf_song, why = parse_pdf_song(name)
        if pdf_song is None:
            skipped.append((name, why))
            continue
        songs.append(pdf_song)

    songs.sort(key=lambda s: s["title"].lower())

    doc = {
        "generated": time.strftime("%Y-%m-%d %H:%M"),
        "title": BOOK_TITLE,
        "count": len(songs),
        "songs": songs,
    }

    out_dir = os.environ.get("BUILD_DIR", os.path.join(ROOT, "build"))
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "songs.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)

    print(f"parsed {len(songs)} songs -> {out_path}")
    print(f"skipped {len(skipped)} files")
    for name, why in skipped[:80]:
        print(f"  - {name}: {why}", file=sys.stderr)


if __name__ == "__main__":
    main()
