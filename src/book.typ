// =============================================================================
//  The Folksong Anthology — songbook layout (Typst)
//
//  Rendered from build/songs.json (produced by bin/parse-songs.py).  Compile:
//    typst compile --ignore-system-fonts --root . \
//        --input data=/build/songs.json src/book.typ build/songbook.pdf
//
//  Everything about the look of the book lives here: title page, alphabetical
//  index, two-column song layout, chord-over-lyric setting, guitar chord
//  diagrams, verse/chorus styling, running heads and page numbers.
// =============================================================================

#let data-path = sys.inputs.at("data", default: "/build/songs.json")
#let doc = json(data-path)

// ---- build-time flags -------------------------------------------------------
// Guitar chord diagrams are OFF unless the build asks for them, either globally
//   typst compile ... --input diagrams=on
// or per song via a directive in the song file:  {diagrams: on}
#let want-diagrams = sys.inputs.at("diagrams", default: "off").trim() == "on"

// ---- palette & type ---------------------------------------------------------
// Tuned to read well in plain black & white; the accent only ever carries
// redundant emphasis (chords are also bold+mono, choruses are also italic).
#let ink      = rgb("#1a1a1a")
#let accent   = rgb("#8f2d1c")     // warm brick red
#let muted    = rgb("#5f5f5f")
#let chorustint = rgb("#f4f0ea")   // very light warm tint (prints near-white)

#let serif = "Libertinus Serif"
#let mono  = "DejaVu Sans Mono"

#let lyric-size  = 10pt
#let chord-size  = 8pt
#let chord-slot  = 8.5pt           // reserved height above a chorded lyric line

// ---- page geometry (kept in sync with `set page` below) ---------------------
#let page-w = 8.5in
#let page-h = 11in
#let m-x    = 0.6in
#let m-top  = 0.75in
#let m-bot  = 0.6in
#let gutter = 22pt
#let col-w  = (page-w - 2 * m-x - gutter) / 2
#let col-h  = page-h - m-top - m-bot - 0.28in    // less header/footer band

// =============================================================================
//  Chord diagrams (guitar).  Frets are low-E..high-E; -1 muted, 0 open.
// =============================================================================
#let SHAPES = (
  "C": (-1,3,2,0,1,0),   "C7": (-1,3,2,3,1,0),   "Cmaj7": (-1,3,2,0,0,0),
  "Cadd9": (-1,3,2,0,3,0), "Cm": (-1,3,5,5,4,3),
  "C#": (-1,4,3,1,2,1),  "C#m": (-1,4,6,6,5,4),
  "D": (-1,-1,0,2,3,2),  "D7": (-1,-1,0,2,1,2),  "Dm": (-1,-1,0,2,3,1),
  "Dm7": (-1,-1,0,2,1,1), "Dmaj7": (-1,-1,0,2,2,2), "Dsus2": (-1,-1,0,2,3,0),
  "Dsus4": (-1,-1,0,2,3,3), "D/F#": (2,-1,0,2,3,2),
  "Eb": (-1,-1,1,3,4,3),
  "E": (0,2,2,1,0,0),    "E7": (0,2,0,1,0,0),    "Em": (0,2,2,0,0,0),
  "Em7": (0,2,0,0,0,0),  "Emaj7": (0,2,1,1,0,0),
  "F": (1,3,3,2,1,1),    "F7": (1,3,1,2,1,1),    "Fm": (1,3,3,1,1,1),
  "Fmaj7": (-1,-1,3,2,1,0),
  "F#": (2,4,4,3,2,2),   "F#m": (2,4,4,2,2,2),   "F#m7": (2,4,2,2,2,2),
  "G": (3,2,0,0,0,3),    "G7": (3,2,0,0,0,1),    "Gmaj7": (3,2,0,0,0,2),
  "Gm": (3,5,5,3,3,3),   "Gsus4": (3,3,0,0,1,3),  "G6": (3,2,0,0,0,0),
  "G#m": (4,6,6,4,4,4),
  "A": (-1,0,2,2,2,0),   "A7": (-1,0,2,0,2,0),   "Am": (-1,0,2,2,1,0),
  "Am7": (-1,0,2,0,1,0), "Amaj7": (-1,0,2,1,2,0), "Asus2": (-1,0,2,2,0,0),
  "Asus4": (-1,0,2,2,3,0), "Am6": (-1,0,2,2,1,2),
  "Bb": (-1,1,3,3,3,1),  "Bb7": (-1,1,3,1,3,1),  "Bbmaj7": (-1,1,3,2,3,1),
  "B": (-1,2,4,4,4,2),   "B7": (-1,2,1,2,0,2),   "Bm": (-1,2,4,4,3,2),
  "Bm7": (-1,2,0,2,0,2), "Bdim": (-1,2,3,4,3,-1),
)

