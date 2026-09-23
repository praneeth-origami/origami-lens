import '../load-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isDatabaseEnabled } from './pool.js';
import { StripeWebhookEventRepository } from './stripe-webhook-event-repository.js';

const dbAvailable = isDatabaseEnabled();
const describeIfDb = dbAvailable ? describe : describe.skip;

describeIfDb('StripeWebhookEventRepository (migration 024, real Postgres)', () => {
  it('markProcessed returns true the first time an event id is seen, false on every repeat (idempotency)', async () => {
    const repo = new StripeWebhookEventRepository();
    const eventId = `evt_${randomUUID()}`;

    assert.equal(await repo.markProcessed(eventId, 'checkout.session.completed'), true);
    assert.equal(await repo.markProcessed(eventId, 'checkout.session.completed'), false);
    assert.equal(await repo.markProcessed(eventId, 'checkout.session.completed'), false);
  });

  it('different event ids are independent', async () => {
    const repo = new StripeWebhookEventRepository();
    assert.equal(await repo.markProcessed(`evt_${randomUUID()}`, 'invoice.payment_failed'), true);
    assert.equal(await repo.markProcessed(`evt_${randomUUID()}`, 'invoice.payment_failed'), true);
  });
});
