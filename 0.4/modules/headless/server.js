import { createHeadlessApp } from './index.js';

let app, stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  try { await app?.stop(); } finally { process.exit(code); }
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('uncaughtException', error => { console.error(error); void shutdown(1); });
process.on('unhandledRejection', error => { console.error(error); void shutdown(1); });

try {
  app = createHeadlessApp();
  const port = await app.start();
  console.log(`Headless console listening on port ${port}; connection settings: /runtime/connection`);
} catch (error) {
  console.error('[headless] Startup failed:', error.message);
  await shutdown(1);
}