// spelling normalisation for diagram lookup
#let ENHARM = ("Db":"C#","Gb":"F#","Ab":"G#","A#":"Bb","D#":"Eb","G#":"Ab")

#let lookup-shape(name) = {
  if name in SHAPES { return SHAPES.at(name) }
  // try normalising just the root's accidental
  for (a, b) in ENHARM {
    if name.starts-with(a) {
      let alt = b + name.slice(a.len())
      if alt in SHAPES { return SHAPES.at(alt) }
    }
  }
  // slash chord: fall back to the shape of the part before "/"
  if name.contains("/") {
    let root = name.split("/").at(0)
    if root in SHAPES { return SHAPES.at(root) }
  }
  none
}

// pretty chord name: real sharp/flat glyphs
#let fmt-chord(c) = {
  show "#": "\u{266F}"
  show regex("([A-G])b"): m => m.text.slice(0,1) + "\u{266D}"
  c
}

#let chord-diagram(name) = {
  let frets = lookup-shape(name)
  if frets == none { return none }
  let sx = 4.6pt          // string spacing
  let sy = 5.4pt          // fret spacing
  let span = 4            // frets shown
  let n-str = 6
  let played = frets.filter(f => f > 0)
  let base = if played.len() == 0 { 1 } else { calc.min(..played) }
  if played.len() == 0 or calc.max(..played) <= span { base = 1 }
  let top = 8pt           // room for the o/x markers + base label
  let boardw = sx * (n-str - 1)
  let boardh = sy * span
  let dot-r = 1.7pt

  let el = ()             // placed elements
  // markers above the nut
  for i in range(n-str) {
    let f = frets.at(i)
    let x = sx * i
    if f == 0 {
      el.push(place(dx: x - 1.3pt, dy: 0pt,
        circle(radius: 1.3pt, stroke: 0.5pt + ink, fill: none)))
    } else if f < 0 {
      el.push(place(dx: x - 1.6pt, dy: -0.5pt,
        text(size: 5pt, fill: muted)[\u{00D7}]))
    }
  }
  // strings (vertical)
  for i in range(n-str) {
    let x = sx * i
    el.push(place(dx: x, dy: top, line(
      start: (0pt, 0pt), end: (0pt, boardh), stroke: 0.4pt + ink)))
  }
  // frets (horizontal); nut thick when base == 1
  for j in range(span + 1) {
    let y = top + sy * j
    let sw = if j == 0 and base == 1 { 1.4pt } else { 0.4pt }
    el.push(place(dx: 0pt, dy: y, line(
      start: (0pt, 0pt), end: (boardw, 0pt), stroke: sw + ink)))
  }
  // base-fret label
  if base > 1 {
    el.push(place(dx: boardw + 1.5pt, dy: top + sy * 0.5,
      text(size: 5pt, fill: muted)[#base fr]))
  }
  // finger dots
  for i in range(n-str) {
    let f = frets.at(i)
    if f > 0 {
      let x = sx * i
      let y = top + sy * (f - base + 0.5)
      el.push(place(dx: x - dot-r, dy: y - dot-r,
        circle(radius: dot-r, fill: accent, stroke: none)))
    }
  }

  box(inset: (top: 0pt), stack(dir: ttb, spacing: 1.5pt,
    box(width: boardw + 8pt, height: top + boardh, el.join()),
    text(size: 6.5pt, fill: ink, font: mono)[#fmt-chord(name)],
  ))
}

#let diagram-strip(chords) = {
  let shown = chords.filter(c => lookup-shape(c) != none)
  if shown.len() == 0 { return none }
  block(above: 4pt, below: 6pt,
    box(fill: chorustint, radius: 3pt, inset: (x: 6pt, y: 5pt),
      stack(dir: ltr, spacing: 7pt, ..shown.map(chord-diagram))))
}

// =============================================================================
//  Lyric line rendering (chords stacked over words)
// =============================================================================
#let word-box(chord, word) = box(baseline: 0pt, stack(dir: ttb, spacing: 0.5pt,
  box(height: chord-slot)[
    #if chord != "" {
      text(font: mono, weight: "bold", size: chord-size, fill: accent,
        bottom-edge: "baseline")[#fmt-chord(chord)]
    }
  ],
  if word == "" { box(width: 0.35em) } else { word },
))

