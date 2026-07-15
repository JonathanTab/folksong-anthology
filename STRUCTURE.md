This project is a folk song book, with a web ui for editing song files, and a typst PDF build system.

Webapp:
/server.js, /ecosystem.js, /package.json, /public/*

Build system:
/src/book.typ, /bin/build.sh, /bin/parse-songs.py, /bin/remote-build.sh

Webapp is deployed to the server via python3 ../instrumenta/deploy.py and is exposed at https://instrumenta.cc/songbook/
The actual song data are on the server. You can examine them if needed via ssh root@instrumenta.cc:/var/www/instrumenta/data/folksong-anthology/*