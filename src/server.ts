import app from './app';
import { config } from './config';
import { pool } from './db';
import { logger } from './logger';
import { startWorker } from './worker';

async function main() {
  await pool.query('SELECT 1');
  const stopWorker = startWorker();
  const server = app.listen(config.port, () => logger.info({ port: config.port }, 'API listening'));
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutdown requested');
    stopWorker();
    server.close(() => void pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
main().catch(error => { logger.fatal({ err: error }, 'startup failed'); process.exit(1); });