#let render-line(tokens) = {
  // Chordless lines render as plain tight text; only lines that actually carry
  // a chord pay for the raised chord row.
  let has-chord = tokens.any(t => t.chord != "")
  if not has-chord {
    let s = ""
    for t in tokens { if t.sp { s += " " }; s += t.word }
    if s == "" { [ ] } else { s }
  } else {
    let out = []
    for tok in tokens {
      if tok.sp { out += [ ] }
      out += word-box(tok.chord, tok.word)
    }
    out
  }
}

// small raised verse number, set at the lyric baseline before the first word
#let verse-num(n) = box(baseline: 0pt, inset: (right: 0.45em),
  text(size: 8pt, weight: "bold", fill: accent, font: mono)[#n])

#let render-block(bl, vnum: none) = {
  let ty = bl.type
  if ty == "chorus-ref" or ty == "bridge-ref" {
    block(above: 6pt, below: 6pt, inset: (left: 8pt),
      text(style: "italic", fill: accent, size: lyric-size)[#bl.label])
  } else {
    // lyric lines; the first line may carry a verse number
    let lines = bl.lines.enumerate().map(((i, ln)) => {
      if i == 0 and vnum != none { verse-num(vnum) + render-line(ln) }
      else { render-line(ln) }
    })
    let body = lines.join(linebreak())
    if ty == "chorus" or ty == "bridge" {
      // Chorus: italic + a thin left rule + gentle indent.  All three cues are
      // independent of colour, so it still reads as a chorus in B&W.
      block(above: 7pt, below: 7pt, width: 100%,
        inset: (left: 8pt, top: 1pt, bottom: 1pt),
        stroke: (left: 1pt + accent))[
          #if ty == "bridge" {
            text(size: 6.5pt, tracking: 1.5pt, fill: accent, weight: "bold")[BRIDGE]
            linebreak()
          }
          #set text(style: "italic")
          #body
        ]
    } else {
      block(above: 7pt, below: 7pt)[#body]
    }
  }
}

// =============================================================================
//  Song
// =============================================================================
#let META-LABELS = (
  key: "Key", capo: "Capo", tempo: "Tempo", time: "Time",
  tuning: "Tuning", source: "Source", note: "Note", trad: "",
)

#let meta-line(meta) = {
  let parts = ()
  for (k, label) in META-LABELS {
    if k in meta {
      let v = meta.at(k)
      parts.push(if label == "" { v } else [#label: #v])
    }
  }
  if parts.len() == 0 { return none }
  block(above: 2pt, below: 3pt,
    text(size: 8pt, fill: muted, font: mono)[#parts.join("   ·   ")])
}

#let song-body(s) = {
  let show-diag = want-diagrams or (
    "diagrams" in s.meta and lower(s.meta.diagrams) in ("on", "yes", "true"))
  // number verses only when there is more than one
  let n-verses = s.blocks.filter(b => b.type == "verse").len()
  let vc = 0

  // header kept with the first slice of the song
  block(breakable: false, sticky: true, below: 2pt)[
    #heading(level: 1, outlined: true)[#s.title]
    #if s.author != "" {
      block(above: 1pt, below: 2pt,
        text(size: 9pt, style: "italic", fill: muted)[#s.author])
    }
    #meta-line(s.meta)
    #if show-diag { diagram-strip(s.chords) }
  ]
  for bl in s.blocks {
    if bl.type == "verse" and n-verses > 1 {
      vc += 1
      render-block(bl, vnum: vc)
    } else {
      render-block(bl)
    }
  }
}

#let song(s) = context {
  let body = song-body(s)
  // Keep a song whole when it fits in a single column; Typst then floats the
  // whole block to the next column/page rather than splitting it.
  let h = measure(box(width: col-w, body)).height
  block(breakable: h > col-h - 16pt, above: 15pt, below: 4pt, width: 100%, body)
}

// =============================================================================
//  Page setup
// =============================================================================
#set document(title: doc.title, author: "Folksong Anthology")
#set page(
  paper: "us-letter",
  margin: (top: m-top, bottom: m-bot, x: m-x),
  fill: white,
)
#set text(font: serif, size: lyric-size, fill: ink, lang: "en", hyphenate: false)
#set par(leading: 0.42em, spacing: 0.42em)

// Song titles
#show heading.where(level: 1): it => block(above: 0pt, below: 3pt, {
  set text(font: serif, size: 13pt, weight: "bold", fill: ink)
  it.body
  place(dy: 0.62em, line(length: 100%, stroke: 0.5pt + accent.lighten(30%)))
  v(4pt)
})

