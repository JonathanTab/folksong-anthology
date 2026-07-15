# folksong-anthology

Song files live as plain, extension-less files at the repo root. Each
file's name **is** its title (editorial markers like `(Needs Lyrics)`
are stripped for display). See a song file for the format: an
optional author line, optional `{directives}`, then verses with
`(G)`-style inline chords and `(Chorus)` blocks.

To edit songs or build the PDF, use the **Songbook Manager** web app
in this repo (`server.js` + `public/`) — deployed at
https://instrumenta.cc/folksong/. It has its own in-place editor with
live preview, per-song workflow flags, and a build/view flow for the
generated PDF.

The book is typeset with [Typst](https://typst.app) via
`bin/parse-songs.py` (songs → `build/songs.json`) and `src/book.typ`.
Run the whole pipeline with `bin/build.sh`.
