// pm2 process config for the Folksong Anthology manager.
//   pm2 start ecosystem.config.cjs
// Runs as www-data on the NEW app server (instrumenta.cc); the Typst build
// itself is executed on the OLD compute server over SSH (see bin/remote-build.sh).
module.exports = {
  apps: [
    {
      name: 'folksong-anthology',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        PORT: 3939,
        HOST: '127.0.0.1',
        // Builds run on the old compute server, which holds the typst binary.
        BUILD_SCRIPT: __dirname + '/bin/remote-build.sh',
        OLD_HOST: '73.144.157.250',
        OLD_USER: 'isidore',
        REMOTE_BUILD_DIR: '/var/www/folksong-build',
        REMOTE_TYPST: '/var/www/bin/typst',
        BUILD_SSH_KEY: '/var/www/.ssh/id_ed25519',
        BOOK_TITLE: 'The Folksong Anthology',
      },
    },
  ],
};
