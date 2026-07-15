#!/usr/bin/env python3
"""
Parse the folksong-anthology song files into a single structured JSON document
that the Typst template (src/book.typ) renders into the songbook PDF.

A song file is a plain, extension-less file in the repo root (same rule the web
manager uses).  The historical text format is loose, so this parser is
deliberately forgiving and normalises everything into a clean structure:

    { generated, title, songs: [ Song ] }

    Song = {
      name, title, author, meta{key,capo,tempo,time,tuning,source,note,...},
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
files no longer carry a title line.  An optional author line may lead the file,
followed by a blank line.  Workflow flags (needs-lyrics, needs-chords, notation)
are inferred from the content or set explicitly via a `{flags: ...}` directive;
they are never encoded in the file name.
"""

import glob
import json
import os
import re
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

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
# A metadata directive line: "{key: G}", "{capo: 2}", "{tempo: 120}"...
DIRECTIVE_RE = re.compile(r"^\s*\{\s*([a-zA-Z][\w-]*)\s*:\s*(.+?)\s*\}\s*$")

# Parenthetical editorial markers to strip from a file name to get the title.
EDITORIAL = re.compile(
    r"\s*[\(\[][^)\]]*\b(needs?|add|find|confirm|check|decide|jonathan|"
    r"chords?|cords|lyrics|notation|chorus|bridge|verse|tbd|wip)\b[^)\]]*[\)\]]",
    re.IGNORECASE,
)
# ProseMirror "new post" boilerplate that some empty stubs contain.
BOILERPLATE = "Enter text in [Markdown]"

# The workflow flags a song may carry.  All are either inferred from the file's
# content or set explicitly with a `{flags: ...}` directive — never from the
# file name.
KNOWN_FLAGS = ("needs-lyrics", "needs-chords", "notation", "stub", "ready")


def parse_flags(value):
    """Split a `{flags: ...}` directive value into a list of flag slugs."""
    if not value:
        return []
    return [f.strip().lower() for f in re.split(r"[,\s]+", value) if f.strip()]


def infer_flags(text):
    """Flags implied purely by a song's content (no file-name heuristics)."""
    t = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    body_lines = [l for l in t.split("\n")
                  if l.strip() and not DIRECTIVE_RE.match(l)]
    flags = set()
    if len(t.strip()) <= 1 or not body_lines or BOILERPLATE in t:
        flags.add("needs-lyrics")
        return flags
    if len(body_lines) < 6:
        flags.add("stub")
    if not CHORD_RE.search(t):
        flags.add("needs-chords")
    return flags


def is_song_file(name):
    if not name or name.startswith("."):
        return False
    if os.path.splitext(name)[1]:
        return False
    if name in RESERVED:
        return False
    return os.path.isfile(os.path.join(ROOT, name))


def clean_title(raw):
    t = EDITORIAL.sub("", raw).strip()
    return t or raw.strip()


def looks_like_lyric(line):
    """Heuristic: is this first line actually a lyric rather than a title?"""
    if CHORD_RE.search(line):
        return True
    s = line.strip()
    if len(s) > 45:
        return True
    if len(s) > 25 and s[-1:] in ",;:":
        return True
    if "," in s and len(s) > 32:
        return True
    return False


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
    i = 0
    while i < len(lines) and lines[i].strip() == "":
        i += 1
    if i >= len(lines):
        return None

    # The title is always the file name; song files carry no title line.
    title = clean_title(name)

    # Optional leading author line: a short non-lyric line, then a blank line.
    author = ""
    if (i < len(lines) and lines[i].strip() != ""
            and not DIRECTIVE_RE.match(lines[i])
            and not looks_like_lyric(lines[i])
            and not CUE_RE.match(lines[i]) and not MARK_RE.match(lines[i])
            and len(lines[i].strip()) <= 40
            and (i + 1 >= len(lines) or lines[i + 1].strip() == "")):
        author = lines[i].strip()
        i += 1

    # Optional metadata directives.
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

    # Normalise author "by X" / "- X".
    if author:
        author = re.sub(r"^\s*(by|words?|music|trad(?:itional)?\.?)\s*[:.-]?\s*",
                        "", author, flags=re.IGNORECASE).strip() or author

    flags = sorted(set(infer_flags(text)) | set(parse_flags(meta.get("flags"))))

    return {
        "name": name,
        "title": title,
        "author": author,
        "meta": meta,
        "flags": flags,
        "chords": collect_chords(blocks),
        "blocks": blocks,
    }


def main():
    names = sorted(n for n in os.listdir(ROOT) if is_song_file(n))
    songs = []
    skipped = []
    for name in names:
        try:
            with open(os.path.join(ROOT, name), encoding="utf-8") as fh:
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
