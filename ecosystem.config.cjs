/** @type {import('pm2').App[]} */
module.exports = {
  apps: [
    {
      name: 'stock-backend',
      script: './app.js',
      node_args: "--trace-warnings",
      max_memory_restart: "500M",
      watch: false,

      /* ===== Watch settings ===== */
      ignore_watch: ['node_modules', 'uploads', 'utils/logs', 'public', ".git", ".git/**"],

      /* ===== Environments ===== */
      env: {
        NODE_ENV: 'development',
        WATCH_MODE: true,
        watch: true
      },
      env_production: {
        NODE_ENV: 'production',
        WATCH_MODE: false,
        watch: false
      },
    },
  ],
};