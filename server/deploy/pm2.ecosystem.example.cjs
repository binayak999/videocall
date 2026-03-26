/**
 * Example PM2 config — run from monorepo root after `npm run build`.
 *
 *   npm i -g pm2
 *   # Set env in apps/api/.env and apps/signaling/.env (or use env_production below)
 *   pm2 start deploy/pm2.ecosystem.example.cjs
 *   pm2 save && pm2 startup
 */
module.exports = {
  apps: [
    {
      name: "bandr-api",
      cwd: "./apps/api",
      script: "dist/index.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "4001",
      },
    },
    {
      name: "bandr-signaling",
      cwd: "./apps/signaling",
      script: "dist/index.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "4002",
      },
    },
  ],
};
