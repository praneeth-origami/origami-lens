import '../load-env.js';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { ScanRepository } from '../db/scan-repository.js';
import { PageScanRunner } from '../page-scan-runner.js';
import { WebsiteScanOrchestrator } from '../website-scan-orchestrator.js';
import type { WebsiteScanOptions } from '@origami/contracts';

const QUEUE_NAME = 'website-scan-jobs';

export interface WebsiteScanJobPayload {
  scanId: string;
  rootUrl: string;
  options: WebsiteScanOptions;
  ownerId?: string;
}

let queue: Queue<WebsiteScanJobPayload> | null = null;

export function getRedisConnection(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  return new Redis(url, { maxRetriesPerRequest: null });
}

export function getWebsiteScanQueue(): Queue<WebsiteScanJobPayload> | null {
  const connection = getRedisConnection();
  if (!connection) return null;

  if (!queue) {
    queue = new Queue<WebsiteScanJobPayload>(QUEUE_NAME, { connection });
  }
  return queue;
}

export async function enqueueWebsiteScan(payload: WebsiteScanJobPayload): Promise<boolean> {
  const q = getWebsiteScanQueue();
  if (!q) return false;

  await q.add('website-scan', payload, {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 50,
  });
  return true;
}

export function startWebsiteScanWorker(): Worker<WebsiteScanJobPayload> | null {
  const connection = getRedisConnection();
  if (!connection) {
    console.warn('REDIS_URL not set — website scan worker not started');
    return null;
  }

  const repo = new ScanRepository();
  const pageRunner = new PageScanRunner();
  const orchestrator = new WebsiteScanOrchestrator(repo, pageRunner);

  const worker = new Worker<WebsiteScanJobPayload>(
    QUEUE_NAME,
    async (job: Job<WebsiteScanJobPayload>) => {
      const { scanId, rootUrl, options, ownerId } = job.data;
      await orchestrator.runWebsiteScan(scanId, rootUrl, options, ownerId);
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    console.error(`Website scan job ${job?.id} failed:`, err.message);
    if (job?.data.scanId) {
      void repo.completeScan(job.data.scanId, {
        status: 'FAILED',
        scannedAt: new Date().toISOString(),
        error: err.message,
      });
    }
  });

  console.log('Website scan worker started');
  return worker;
}

if (process.argv[1]?.includes('website-scan-worker')) {
  startWebsiteScanWorker();
}
