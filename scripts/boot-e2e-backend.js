/**
 * "Çiftçiden Sorular" audit follow-up -- Madde 5 (iki hesapla uçtan uca
 * doğrulama, gerçek cihaz/emülatör): boots a REAL Strapi instance (not a
 * node:test harness -- stays alive) against a throwaway SQLite file, on
 * a fixed port, bound to 0.0.0.0 (Strapi's own default) so a REAL
 * Android emulator can reach it via `10.0.2.2:<port>` (the emulator's
 * alias for the host machine's own network interface). Never used for
 * anything except this throwaway local run; never points at
 * production/staging.
 */
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.E2E_PORT || 14399);
const DB_FILE = path.join(__dirname, '..', 'tests', 'integration', '.tmp-e2e-backend.db');

async function main() {
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  process.env.DATABASE_CLIENT = 'sqlite';
  process.env.DATABASE_FILENAME = path.relative(path.join(__dirname, '..'), DB_FILE);
  process.env.PORT = String(PORT);

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const compiled = await compileStrapi();
  const strapi = await createStrapi(compiled).load();
  await strapi.server.listen(PORT);
  // eslint-disable-next-line no-console
  console.log(`E2E_BACKEND_READY port=${PORT}`);

  const shutdown = async () => {
    try {
      await strapi.server.close();
      await strapi.destroy();
    } finally {
      if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('E2E_BACKEND_BOOT_FAILED', e);
  process.exit(1);
});
