import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { createApp } from './app.js';
import { registerJobs, startPoller } from './jobs.js';
import { log } from './logger.js';

const cfg = loadConfig();
const ctx = await createContext(cfg);
registerJobs(ctx);
ctx.queue.start();
const poller = startPoller(ctx);

const server = createApp(ctx).listen(cfg.PORT, () => log.info('server listening', { port: cfg.PORT, storage: cfg.SECRET_STORE }));

const shutdown = () => {
  clearInterval(poller);
  ctx.queue.stop();
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
