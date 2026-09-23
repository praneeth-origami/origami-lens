/**
 * Real health probes health.ts doesn't do today (confirmed by this
 * session's audit: checkDependencies() never pings Postgres or Redis
 * directly) plus BullMQ queue-depth introspection, which no worker exposes
 * anywhere yet. Read-only: every Queue instance here has no Worker
 * attached and never processes a job, it only asks Redis "how many jobs are
 * in this queue's active/waiting/delayed/failed states."
 */
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { getPool } from '../db/pool.js';

const QUEUE_NAMES = [
  'website-scan-jobs',
  'component-generation-jobs',
  'repository-clone-jobs',
  'repository-index-jobs',
  'repository-embedding-jobs',
  'repository-issue-analysis-jobs',
  'repository-fix-proposal-jobs',
] as const;

export interface PostgresHealth {
  status: 'ok' | 'down';
  error?: string;
}

export interface RedisHealth {
  configured: boolean;
  status: 'ok' | 'down' | 'not_configured';
  error?: string;
}

export interface QueueHealth {
  name: string;
  active: number;
  waiting: number;
  delayed: number;
  failed: number;
}

export interface WorkerHealthReport {
  postgres: PostgresHealth;
  redis: RedisHealth;
  queues: QueueHealth[];
}

let introspectionConnection: Redis | null = null;

/** One shared, lazily-created connection reused across every ping/queue check — never one connection per call. Swallows its own 'error' events (still surfaced via the try/catch in checkRedis/checkQueues below) so an unreachable Redis never crashes the process with an unhandled emitter error. */
function getIntrospectionConnection(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!introspectionConnection) {
    introspectionConnection = new Redis(url, { maxRetriesPerRequest: null });
    introspectionConnection.on('error', () => {});
  }
  return introspectionConnection;
}

export async function checkPostgres(): Promise<PostgresHealth> {
  const pool = getPool();
  if (!pool) return { status: 'down', error: 'DATABASE_URL not set' };
  try {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  } catch (error) {
    return { status: 'down', error: error instanceof Error ? error.message : 'Unreachable' };
  }
}

export async function checkRedis(): Promise<RedisHealth> {
  const connection = getIntrospectionConnection();
  if (!connection) return { configured: false, status: 'not_configured' };
  try {
    const pong = await connection.ping();
    return { configured: true, status: pong === 'PONG' ? 'ok' : 'down' };
  } catch (error) {
    return { configured: true, status: 'down', error: error instanceof Error ? error.message : 'Unreachable' };
  }
}

/** Not configured -> every queue reports zero (there is nothing to ask), matching every other optional-infra check in this codebase rather than erroring. */
export async function checkQueues(): Promise<QueueHealth[]> {
  const connection = getIntrospectionConnection();
  if (!connection) {
    return QUEUE_NAMES.map((name) => ({ name, active: 0, waiting: 0, delayed: 0, failed: 0 }));
  }

  return Promise.all(
    QUEUE_NAMES.map(async (name): Promise<QueueHealth> => {
      try {
        const queue = new Queue(name, { connection });
        const counts = await queue.getJobCounts('active', 'waiting', 'delayed', 'failed');
        // Never closes the shared `connection` — BullMQ only disconnects a
        // connection it created itself, not one passed in by the caller.
        await queue.close();
        return { name, active: counts.active ?? 0, waiting: counts.waiting ?? 0, delayed: counts.delayed ?? 0, failed: counts.failed ?? 0 };
      } catch {
        return { name, active: 0, waiting: 0, delayed: 0, failed: 0 };
      }
    }),
  );
}

export async function getWorkerHealthReport(): Promise<WorkerHealthReport> {
  const [postgres, redis, queues] = await Promise.all([checkPostgres(), checkRedis(), checkQueues()]);
  return { postgres, redis, queues };
}
