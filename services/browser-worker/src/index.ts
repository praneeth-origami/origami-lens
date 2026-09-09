import './load-env.js';
import Fastify from 'fastify';
import type { ScanRequest } from '@origami/contracts';
import { BrowserWorker } from './browser-worker.js';

const PORT = Number(process.env.BROWSER_WORKER_PORT ?? 3101);
const HOST = process.env.BROWSER_WORKER_HOST ?? '0.0.0.0';

const worker = new BrowserWorker();

const app = Fastify({ logger: true });

app.get('/health', async () => ({ status: 'ok', service: 'browser-worker' }));

app.post<{ Body: ScanRequest }>('/scan', async (request, reply) => {
  const { url, options } = request.body;

  if (!url) {
    return reply.status(400).send({ error: 'url is required' });
  }

  try {
    const evidence = await worker.scanUrl(url, {
      includeScreenshots: options?.includeScreenshots ?? true,
      mobileViewport: options?.mobileViewport ?? true,
      runLighthouse: options?.runLighthouse ?? true,
      runAxe: options?.runAxe ?? true,
    });

    return { evidence };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Browser scan failed';
    request.log.error(error);
    return reply.status(500).send({ error: message });
  }
});

async function start() {
  try {
    await worker.init();
    await app.listen({ port: PORT, host: HOST });
    console.log(`Browser Worker listening on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  await worker.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await worker.close();
  process.exit(0);
});

start();
