import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { createDatabase } from '../../src/storage/db.js';
import { VirtualClock } from '../../src/core/clock.js';
import { createSimulatorServer } from '../../src/api/server.js';
import { OutboxWorker } from '../../src/delivery/worker.js';
import { createMerchantServer } from '../../merchant-demo/server.js';
import {
  getWebhookSubscription,
  getOutboxItemsByPaymentId
} from '../../src/storage/repositories.js';
import { createSignedNotificationEnvelope } from '../../src/delivery/sns-signer.js';
import { type FastifyInstance } from 'fastify';

describe('Week 2 Exit: Dual-Channel E2E, Signatures, and Worker Leases', () => {
  let simApp: FastifyInstance;
  let simBaseUrl: string;
  let simDb: ReturnType<typeof createDatabase>;
  let clock: VirtualClock;
  let worker: OutboxWorker;
  let workerEvents: EventEmitter;

  let merchantApp: FastifyInstance;
  let merchantBaseUrl: string;
  let merchantDb: ReturnType<typeof createMerchantServer>['db'];
  let setPaysimConfig: ReturnType<typeof createMerchantServer>['setPaysimConfig'];

  beforeAll(async () => {
    simDb = createDatabase(':memory:');
    clock = new VirtualClock(1700000000000);
    workerEvents = new EventEmitter();

    simApp = createSimulatorServer({
      db: simDb,
      clock,
      workerEvents
    });

    simBaseUrl = await simApp.listen({ port: 0, host: '127.0.0.1' });

    worker = new OutboxWorker({
      db: simDb,
      clock,
      eventEmitter: workerEvents,
      pollIntervalMs: 50,
      leaseDurationMs: 30000,
      maxAttempts: 5
    });
    worker.start();

    const merchant = createMerchantServer();
    merchantApp = merchant.app;
    merchantDb = merchant.db;
    setPaysimConfig = merchant.setPaysimConfig;

    merchantBaseUrl = await merchantApp.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    worker.stop();
    await simApp.close();
    await merchantApp.close();
    simDb.close();
    merchantDb.close();
  });

  it('completes the two-step SubscriptionConfirmation handshake and full payment flow (Day 11 & 12)', async () => {
    const hardenedTargetUrl = `${merchantBaseUrl}/ipn/hardened`;

    // 1. Register webhook subscription on PaySim-BD
    const regRes = await fetch(`${simBaseUrl}/_paysim/webhooks/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: hardenedTargetUrl })
    });
    expect(regRes.status).toBe(200);
    const regData = (await regRes.json()) as { status: string; token: string };
    expect(regData.status).toBe('PENDING_CONFIRMATION');

    // 2. Delivery worker delivers SubscriptionConfirmation to merchant
    await worker.processDueRows();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // 3. Verify merchant verified signature, called SubscribeURL, and subscription is now ACTIVE
    const sub = getWebhookSubscription(simDb, hardenedTargetUrl);
    expect(sub?.status).toBe('ACTIVE');
    expect(sub?.confirmed_at).toBeDefined();

    // 4. Run payment flow
    const grantRes = await fetch(`${simBaseUrl}/tokenized/checkout/token/grant`, {
      method: 'POST'
    });
    const { id_token } = (await grantRes.json()) as { id_token: string };
    setPaysimConfig(simBaseUrl, id_token);

    const orderId = 'ORD_E2E_HARDENED_1';
    await fetch(`${merchantBaseUrl}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, customerId: 'CUST_E2E', initialBalancePaisa: 0 })
    });

    const createRes = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${id_token}`,
        'x-paysim-auto-approve': 'success'
      },
      body: JSON.stringify({
        amount: '650.00',
        merchantInvoiceNumber: orderId,
        callbackURL: `${merchantBaseUrl}/bkash/callback`
      })
    });
    const { paymentID } = (await createRes.json()) as { paymentID: string };

    // Wait for auto-approval and merchant GET /bkash/callback -> POST /execute
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Process IPN notification through outbox worker
    await worker.processDueRows();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify outbox row status was marked DELIVERED
    const outboxRows = getOutboxItemsByPaymentId(simDb, paymentID);
    expect(outboxRows.length).toBeGreaterThan(0);
    expect(outboxRows[0]?.status).toBe('DELIVERED');
    expect(outboxRows[0]?.last_http_status).toBe(200);
  });

  it('rejects tampered payloads with HTTP 400 on Hardened Merchant, while Naive Merchant accepts them (Day 11)', async () => {
    const signingCertUrl = `${simBaseUrl}/.well-known/paysim-sns.pem`;
    const orderId = 'ORD_TAMPER_TEST';

    await fetch(`${merchantBaseUrl}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, customerId: 'CUST_TAMPER', initialBalancePaisa: 0 })
    });

    // 1. Create a legitimately signed Notification for 100.00 BDT
    const originalMessage = JSON.stringify({
      dateTime: clock.nowIso(),
      debitMSISDN: '01770618575',
      amount: '100.00',
      currency: 'BDT',
      trxID: 'BKTAMPER01',
      transactionStatus: 'Completed',
      merchantInvoiceNumber: orderId,
      paymentID: 'PAY_TAMPER_01'
    });

    const signedEnvelope = createSignedNotificationEnvelope(
      {
        Type: 'Notification',
        MessageId: 'msg-tamper-test',
        TopicArn: 'arn:aws:sns:ap-southeast-1:000000000000:bkash-ipn',
        Subject: 'bKash Payment Notification',
        Message: originalMessage,
        Timestamp: clock.nowIso()
      },
      signingCertUrl
    );

    // 2. Tamper with the amount inside Message WITHOUT updating the RSA-SHA1 signature
    const tamperedMessage = JSON.stringify({
      dateTime: clock.nowIso(),
      debitMSISDN: '01770618575',
      amount: '99999.00', // Forged amount
      currency: 'BDT',
      trxID: 'BKTAMPER01',
      transactionStatus: 'Completed',
      merchantInvoiceNumber: orderId,
      paymentID: 'PAY_TAMPER_01'
    });

    const forgedPayload = {
      ...signedEnvelope,
      Message: tamperedMessage // Tampered!
    };

    // 3. Send to Hardened Merchant -> MUST be rejected with HTTP 400
    const hardenedRes = await fetch(`${merchantBaseUrl}/ipn/hardened`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-amz-sns-message-type': 'Notification'
      },
      body: JSON.stringify(forgedPayload)
    });
    expect(hardenedRes.status).toBe(400);
    const hardenedData = (await hardenedRes.json()) as { error: string };
    expect(hardenedData.error).toBe('Invalid SNS signature');

    // Verify wallet balance remained 0
    const checkHardened = await (await fetch(`${merchantBaseUrl}/orders/${orderId}`)).json();
    expect(checkHardened.balance_paisa).toBe(0);

    // 4. Send to Naive Merchant -> Blindly accepts and credits the tampered amount!
    const naiveRes = await fetch(`${merchantBaseUrl}/ipn/naive`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-amz-sns-message-type': 'Notification'
      },
      body: JSON.stringify(forgedPayload)
    });
    expect(naiveRes.status).toBe(200);

    // Verify naive merchant credited the forged 99,999.00 BDT (9,999,900 paisa)
    const checkNaive = await (await fetch(`${merchantBaseUrl}/orders/${orderId}`)).json();
    expect(checkNaive.balance_paisa).toBe(9999900);
  });

  it('handles crash-safe 30s leases, exponential backoff, and recovery (Day 10)', async () => {
    let attemptsCount = 0;

    // Ephemeral server endpoint that fails with 500 for the first 2 calls, then succeeds
    const flakeApp = (await import('fastify')).default();
    flakeApp.post('/ipn/flaky', async (_req, reply) => {
      attemptsCount++;
      if (attemptsCount < 3) {
        return reply.code(500).send({ error: 'Server temporarily unavailable' });
      }
      return reply.code(200).send({ status: 'ok' });
    });
    const flakeUrl = await flakeApp.listen({ port: 0, host: '127.0.0.1' });

    try {
      // 1. Insert an outbox item pointing to the flaky endpoint
      const outboxId = simDb
        .prepare(`
          INSERT INTO ipn_outbox (
            payment_id, sns_message_id, sns_type, payload, signature,
            attempts, next_attempt_at, locked_until, status
          ) VALUES (?, 'flaky-msg-1', 'Notification', '{}', 'mock-sig', 0, ?, 0, 'PENDING')
        `)
        .run(`${flakeUrl}/ipn/flaky`, clock.nowMs()).lastInsertRowid as number;

      // 2. Attempt 1: worker claims row with 30s lease, encounters 500
      await worker.processDueRows();

      const rowAfter1 = simDb.prepare('SELECT * FROM ipn_outbox WHERE id = ?').get(outboxId) as {
        status: string;
        attempts: number;
        next_attempt_at: number;
        locked_until: number | null;
      };
      expect(rowAfter1.status).toBe('RETRY');
      expect(rowAfter1.attempts).toBe(1);
      expect(rowAfter1.locked_until).toBeNull();
      // Backoff delay for attempt 1: 1000ms * 2^0 = 1000ms
      expect(rowAfter1.next_attempt_at).toBe(clock.nowMs() + 1000);

      // 3. Worker tick before next_attempt_at should NOT pick up the row
      await worker.processDueRows();
      expect(attemptsCount).toBe(1);

      // 4. Advance virtual clock by 1000ms -> triggers Attempt 2
      clock.advanceMs(1000);
      await worker.processDueRows();

      const rowAfter2 = simDb.prepare('SELECT * FROM ipn_outbox WHERE id = ?').get(outboxId) as {
        status: string;
        attempts: number;
        next_attempt_at: number;
      };
      expect(rowAfter2.status).toBe('RETRY');
      expect(rowAfter2.attempts).toBe(2);
      // Backoff delay for attempt 2: 1000ms * 2^1 = 2000ms
      expect(rowAfter2.next_attempt_at).toBe(clock.nowMs() + 2000);

      // 5. Test crash-safe lease recovery:
      // Manually set locked_until = clock.nowMs() + 30000 (simulating mid-flight crash)
      simDb
        .prepare('UPDATE ipn_outbox SET locked_until = ? WHERE id = ?')
        .run(clock.nowMs() + 30000, outboxId);

      // Advance clock only past backoff (2000ms), but NOT past lease (30000ms)
      clock.advanceMs(2000);
      await worker.processDueRows();
      // Still locked by active lease!
      expect(attemptsCount).toBe(2);

      // Advance clock past 30s lease expiration (+29000ms)
      clock.advanceMs(29000);
      await worker.processDueRows();

      // 6. Attempt 3: reclaimed after crash lease expired and flaky server returns 200 OK!
      const rowAfter3 = simDb.prepare('SELECT * FROM ipn_outbox WHERE id = ?').get(outboxId) as {
        status: string;
        attempts: number;
        last_http_status: number;
        locked_until: number | null;
      };
      expect(attemptsCount).toBe(3);
      expect(rowAfter3.status).toBe('DELIVERED');
      expect(rowAfter3.attempts).toBe(3);
      expect(rowAfter3.last_http_status).toBe(200);
      expect(rowAfter3.locked_until).toBeNull();
    } finally {
      await flakeApp.close();
    }
  });
});
