import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { type FastifyInstance } from 'fastify';
import { createDatabase } from '../../src/storage/db.js';
import { VirtualClock } from '../../src/core/clock.js';
import { createSimulatorServer } from '../../src/api/server.js';
import { OutboxWorker } from '../../src/delivery/worker.js';
import { createMerchantServer } from '../../merchant-demo/server.js';
import {
  getPaymentById,
  getOutboxItemsByPaymentId,
  getEventsByPaymentId,
  insertWebhookSubscription
} from '../../src/storage/repositories.js';

describe('Week 3: Chaos Rule Engine & Dual-Channel Scenarios (Scenarios 2 & 3)', () => {
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

  let token: string;

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
      pollIntervalMs: 25,
      leaseDurationMs: 30000,
      maxAttempts: 5
    });
    worker.start();

    const merchant = createMerchantServer();
    merchantApp = merchant.app;
    merchantDb = merchant.db;
    setPaysimConfig = merchant.setPaysimConfig;
    merchantBaseUrl = await merchantApp.listen({ port: 0, host: '127.0.0.1' });

    // Grant id_token
    const grantRes = await fetch(`${simBaseUrl}/tokenized/checkout/token/grant`, {
      method: 'POST'
    });
    const grantData = (await grantRes.json()) as { id_token: string };
    token = grantData.id_token;
    setPaysimConfig(simBaseUrl, token);
  });

  afterAll(async () => {
    worker.stop();
    await simApp.close();
    await merchantApp.close();
    simDb.close();
    merchantDb.close();
  });

  beforeEach(async () => {
    // Clear chaos rules before each test
    await fetch(`${simBaseUrl}/_paysim/chaos/rules`, { method: 'DELETE' });
    simDb.prepare('DELETE FROM webhook_subscriptions').run();
  });

  describe('Day 13: Chaos Rule Engine API & Outbox Mutations', () => {
    it('supports registering, retrieving, and deleting chaos rules', async () => {
      const rule = {
        id: 'test-rule-delay',
        match: { payerReferencePrefix: 'CHAOS_DELAY_' },
        action: 'delay',
        params: { delayMs: 5000 },
        seed: 42
      };

      const postRes = await fetch(`${simBaseUrl}/_paysim/chaos/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rule)
      });
      expect(postRes.status).toBe(200);

      const listRes = await fetch(`${simBaseUrl}/_paysim/chaos/rules`);
      const { rules } = (await listRes.json()) as { rules: Array<{ id: string; action: string }> };
      expect(rules).toHaveLength(1);
      expect(rules[0]?.id).toBe('test-rule-delay');
      expect(rules[0]?.action).toBe('delay');

      const delRes = await fetch(`${simBaseUrl}/_paysim/chaos/rules`, { method: 'DELETE' });
      expect(delRes.status).toBe(200);

      const emptyRes = await fetch(`${simBaseUrl}/_paysim/chaos/rules`);
      const emptyData = (await emptyRes.json()) as { rules: unknown[] };
      expect(emptyData.rules).toHaveLength(0);
    });

    it('applies outbox delay hook deterministically without sleeping', async () => {
      await fetch(`${simBaseUrl}/_paysim/chaos/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'rule-delay',
          match: { payerReferencePrefix: 'CHAOS_DELAY_' },
          action: 'delay',
          params: { delayMs: 15000 },
          seed: 123
        })
      });

      const orderId = 'ORD_DELAY_TEST';
      await fetch(`${merchantBaseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, customerId: 'CUST_DELAY', initialBalancePaisa: 0 })
      });

      const createRes = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          amount: '250.00',
          merchantInvoiceNumber: orderId,
          payerReference: 'CHAOS_DELAY_REF',
          callbackURL: `${merchantBaseUrl}/bkash/callback`
        })
      });
      const { paymentID } = (await createRes.json()) as { paymentID: string };

      // Transition to APPROVED
      await fetch(`${simBaseUrl}/_paysim/checkout/${paymentID}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve' })
      });

      const executeTime = clock.nowMs();
      const execRes = await fetch(`${simBaseUrl}/tokenized/checkout/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ paymentID })
      });
      expect(execRes.status).toBe(200);

      const outbox = getOutboxItemsByPaymentId(simDb, paymentID);
      expect(outbox).toHaveLength(1);
      // next_attempt_at must be mutated to executeTime + 15000 ms
      expect(outbox[0]?.next_attempt_at).toBe(executeTime + 15000);
      expect(outbox[0]?.status).toBe('PENDING');
    });

    it('corrupts signature deterministically with mode: invalid-base64', async () => {
      await fetch(`${simBaseUrl}/_paysim/chaos/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'rule-corrupt-sig',
          match: { payerReferencePrefix: 'CHAOS_CORRUPT_' },
          action: 'corrupt-signature',
          params: { mode: 'invalid-base64' }
        })
      });

      const orderId = 'ORD_CORRUPT_TEST';
      await fetch(`${merchantBaseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, customerId: 'CUST_CORRUPT', initialBalancePaisa: 0 })
      });

      const createRes = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          amount: '300.00',
          merchantInvoiceNumber: orderId,
          payerReference: 'CHAOS_CORRUPT_SIG',
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
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ paymentID })
      });

      const outbox = getOutboxItemsByPaymentId(simDb, paymentID);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.signature).toContain('INVALID_SIGNATURE_BASE64_CORRUPTED');
    });
  });

  describe('Day 15: Scenario 2 — Dual-Channel Race (IPN Arrives Before /execute Returns)', () => {
    it('causes double credit on Naive Merchant under ipn-before-execute', async () => {
      // 1. Configure gateway post-commit hook: ipn-before-execute
      await fetch(`${simBaseUrl}/_paysim/chaos/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'rule-race-naive',
          match: { payerReferencePrefix: 'CHAOS_RACE_' },
          action: 'ipn-before-execute',
          params: { maxWaitMs: 2000 }
        })
      });

      // 2. Set active webhook subscription targeting naive IPN endpoint
      insertWebhookSubscription(simDb, {
        target_url: `${merchantBaseUrl}/ipn/naive`,
        status: 'ACTIVE',
        token: 'token-race-naive',
        topic_arn: 'arn:aws:sns:ap-southeast-1:000000000000:bkash-ipn',
        confirmed_at: clock.nowMs()
      });

      const orderId = 'ORD_RACE_NAIVE_1';
      await fetch(`${merchantBaseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, customerId: 'CUST_RACE_1', initialBalancePaisa: 0 })
      });

      // 3. Initiate payment with auto-approve pointing to naive callback handler
      const createRes = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'x-paysim-auto-approve': 'success'
        },
        body: JSON.stringify({
          amount: '500.00',
          merchantInvoiceNumber: orderId,
          payerReference: 'CHAOS_RACE_NAIVE_REF',
          callbackURL: `${merchantBaseUrl}/bkash/callback/naive?orderId=${orderId}`
        })
      });
      const { paymentID } = (await createRes.json()) as { paymentID: string };

      // 4. Wait for auto-approve -> GET /bkash/callback/naive -> POST /execute -> worker delivers IPN -> /execute returns
      await new Promise((resolve) => setTimeout(resolve, 350));

      // 5. Verify IPN was delivered successfully
      const outbox = getOutboxItemsByPaymentId(simDb, paymentID);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.status).toBe('DELIVERED');
      expect(outbox[0]?.last_http_status).toBe(200);

      // 6. Verify Naive Merchant received double-credit: 500 BDT from IPN + 500 BDT from /execute = 1000 BDT (100,000 paisa)
      const orderRes = await fetch(`${merchantBaseUrl}/orders/${orderId}`);
      const orderData = (await orderRes.json()) as { balance_paisa: number; status: string };
      expect(orderData.status).toBe('COMPLETED');
      expect(orderData.balance_paisa).toBe(100000); // 1000.00 BDT -> Double Credit Proof!
    });

    it('credits exactly once on Hardened Merchant under ipn-before-execute', async () => {
      // 1. Configure gateway post-commit hook: ipn-before-execute
      await fetch(`${simBaseUrl}/_paysim/chaos/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'rule-race-hardened',
          match: { payerReferencePrefix: 'CHAOS_RACE_' },
          action: 'ipn-before-execute',
          params: { maxWaitMs: 2000 }
        })
      });

      // 2. Set active webhook subscription targeting hardened IPN endpoint
      insertWebhookSubscription(simDb, {
        target_url: `${merchantBaseUrl}/ipn/hardened`,
        status: 'ACTIVE',
        token: 'token-race-hardened',
        topic_arn: 'arn:aws:sns:ap-southeast-1:000000000000:bkash-ipn',
        confirmed_at: clock.nowMs()
      });

      const orderId = 'ORD_RACE_HARDENED_1';
      await fetch(`${merchantBaseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, customerId: 'CUST_RACE_2', initialBalancePaisa: 0 })
      });

      // 3. Initiate payment with auto-approve pointing to hardened callback handler
      const createRes = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'x-paysim-auto-approve': 'success'
        },
        body: JSON.stringify({
          amount: '500.00',
          merchantInvoiceNumber: orderId,
          payerReference: 'CHAOS_RACE_HARDENED_REF',
          callbackURL: `${merchantBaseUrl}/bkash/callback/hardened?orderId=${orderId}`
        })
      });
      const { paymentID } = (await createRes.json()) as { paymentID: string };

      // 4. Wait for full race execution
      await new Promise((resolve) => setTimeout(resolve, 350));

      // 5. Verify IPN was delivered
      const outbox = getOutboxItemsByPaymentId(simDb, paymentID);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.status).toBe('DELIVERED');

      // 6. Verify Hardened Merchant credited exactly once (50,000 paisa = 500.00 BDT)
      const orderRes = await fetch(`${merchantBaseUrl}/orders/${orderId}`);
      const orderData = (await orderRes.json()) as { balance_paisa: number; status: string };
      expect(orderData.status).toBe('COMPLETED');
      expect(orderData.balance_paisa).toBe(50000); // 500.00 BDT -> Exactly once!
    });
  });

  describe('Day 14: Scenario 3 — /execute Timeout After Commit & /payment/status Recovery', () => {
    it('leaves customer debited with FAILED order on Naive Merchant when /execute times out', async () => {
      // 1. Configure timeout-after-commit chaos rule (holds for 250ms, client times out at 100ms)
      await fetch(`${simBaseUrl}/_paysim/chaos/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'rule-timeout-naive',
          match: { payerReferencePrefix: 'CHAOS_TIMEOUT_' },
          action: 'timeout-after-commit',
          params: { holdMs: 250 }
        })
      });

      // No active IPN webhook subscriptions so recovery relies strictly on synchronous flow
      simDb.prepare('DELETE FROM webhook_subscriptions').run();

      const orderId = 'ORD_TIMEOUT_NAIVE_1';
      await fetch(`${merchantBaseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, customerId: 'CUST_TO_1', initialBalancePaisa: 0 })
      });

      // 2. Initiate payment pointing to naive callback handler
      const createRes = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'x-paysim-auto-approve': 'success'
        },
        body: JSON.stringify({
          amount: '500.00',
          merchantInvoiceNumber: orderId,
          payerReference: 'CHAOS_TIMEOUT_NAIVE_REF',
          callbackURL: `${merchantBaseUrl}/bkash/callback/naive?orderId=${orderId}`
        })
      });
      const { paymentID } = (await createRes.json()) as { paymentID: string };

      // 3. Wait for callback timeout to trigger and complete
      await new Promise((resolve) => setTimeout(resolve, 400));

      // 4. Verify bKash state: payment is actually COMPLETED in bKash!
      const paymentInSim = getPaymentById(simDb, paymentID);
      expect(paymentInSim?.status).toBe('COMPLETED');
      expect(paymentInSim?.trx_id).toBeDefined();

      // 5. Verify events logged EXECUTE_TIMEOUT_AFTER_COMMIT
      const events = getEventsByPaymentId(simDb, paymentID);
      const timeoutEvent = events.find((e) => e.kind === 'EXECUTE_TIMEOUT_AFTER_COMMIT');
      expect(timeoutEvent).toBeDefined();

      // 6. Verify Naive Merchant marked order as FAILED and balance is 0 BDT!
      const orderRes = await fetch(`${merchantBaseUrl}/orders/${orderId}`);
      const orderData = (await orderRes.json()) as { balance_paisa: number; status: string };
      expect(orderData.status).toBe('FAILED');
      expect(orderData.balance_paisa).toBe(0); // Customer was debited in bKash, but order failed on merchant!
    });

    it('recovers trxID via /payment/status and credits wallet on Hardened Merchant when /execute times out', async () => {
      // 1. Configure timeout-after-commit chaos rule
      await fetch(`${simBaseUrl}/_paysim/chaos/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'rule-timeout-hardened',
          match: { payerReferencePrefix: 'CHAOS_TIMEOUT_' },
          action: 'timeout-after-commit',
          params: { holdMs: 250 }
        })
      });

      // No active IPN webhook subscriptions
      simDb.prepare('DELETE FROM webhook_subscriptions').run();

      const orderId = 'ORD_TIMEOUT_HARDENED_1';
      await fetch(`${merchantBaseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, customerId: 'CUST_TO_2', initialBalancePaisa: 0 })
      });

      // 2. Initiate payment pointing to hardened callback handler
      const createRes = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'x-paysim-auto-approve': 'success'
        },
        body: JSON.stringify({
          amount: '500.00',
          merchantInvoiceNumber: orderId,
          payerReference: 'CHAOS_TIMEOUT_HARDENED_REF',
          callbackURL: `${merchantBaseUrl}/bkash/callback/hardened?orderId=${orderId}`
        })
      });
      const { paymentID } = (await createRes.json()) as { paymentID: string };

      // 3. Wait for execute timeout and fallback query to complete
      await new Promise((resolve) => setTimeout(resolve, 500));

      // 4. Verify bKash state
      const paymentInSim = getPaymentById(simDb, paymentID);
      expect(paymentInSim?.status).toBe('COMPLETED');
      expect(paymentInSim?.trx_id).toBeDefined();

      // 5. Verify events logged EXECUTE_TIMEOUT_AFTER_COMMIT
      const events = getEventsByPaymentId(simDb, paymentID);
      const timeoutEvent = events.find((e) => e.kind === 'EXECUTE_TIMEOUT_AFTER_COMMIT');
      expect(timeoutEvent).toBeDefined();

      // 6. Verify Hardened Merchant recovered and credited order to COMPLETED with 50,000 paisa (500.00 BDT)
      const orderRes = await fetch(`${merchantBaseUrl}/orders/${orderId}`);
      const orderData = (await orderRes.json()) as { balance_paisa: number; status: string };
      expect(orderData.status).toBe('COMPLETED');
      expect(orderData.balance_paisa).toBe(50000); // Successfully recovered via /payment/status!
    });
  });
});
