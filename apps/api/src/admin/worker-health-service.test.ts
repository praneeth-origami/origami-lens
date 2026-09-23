import '../load-env.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isDatabaseEnabled } from '../db/pool.js';
import { checkPostgres, checkRedis, checkQueues } from './worker-health-service.js';

const dbAvailable = isDatabaseEnabled();
const describeIfDb = dbAvailable ? describe : describe.skip;

const originalRedisUrl = process.env.REDIS_URL;
afterEach(() => {
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
});

describeIfDb('worker-health-service — checkPostgres (real Postgres)', () => {
  it('reports ok against a real, reachable database', async () => {
    const result = await checkPostgres();
    assert.equal(result.status, 'ok');
  });
});

describe('worker-health-service — checkRedis / checkQueues degrade gracefully with no REDIS_URL', () => {
  it('checkRedis reports not_configured, never throws, when REDIS_URL is unset', async () => {
    delete process.env.REDIS_URL;
    const result = await checkRedis();
    assert.equal(result.configured, false);
    assert.equal(result.status, 'not_configured');
  });

  it('checkQueues reports every known queue as zero, never throws, when REDIS_URL is unset', async () => {
    delete process.env.REDIS_URL;
    const queues = await checkQueues();
    assert.ok(queues.length >= 7);
    for (const queue of queues) {
      assert.equal(queue.active, 0);
      assert.equal(queue.waiting, 0);
    }
  });
});
