import { describe, it, expect } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { createDatabase } from '../../src/storage/db.js';
import { VirtualClock } from '../../src/core/clock.js';
import { createSimulatorServer } from '../../src/api/server.js';
import { OutboxWorker } from '../../src/delivery/worker.js';
import {
  insertPayment,
  getPaymentById,
  atomicExecutePaymentWithOutbox,
  getOutboxItemsByPaymentId,
  getEventsByPaymentId,
  insertWebhookSubscription,
  insertChaosRule,
  type ChaosRuleRecord
} from '../../src/storage/repositories.js';
import {
  hashToSeed,
  mulberry32,
  applyOutboxChaosHooks
} from '../../src/chaos/engine.js';

// Helper to get an unused ephemeral TCP port
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

describe('Week 4 Resilience & Failure Edge Cases (Day 20)', () => {
  // --------------------------------------------------------------------------
  // 1. Retry Exhaustion (DEAD Status)
  // --------------------------------------------------------------------------
  describe('1. Retry Exhaustion to DEAD Status', () => {
    it('exhausts 5 retry attempts on continuous HTTP 500 and marks outbox row as DEAD', async () => {
      let receiverCalls = 0;
      const mock500Receiver = fastify();
      mock500Receiver.post('/webhook', async (req, reply) => {
        receiverCalls++;
        reply.status(500).send({ error: 'Internal Server Error' });
      });

      const receiverBaseUrl = await mock500Receiver.listen({ port: 0, host: '127.0.0.1' });
      const webhookUrl = `${receiverBaseUrl}/webhook`;

      const db = createDatabase(':memory:');
      const startTime = 1700000000000;
      const clock = new VirtualClock(startTime);

      insertWebhookSubscription(db, {
        target_url: webhookUrl,
        status: 'ACTIVE',
        token: 'sub-token-dead-test',
        topic_arn: 'arn:aws:sns:ap-southeast-1:000000000000:bkash-ipn',
        confirmed_at: clock.nowMs()
      });

      const paymentId = 'PAY_EXHAUST_001';
      insertPayment(db, {
        payment_id: paymentId,
        invoice: 'INV-EXHAUST-001',
        amount_paisa: 50000,
        currency: 'BDT',
        mode: '0011',
        payer_reference: 'REF_DEAD',
        customer_msisdn: '01770618575',
        intent: 'sale',
        callback_url: webhookUrl,
        status: 'APPROVED',
        created_at: clock.nowMs(),
        updated_at: clock.nowMs()
      });

      atomicExecutePaymentWithOutbox(db, {
        paymentId,
        expectedStatus: 'APPROVED',
        newStatus: 'COMPLETED',
        trxId: 'TRX_DEAD_001',
        updatedAt: clock.nowMs(),
        outbox: {
          sns_message_id: 'msg-dead-001',
          sns_type: 'Notification',
          payload: JSON.stringify({ trxID: 'TRX_DEAD_001', status: 'Completed' }),
          signature: 'sig-exhaust',
          next_attempt_at: clock.nowMs()
        }
      });

      const worker = new OutboxWorker({
        db,
        clock,
        maxAttempts: 5,
        leaseDurationMs: 30000,
        pollIntervalMs: 0
      });

      // Attempt 1 (initial delivery attempt at t=0)
      let processed = await worker.processDueRows();
      expect(processed).toBe(1);
      expect(receiverCalls).toBe(1);

      let items = getOutboxItemsByPaymentId(db, paymentId);
      expect(items[0]?.status).toBe('RETRY');
      expect(items[0]?.attempts).toBe(1);
      expect(items[0]?.last_http_status).toBe(500);
      expect(items[0]?.next_attempt_at).toBe(startTime + 1000); // 1000 * 2^0 = 1s

      // Attempt 2 (advance clock by 1s)
      clock.advanceMs(1000);
      processed = await worker.processDueRows();
      expect(processed).toBe(1);
      expect(receiverCalls).toBe(2);

      items = getOutboxItemsByPaymentId(db, paymentId);
      expect(items[0]?.status).toBe('RETRY');
      expect(items[0]?.attempts).toBe(2);
      expect(items[0]?.last_http_status).toBe(500);
      expect(items[0]?.next_attempt_at).toBe(startTime + 1000 + 2000); // 1000 * 2^1 = 2s

      // Attempt 3 (advance clock by 2s)
      clock.advanceMs(2000);
      processed = await worker.processDueRows();
      expect(processed).toBe(1);
      expect(receiverCalls).toBe(3);

      items = getOutboxItemsByPaymentId(db, paymentId);
      expect(items[0]?.status).toBe('RETRY');
      expect(items[0]?.attempts).toBe(3);
      expect(items[0]?.last_http_status).toBe(500);
      expect(items[0]?.next_attempt_at).toBe(startTime + 3000 + 4000); // 1000 * 2^2 = 4s

      // Attempt 4 (advance clock by 4s)
      clock.advanceMs(4000);
      processed = await worker.processDueRows();
      expect(processed).toBe(1);
      expect(receiverCalls).toBe(4);

      items = getOutboxItemsByPaymentId(db, paymentId);
      expect(items[0]?.status).toBe('RETRY');
      expect(items[0]?.attempts).toBe(4);
      expect(items[0]?.last_http_status).toBe(500);
      expect(items[0]?.next_attempt_at).toBe(startTime + 7000 + 8000); // 1000 * 2^3 = 8s

      // Attempt 5 (advance clock by 8s - this is attempt 5 of 5)
      clock.advanceMs(8000);
      processed = await worker.processDueRows();
      expect(processed).toBe(1);
      expect(receiverCalls).toBe(5);

      items = getOutboxItemsByPaymentId(db, paymentId);
      // Status MUST transition to DEAD on attempt 5
      expect(items[0]?.status).toBe('DEAD');
      expect(items[0]?.attempts).toBe(5);
      expect(items[0]?.last_http_status).toBe(500);
      expect(items[0]?.last_error).toContain('HTTP 500');

      // Subsequent ticks MUST NOT claim or retry the DEAD row
      clock.advanceMs(100000);
      const deadProcessed = await worker.processDueRows();
      expect(deadProcessed).toBe(0);
      expect(receiverCalls).toBe(5); // No new network calls

      const finalItems = getOutboxItemsByPaymentId(db, paymentId);
      expect(finalItems[0]?.status).toBe('DEAD');
      expect(finalItems[0]?.attempts).toBe(5);

      await mock500Receiver.close();
      db.close();
    });
  });

  // --------------------------------------------------------------------------
  // 2. Server & SQLite Restart Persistence
  // --------------------------------------------------------------------------
  describe('2. Server & SQLite Restart Persistence', () => {
    it('survives complete server shutdown and delivers pending IPN upon reboot against the same SQLite file', async () => {
      const tempDbPath = path.join(
        os.tmpdir(),
        `paysim-restart-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
      );

      const receiverPort = await getFreePort();
      const webhookUrl = `http://127.0.0.1:${receiverPort}/webhook`;

      // PHASE 1: Boot Instance 1 with receiver OFFLINE
      const db1 = createDatabase(tempDbPath);
      const clock = new VirtualClock(1700000000000);

      insertWebhookSubscription(db1, {
        target_url: webhookUrl,
        status: 'ACTIVE',
        token: 'sub-token-restart-test',
        topic_arn: 'arn:aws:sns:ap-southeast-1:000000000000:bkash-ipn',
        confirmed_at: clock.nowMs()
      });

      const simApp1 = createSimulatorServer({ db: db1, clock });
      const simBaseUrl1 = await simApp1.listen({ port: 0, host: '127.0.0.1' });

      // Grant token
      const grantRes = await fetch(`${simBaseUrl1}/tokenized/checkout/token/grant`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          username: 'test-user',
          password: 'test-password'
        },
        body: JSON.stringify({ app_key: 'test-app-key', app_secret: 'test-app-secret' })
      });
      const grantBody = (await grantRes.json()) as { id_token: string };
      const idToken = grantBody.id_token;

      // Create payment
      const createRes = await fetch(`${simBaseUrl1}/tokenized/checkout/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
          'X-APP-Key': 'test-app-key'
        },
        body: JSON.stringify({
          mode: '0011',
          payerReference: 'PERSIST_REF_123',
          callbackURL: webhookUrl,
          amount: '150.00',
          currency: 'BDT',
          intent: 'sale',
          merchantInvoiceNumber: 'INV-PERSIST-1'
        })
      });
      const createBody = (await createRes.json()) as { paymentID: string };
      const paymentId = createBody.paymentID;

      // Approve payment
      await fetch(`${simBaseUrl1}/_paysim/checkout/${paymentId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve' })
      });

      // Execute payment
      const execRes = await fetch(`${simBaseUrl1}/tokenized/checkout/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
          'X-APP-Key': 'test-app-key'
        },
        body: JSON.stringify({ paymentID: paymentId })
      });
      const execBody = (await execRes.json()) as { statusCode: string };
      expect(execBody.statusCode).toBe('0000');

      // Attempt dispatch while receiver is offline -> fails with ECONNREFUSED
      const worker1 = new OutboxWorker({ db: db1, clock, leaseDurationMs: 30000, pollIntervalMs: 0 });
      const attempt1Count = await worker1.processDueRows();
      expect(attempt1Count).toBe(1);

      const pendingRow = getOutboxItemsByPaymentId(db1, paymentId)[0];
      expect(pendingRow).toBeDefined();
      expect(pendingRow?.status).toBe('RETRY');
      expect(pendingRow?.attempts).toBe(1);

      // COMPLETE SHUTDOWN OF INSTANCE 1
      worker1.stop();
      await simApp1.close();
      db1.close();

      expect(fs.existsSync(tempDbPath)).toBe(true);

      // PHASE 2: Start webhook receiver ONLINE on receiverPort
      const receivedDeliveries: any[] = [];
      const receiverApp = fastify();
      receiverApp.post('/webhook', async (req, reply) => {
        receivedDeliveries.push(req.body);
        reply.status(200).send({ received: true });
      });
      await receiverApp.listen({ port: receiverPort, host: '127.0.0.1' });

      // PHASE 3: Boot Instance 2 against the SAME SQLite file
      const db2 = createDatabase(tempDbPath);
      const persistedPayment = getPaymentById(db2, paymentId);
      expect(persistedPayment).toBeDefined();
      expect(persistedPayment?.status).toBe('COMPLETED');

      const persistedOutbox = getOutboxItemsByPaymentId(db2, paymentId);
      expect(persistedOutbox.length).toBe(1);
      expect(persistedOutbox[0]?.status).toBe('RETRY');

      const simApp2 = createSimulatorServer({ db: db2, clock });
      await simApp2.listen({ port: 0, host: '127.0.0.1' });

      // Advance clock past retry backoff window (1s backoff after attempt 1)
      clock.advanceMs(2000);

      const worker2 = new OutboxWorker({ db: db2, clock, leaseDurationMs: 30000, pollIntervalMs: 0 });
      const attempt2Count = await worker2.processDueRows();
      expect(attempt2Count).toBe(1);

      // Verify row reached DELIVERED status in the database
      const deliveredRow = getOutboxItemsByPaymentId(db2, paymentId)[0];
      expect(deliveredRow?.status).toBe('DELIVERED');
      expect(deliveredRow?.attempts).toBe(2);
      expect(deliveredRow?.last_http_status).toBe(200);

      // Verify receiver received the message
      expect(receivedDeliveries.length).toBe(1);
      const rawPayload = typeof receivedDeliveries[0] === 'string'
        ? JSON.parse(receivedDeliveries[0])
        : receivedDeliveries[0];
      expect(rawPayload.Type).toBe('Notification');

      // Cleanup
      worker2.stop();
      await simApp2.close();
      db2.close();
      await receiverApp.close();

      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
      if (fs.existsSync(`${tempDbPath}-wal`)) fs.unlinkSync(`${tempDbPath}-wal`);
      if (fs.existsSync(`${tempDbPath}-shm`)) fs.unlinkSync(`${tempDbPath}-shm`);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Payment Session Expiry (EXPIRED State)
  // --------------------------------------------------------------------------
  describe('3. Payment Session Expiry (EXPIRED State)', () => {
    it('rejects /execute on EXPIRED payment with non-0000 statusCode, records UAT violation, and enqueues zero IPNs', async () => {
      const db = createDatabase(':memory:');
      const clock = new VirtualClock(1700000000000);
      const simApp = createSimulatorServer({ db, clock });
      const simBaseUrl = await simApp.listen({ port: 0, host: '127.0.0.1' });

      // Grant token
      const grantRes = await fetch(`${simBaseUrl}/tokenized/checkout/token/grant`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          username: 'test-user',
          password: 'test-password'
        },
        body: JSON.stringify({ app_key: 'test-app-key', app_secret: 'test-app-secret' })
      });
      const { id_token: idToken } = (await grantRes.json()) as { id_token: string };

      // Create payment
      const createRes = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
          'X-APP-Key': 'test-app-key'
        },
        body: JSON.stringify({
          mode: '0011',
          payerReference: 'EXPIRY_REF_001',
          callbackURL: 'https://merchant.example.com/callback',
          amount: '200.00',
          currency: 'BDT',
          intent: 'sale',
          merchantInvoiceNumber: 'INV-EXP-1'
        })
      });
      const { paymentID } = (await createRes.json()) as { paymentID: string };

      const initialPayment = getPaymentById(db, paymentID);
      expect(initialPayment?.status).toBe('INITIATED');

      // Transition to EXPIRED via simulator action endpoint
      const expireActionRes = await fetch(`${simBaseUrl}/_paysim/checkout/${paymentID}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'expire' })
      });
      expect(expireActionRes.status).toBe(200);
      const expireActionBody = (await expireActionRes.json()) as { statusCode: string; action: string; paymentID: string };
      expect(expireActionBody.action).toBe('expire');
      expect(expireActionBody.paymentID).toBe(paymentID);

      const expiredPayment = getPaymentById(db, paymentID);
      expect(expiredPayment?.status).toBe('EXPIRED');

      // Attempt /execute on EXPIRED payment
      const execRes = await fetch(`${simBaseUrl}/tokenized/checkout/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
          'X-APP-Key': 'test-app-key'
        },
        body: JSON.stringify({ paymentID })
      });

      // bKash HTTP-200 Error Envelope Invariant: HTTP 200 with non-0000 statusCode
      expect(execRes.status).toBe(200);
      const execBody = (await execRes.json()) as { statusCode: string; statusMessage: string };
      expect(execBody.statusCode).not.toBe('0000');
      expect(execBody.statusCode).toBe('2029');
      expect(execBody.statusMessage).toContain('EXPIRED');

      // Zero IPN outbox rows should exist for this payment
      const outboxItems = getOutboxItemsByPaymentId(db, paymentID);
      expect(outboxItems.length).toBe(0);

      // Verify UAT Rule 2 violation is recorded in events
      const events = getEventsByPaymentId(db, paymentID);
      const uatViolation = events.find(
        (e) => e.kind === 'UAT_RULE_2_EXECUTE_WITHOUT_SUCCESS_CALLBACK'
      );
      expect(uatViolation).toBeDefined();

      await simApp.close();
      db.close();
    });
  });

  // --------------------------------------------------------------------------
  // 4. Flakiness & Determinism Check
  // --------------------------------------------------------------------------
  describe('4. Flakiness & Determinism Check', () => {
    it('produces 100% bit-for-bit identical PRNG sequences when initialized with identical seeds', () => {
      const seedA = hashToSeed(42, 'PAY_SEEDED_DETERMINISTIC');
      const seedB = hashToSeed(42, 'PAY_SEEDED_DETERMINISTIC');
      expect(seedA).toBe(seedB);

      const prngA = mulberry32(seedA);
      const prngB = mulberry32(seedB);

      const seqA: number[] = [];
      const seqB: number[] = [];

      for (let i = 0; i < 100; i++) {
        seqA.push(prngA());
        seqB.push(prngB());
      }

      expect(seqA).toEqual(seqB);
    });

    it('produces identical outbox items across repeated runs with identical chaos rule seed', () => {
      const rule: ChaosRuleRecord = {
        id: 'rule-det-duplicate',
        match_json: JSON.stringify({ payerReferencePrefix: 'CHAOS_DET_' }),
        action: 'duplicate',
        params_json: JSON.stringify({ count: 3, intervalMs: 250, sameMessageId: true }),
        seed: 777
      };

      const context = {
        paymentId: 'PAY_DET_CHAOS_1',
        payerReference: 'CHAOS_DET_ORDER_1',
        customerMsisdn: '01770618575'
      };

      const baseItem = {
        sns_message_id: 'msg-seed-12345',
        sns_type: 'Notification',
        payload: JSON.stringify({ amount: '500.00', trxID: 'TRXDET1' }),
        signature: 'valid-sig-12345',
        next_attempt_at: 1700000000000
      };

      const runA = applyOutboxChaosHooks([rule], context, baseItem, 1700000000000);
      const runB = applyOutboxChaosHooks([rule], context, baseItem, 1700000000000);

      expect(runA.outboxItems.length).toBe(3);
      expect(runB.outboxItems.length).toBe(3);
      expect(runA.outboxItems).toEqual(runB.outboxItems);
    });

    it('generates completely identical payment execution state across two isolated databases with seeded rules', () => {
      const seed = 99999;
      const dbA = createDatabase(':memory:');
      const dbB = createDatabase(':memory:');
      const now = 1700000000000;

      const rule: ChaosRuleRecord = {
        id: 'rule-e2e-det',
        match_json: JSON.stringify({ payerReferencePrefix: 'CHAOS_E2E_' }),
        action: 'duplicate',
        params_json: JSON.stringify({ count: 2, intervalMs: 500, sameMessageId: true }),
        seed
      };

      insertChaosRule(dbA, rule);
      insertChaosRule(dbB, rule);

      const paymentA = {
        payment_id: 'PAY_E2E_001',
        invoice: 'INV-E2E-001',
        amount_paisa: 10000,
        currency: 'BDT',
        mode: '0011',
        payer_reference: 'CHAOS_E2E_REF',
        customer_msisdn: '01770618575',
        intent: 'sale',
        callback_url: 'https://merchant.example.com/webhook',
        status: 'APPROVED' as const,
        created_at: now,
        updated_at: now
      };

      insertPayment(dbA, paymentA);
      insertPayment(dbB, paymentA);

      const baseItem = {
        sns_message_id: 'msg-e2e-det',
        sns_type: 'Notification',
        payload: JSON.stringify({ trxID: 'TRXE2E', amount: '100.00' }),
        signature: 'sig-e2e',
        next_attempt_at: now
      };

      const outboxA = applyOutboxChaosHooks([rule], { paymentId: 'PAY_E2E_001', payerReference: 'CHAOS_E2E_REF' }, baseItem, now);
      const outboxB = applyOutboxChaosHooks([rule], { paymentId: 'PAY_E2E_001', payerReference: 'CHAOS_E2E_REF' }, baseItem, now);

      atomicExecutePaymentWithOutbox(dbA, {
        paymentId: 'PAY_E2E_001',
        expectedStatus: 'APPROVED',
        newStatus: 'COMPLETED',
        trxId: 'TRXE2E',
        updatedAt: now,
        outbox: outboxA.outboxItems
      });

      atomicExecutePaymentWithOutbox(dbB, {
        paymentId: 'PAY_E2E_001',
        expectedStatus: 'APPROVED',
        newStatus: 'COMPLETED',
        trxId: 'TRXE2E',
        updatedAt: now,
        outbox: outboxB.outboxItems
      });

      const rowsA = getOutboxItemsByPaymentId(dbA, 'PAY_E2E_001');
      const rowsB = getOutboxItemsByPaymentId(dbB, 'PAY_E2E_001');

      expect(rowsA.length).toBe(rowsB.length);
      expect(rowsA).toEqual(rowsB);

      dbA.close();
      dbB.close();
    });
  });
});