// =============================================================================
//  Front matter — title page
// =============================================================================
#page(margin: 0in, header: none, footer: none, {
  set align(center + horizon)
  block(width: 100%, {
    v(1fr)
    text(size: 11pt, tracking: 4pt, fill: accent)[F O L K S O N G]
    v(6pt)
    text(font: serif, size: 46pt, weight: "bold")[The Anthology]
    v(10pt)
    line(length: 34%, stroke: 0.8pt + accent)
    v(14pt)
    text(size: 12pt, style: "italic", fill: muted)[
      #doc.count songs · words, chords & guitar shapes
    ]
    v(2fr)
    text(size: 9pt, fill: muted, font: mono)[Compiled #doc.generated]
    v(1fr)
  })
})

// =============================================================================
//  Front matter — alphabetical index
// =============================================================================
#page(header: none, footer: none, {
  text(font: serif, size: 22pt, weight: "bold")[Index of Songs]
  v(2pt)
  line(length: 100%, stroke: 0.5pt + accent.lighten(30%))
  v(8pt)
  set text(size: 9pt)
  columns(3, gutter: 16pt, {
    context {
      let items = query(heading.where(level: 1))
      for it in items {
        let pg = counter(page).at(it.location()).first()
        box(width: 100%)[
          #text(fill: ink)[#it.body]
          #box(width: 1fr, inset: (x: 3pt),
            align(bottom, line(length: 100%, stroke: (dash: "dotted", paint: muted, thickness: 0.4pt))))
          #text(fill: muted, font: mono, size: 8pt)[#pg]
        ]
        linebreak()
      }
    }
  })
})

// =============================================================================
//  Song body — two columns, running heads, page numbers
// =============================================================================
#set page(
  header: context {
    // Running head: the last song that has begun by this page (outer), and the
    // book title (inner).  Rule sits cleanly *below* the text, not through it.
    let cur = counter(page).get().first()
    let songs-here = query(heading.where(level: 1))
      .filter(h => counter(page).at(h.location()).first() <= cur)
    let label = if songs-here.len() > 0 { songs-here.last().body } else [#doc.title]
    block(width: 100%, {
      set text(size: 8pt, fill: muted, font: serif)
      grid(columns: (1fr, auto),
        text(style: "italic")[#label],
        smallcaps[#doc.title],
      )
      v(3pt)
      line(length: 100%, stroke: 0.4pt + muted.lighten(45%))
    })
  },
  footer: context {
    set text(size: 8.5pt, fill: muted, font: mono)
    align(center)[#counter(page).display()]
  },
)
#counter(page).update(1)

#columns(2, gutter: gutter, {
  for s in doc.songs { song(s) }
})
