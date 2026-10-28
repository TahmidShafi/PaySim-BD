import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { type FastifyInstance } from 'fastify';
import { createDatabase } from '../../src/storage/db.js';
import { VirtualClock } from '../../src/core/clock.js';
import { createSimulatorServer } from '../../src/api/server.js';
import { OutboxWorker } from '../../src/delivery/worker.js';
import { createMerchantServer } from '../../merchant-demo/server.js';
import {
  insertWebhookSubscription,
  getEventsByPaymentId
} from '../../src/storage/repositories.js';

describe('v1.1.0 Integration Suite: Live Inspector, Real-Time SSE & Webhook Replay', () => {
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

  let idToken: string;
  let refreshToken: string;

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
      pollIntervalMs: 20,
      leaseDurationMs: 30000,
      maxAttempts: 5
    });
    worker.start();

    const merchant = createMerchantServer();
    merchantApp = merchant.app;
    merchantDb = merchant.db;
    setPaysimConfig = merchant.setPaysimConfig;
    merchantBaseUrl = await merchantApp.listen({ port: 0, host: '127.0.0.1' });

    // Initial token grant
    const grantRes = await fetch(`${simBaseUrl}/tokenized/checkout/token/grant`, {
      method: 'POST'
    });
    const grantData = (await grantRes.json()) as { id_token: string; refresh_token: string };
    idToken = grantData.id_token;
    refreshToken = grantData.refresh_token;

    setPaysimConfig(simBaseUrl, idToken, refreshToken);

    // Register merchant webhook endpoint
    insertWebhookSubscription(simDb, {
      target_url: `${merchantBaseUrl}/ipn/idempotent`,
      status: 'ACTIVE',
      token: 'tok_active_test',
      topic_arn: 'arn:aws:sns:ap-southeast-1:000000000000:bkash-ipn',
      confirmed_at: clock.nowMs()
    });
  });

  afterAll(async () => {
    worker.stop();
    await simApp.close();
    await merchantApp.close();
    simDb.close();
    merchantDb.close();
  });

  it('Test 1: GET /_paysim/inspector and GET /_paysim/state snapshot integrity', async () => {
    // 1. Verify HTML Inspector endpoint
    const htmlRes = await fetch(`${simBaseUrl}/_paysim/inspector`);
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get('content-type')).toContain('text/html');
    const htmlText = await htmlRes.text();
    expect(htmlText).toContain('PaySim-BD Live Inspector');
    expect(htmlText).toContain('/_paysim/events/stream');
    expect(htmlText).toContain('Replay IPN');
    expect(htmlText).toContain('UAT Compliance Audit');

    // 2. Trigger redundant grant to deliberately generate a UAT violation
    const violRes = await fetch(`${simBaseUrl}/tokenized/checkout/token/grant`, {
      method: 'POST'
    });
    expect(violRes.status).toBe(200);

    // 3. Create, approve, and execute a payment
    const createRes = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`
      },
      body: JSON.stringify({
        amount: '150.00',
        currency: 'BDT',
        intent: 'sale',
        merchantInvoiceNumber: 'INV-STATE-001',
        callbackURL: `${merchantBaseUrl}/bkash/callback`
      })
    });
    expect(createRes.status).toBe(200);
    const createData = (await createRes.json()) as { paymentID: string };

    await fetch(`${simBaseUrl}/_paysim/checkout/${createData.paymentID}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve' })
    });

    const execRes = await fetch(`${simBaseUrl}/tokenized/checkout/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`
      },
      body: JSON.stringify({ paymentID: createData.paymentID })
    });
    expect(execRes.status).toBe(200);

    // 4. Query GET /_paysim/state
    const stateRes = await fetch(`${simBaseUrl}/_paysim/state`);
    expect(stateRes.status).toBe(200);
    const state = (await stateRes.json()) as {
      summary: {
        total_payments: number;
        completed_payments: number;
        outbox_pending: number;
        outbox_delivered: number;
        total_violations: number;
      };
      payments: Array<{ payment_id: string; status: string }>;
      outbox: Array<{ id: number; payment_id: string }>;
      events: Array<{ id: number; kind: string }>;
      violations: Array<{ rule: string; actionPoint: string }>;
    };

    expect(state.summary.total_payments).toBeGreaterThanOrEqual(1);
    expect(state.summary.completed_payments).toBeGreaterThanOrEqual(1);
    expect(state.summary.total_violations).toBeGreaterThanOrEqual(1);
    expect(state.payments.some((p) => p.payment_id === createData.paymentID)).toBe(true);
    expect(state.outbox.length).toBeGreaterThanOrEqual(1);
    expect(state.events.length).toBeGreaterThanOrEqual(1);
    expect(
      state.violations.some((v) => v.rule === 'UAT_RULE_1_REDUNDANT_TOKEN_GRANT')
    ).toBe(true);
  });

  it('Test 2: GET /_paysim/events/stream delivers real-time SSE telemetry', async () => {
    const controller = new AbortController();
    const sseRes = await fetch(`${simBaseUrl}/_paysim/events/stream`, {
      signal: controller.signal
    });

    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get('content-type')).toContain('text/event-stream');

    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();

    // 1. Initial connection comment
    const firstChunk = await reader.read();
    expect(firstChunk.done).toBe(false);
    const firstText = decoder.decode(firstChunk.value);
    expect(firstText).toContain(': connected');

    // 2. Trigger an action while stream is open
    const createRes = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`
      },
      body: JSON.stringify({
        amount: '80.00',
        currency: 'BDT',
        intent: 'sale',
        merchantInvoiceNumber: 'INV-SSE-002',
        callbackURL: `${merchantBaseUrl}/bkash/callback`
      })
    });
    expect(createRes.status).toBe(200);

    // 3. Read incoming event chunk from SSE stream
    const secondChunk = await reader.read();
    expect(secondChunk.done).toBe(false);
    const secondText = decoder.decode(secondChunk.value);
    expect(secondText).toContain('data:');

    // Extract JSON payload
    const line = secondText
      .split('\n')
      .find((l) => l.startsWith('data:'));
    expect(line).toBeDefined();
    const eventPayload = JSON.parse(line!.replace(/^data:\s*/, '')) as {
      kind: string;
      payment_id?: string;
    };
    expect(eventPayload.kind).toBe('PAYMENT_INITIATED');

    controller.abort();
  });

  it('Test 3: POST /_paysim/outbox/:id/replay enqueues duplicate webhook and delivers to merchant', async () => {
    // 1. Create, approve, and execute payment to generate initial delivered outbox row
    const createRes = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`
      },
      body: JSON.stringify({
        amount: '200.00',
        currency: 'BDT',
        intent: 'sale',
        merchantInvoiceNumber: 'INV-REPLAY-003',
        callbackURL: `${merchantBaseUrl}/bkash/callback`
      })
    });
    const { paymentID } = (await createRes.json()) as { paymentID: string };

    await fetch(`${simBaseUrl}/_paysim/checkout/${paymentID}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve' })
    });

    await fetch(`${simBaseUrl}/tokenized/checkout/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`
      },
      body: JSON.stringify({ paymentID })
    });

    // Wait briefly for initial delivery
    await new Promise((r) => setTimeout(r, 80));

    // Find original delivered outbox row
    const origOutbox = simDb
      .prepare('SELECT * FROM ipn_outbox WHERE payment_id = ? AND status = ? LIMIT 1')
      .get(paymentID, 'DELIVERED') as {
      id: number;
      payment_id: string;
      sns_message_id: string;
      payload: string;
      signature: string;
    };
    expect(origOutbox).toBeDefined();

    // 2. Trigger Replay API
    const replayRes = await fetch(`${simBaseUrl}/_paysim/outbox/${origOutbox.id}/replay`, {
      method: 'POST'
    });
    expect(replayRes.status).toBe(200);
    const replayData = (await replayRes.json()) as {
      success: boolean;
      originalId: number;
      newOutboxId: number;
    };

    expect(replayData.success).toBe(true);
    expect(replayData.originalId).toBe(origOutbox.id);
    expect(replayData.newOutboxId).toBeGreaterThan(origOutbox.id);

    // 3. Verify IPN_REPLAY_TRIGGERED event in SQLite
    const replayEvents = getEventsByPaymentId(simDb, paymentID).filter(
      (e) => e.kind === 'IPN_REPLAY_TRIGGERED'
    );
    expect(replayEvents.length).toBeGreaterThanOrEqual(1);

    // 4. Verify cloned row has identical payload, signature, and message ID
    const clonedRow = simDb
      .prepare('SELECT * FROM ipn_outbox WHERE id = ?')
      .get(replayData.newOutboxId) as {
      sns_message_id: string;
      payload: string;
      signature: string;
      status: string;
    };
    expect(clonedRow.sns_message_id).toBe(origOutbox.sns_message_id);
    expect(clonedRow.payload).toBe(origOutbox.payload);
    expect(clonedRow.signature).toBe(origOutbox.signature);

    // 5. Wait for worker to deliver cloned outbox item
    await new Promise((r) => setTimeout(r, 80));
    const reDelivered = simDb
      .prepare('SELECT status FROM ipn_outbox WHERE id = ?')
      .get(replayData.newOutboxId) as { status: string };
    expect(reDelivered.status).toBe('DELIVERED');
  });

  it('Test 4: POST /_paysim/trigger/offline handles USSD (*247#) and QR triggers', async () => {
    // 1. Trigger USSD offline payment (*247#)
    const ussdRes = await fetch(`${simBaseUrl}/_paysim/trigger/offline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'ussd',
        amount: '125.00',
        merchantInvoiceNumber: 'INV-USSD-TEST',
        payerReference: '01711223344'
      })
    });
    expect(ussdRes.status).toBe(200);
    const ussdData = (await ussdRes.json()) as {
      success: boolean;
      channel: string;
      trxID: string;
      paymentId: string;
      outboxId: number;
    };

    expect(ussdData.success).toBe(true);
    expect(ussdData.channel).toBe('ussd');
    expect(ussdData.trxID).toMatch(/^BK/);
    expect(ussdData.paymentId).toMatch(/^OFFLINE-USSD-/);

    // 2. Trigger QR offline merchant payment
    const qrRes = await fetch(`${simBaseUrl}/_paysim/trigger/offline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'qr',
        amount: '340.50',
        merchantInvoiceNumber: 'INV-QR-TEST',
        payerReference: '01899887766'
      })
    });
    expect(qrRes.status).toBe(200);
    const qrData = (await qrRes.json()) as {
      success: boolean;
      channel: string;
      trxID: string;
      paymentId: string;
      outboxId: number;
    };

    expect(qrData.success).toBe(true);
    expect(qrData.channel).toBe('qr');
    expect(qrData.trxID).toMatch(/^BK/);
    expect(qrData.paymentId).toMatch(/^OFFLINE-QR-/);

    // 3. Wait for outbox worker to deliver both offline notifications
    await new Promise((r) => setTimeout(r, 100));

    // Verify USSD outbox record and official transactionType "10002175"
    const ussdOutbox = simDb
      .prepare('SELECT * FROM ipn_outbox WHERE id = ?')
      .get(ussdData.outboxId) as { payload: string; status: string };
    expect(ussdOutbox.status).toBe('DELIVERED');
    const ussdSns = JSON.parse(ussdOutbox.payload) as { Message: string };
    const ussdMsg = JSON.parse(ussdSns.Message) as {
      transactionType: string;
      amount: string;
      debitMSISDN: string;
    };
    expect(ussdMsg.transactionType).toBe('10002175');
    expect(ussdMsg.amount).toBe('125.00');
    expect(ussdMsg.debitMSISDN).toBe('01711223344');

    // Verify QR outbox record and official transactionType "10003126"
    const qrOutbox = simDb
      .prepare('SELECT * FROM ipn_outbox WHERE id = ?')
      .get(qrData.outboxId) as { payload: string; status: string };
    expect(qrOutbox.status).toBe('DELIVERED');
    const qrSns = JSON.parse(qrOutbox.payload) as { Message: string };
    const qrMsg = JSON.parse(qrSns.Message) as {
      transactionType: string;
      amount: string;
      debitMSISDN: string;
    };
    expect(qrMsg.transactionType).toBe('10003126');
    expect(qrMsg.amount).toBe('340.50');
    expect(qrMsg.debitMSISDN).toBe('01899887766');

    // 4. Verify invalid channel rejection
    const invalidRes = await fetch(`${simBaseUrl}/_paysim/trigger/offline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'web', amount: '50.00' })
    });
    expect(invalidRes.status).toBe(400);
  });
});

