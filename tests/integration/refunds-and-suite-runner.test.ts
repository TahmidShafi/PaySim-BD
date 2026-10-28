import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { type FastifyInstance } from 'fastify';
import { createDatabase } from '../../src/storage/db.js';
import { VirtualClock } from '../../src/core/clock.js';
import { createSimulatorServer } from '../../src/api/server.js';
import { OutboxWorker } from '../../src/delivery/worker.js';
import { createMerchantServer } from '../../merchant-demo/server.js';
import {
  getRefundsByPaymentId,
  getTotalRefundedPaisa,
  getEventsByPaymentId
} from '../../src/storage/repositories.js';
import { checkUatViolations } from '../../src/linter/uat-linter.js';

describe('v1.2.0 Integration Suite: Full/Partial Refunds & In-Browser Chaos Suite Runner', () => {
  let simApp: FastifyInstance;
  let simBaseUrl: string;
  let simDb: ReturnType<typeof createDatabase>;
  let clock: VirtualClock;
  let worker: OutboxWorker;
  let workerEvents: EventEmitter;

  let merchantApp: FastifyInstance;
  let merchantBaseUrl: string;
  let merchantDb: ReturnType<typeof createMerchantServer>['db'];

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
    merchantBaseUrl = await merchantApp.listen({ port: 0, host: '127.0.0.1' });

    // Initial token grant
    const grantRes = await fetch(`${simBaseUrl}/tokenized/checkout/token/grant`, {
      method: 'POST'
    });
    const grantData = (await grantRes.json()) as { id_token: string; refresh_token: string };
    idToken = grantData.id_token;
    refreshToken = grantData.refresh_token;

    merchant.setPaysimConfig(simBaseUrl, idToken, refreshToken);
  });

  afterAll(async () => {
    worker.stop();
    await simApp.close();
    await merchantApp.close();
    simDb.close();
    merchantDb.close();
  });

  it('Test 1: Full & Partial Refunds, 1-paisa over-refund rejection (2081), and UAT Action Point #5', async () => {
    // 1. Create, approve, and execute a 1000.00 BDT payment
    const createRes = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`
      },
      body: JSON.stringify({
        amount: '1000.00',
        currency: 'BDT',
        intent: 'sale',
        merchantInvoiceNumber: 'INV-REFUND-001',
        callbackURL: `${merchantBaseUrl}/bkash/callback`
      })
    });
    const { paymentID } = (await createRes.json()) as { paymentID: string };

    await fetch(`${simBaseUrl}/_paysim/checkout/${paymentID}/action`, {
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
      body: JSON.stringify({ paymentID })
    });
    const execData = (await execRes.json()) as { trxID: string };
    const trxID = execData.trxID;

    // 2. First partial refund: 400.00 BDT
    const ref1Res = await fetch(`${simBaseUrl}/tokenized/checkout/payment/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`
      },
      body: JSON.stringify({
        paymentID,
        trxID,
        amount: '400.00',
        sku: 'ITEM-1',
        reason: 'Customer returned 1 item'
      })
    });
    expect(ref1Res.status).toBe(200);
    const ref1Data = (await ref1Res.json()) as {
      statusCode: string;
      statusMessage: string;
      originalTrxID: string;
      refundTrxID: string;
      amount: string;
      transactionStatus: string;
    };

    expect(ref1Data.statusCode).toBe('0000');
    expect(ref1Data.statusMessage).toBe('Successful');
    expect(ref1Data.originalTrxID).toBe(trxID);
    expect(ref1Data.refundTrxID).toMatch(/^BK/);
    expect(ref1Data.amount).toBe('400.00');
    expect(ref1Data.transactionStatus).toBe('Completed');

    expect(getTotalRefundedPaisa(simDb, paymentID)).toBe(40000);

    // 3. Second partial refund: 600.00 BDT (Reaching full 1000.00 BDT amount)
    const ref2Res = await fetch(`${simBaseUrl}/tokenized/checkout/payment/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`
      },
      body: JSON.stringify({
        paymentID,
        trxID,
        amount: '600.00',
        sku: 'ITEM-2',
        reason: 'Remaining items refunded'
      })
    });
    expect(ref2Res.status).toBe(200);
    const ref2Data = (await ref2Res.json()) as { statusCode: string; amount: string };
    expect(ref2Data.statusCode).toBe('0000');
    expect(ref2Data.amount).toBe('600.00');

    expect(getTotalRefundedPaisa(simDb, paymentID)).toBe(100000);
    const storedRefunds = getRefundsByPaymentId(simDb, paymentID);
    expect(storedRefunds.length).toBe(2);

    // 4. Over-refund attempt: 0.01 BDT (1 paisa excess) -> MUST return statusCode 2081
    const overRefundRes = await fetch(`${simBaseUrl}/tokenized/checkout/payment/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`
      },
      body: JSON.stringify({
        paymentID,
        trxID,
        amount: '0.01',
        reason: 'Over-refund test'
      })
    });
    expect(overRefundRes.status).toBe(200);
    const overRefundData = (await overRefundRes.json()) as {
      statusCode: string;
      statusMessage: string;
    };
    expect(overRefundData.statusCode).toBe('2081');
    expect(overRefundData.statusMessage).toBe('Refund amount exceeds original transaction amount');

    // Total refunded must remain untouched at exactly 100000 paisa
    expect(getTotalRefundedPaisa(simDb, paymentID)).toBe(100000);

    // 5. Test UAT Action Point #5 (UAT_RULE_5_REFUND_TOKEN_MISMATCH):
    // Deliberately re-grant a token while the previous one is still active, then use it for refund
    const redundantGrantRes = await fetch(`${simBaseUrl}/tokenized/checkout/token/grant`, {
      method: 'POST'
    });
    const redundantTokenData = (await redundantGrantRes.json()) as { id_token: string };

    // Create another payment to test refund with redundant token
    const cr2 = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${redundantTokenData.id_token}`
      },
      body: JSON.stringify({
        amount: '50.00',
        currency: 'BDT',
        intent: 'sale',
        merchantInvoiceNumber: 'INV-UAT-REFUND',
        callbackURL: `${merchantBaseUrl}/bkash/callback`
      })
    });
    const p2Id = ((await cr2.json()) as { paymentID: string }).paymentID;

    await fetch(`${simBaseUrl}/_paysim/checkout/${p2Id}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve' })
    });

    const ex2 = await fetch(`${simBaseUrl}/tokenized/checkout/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${redundantTokenData.id_token}`
      },
      body: JSON.stringify({ paymentID: p2Id })
    });
    const p2Trx = ((await ex2.json()) as { trxID: string }).trxID;

    // Refund using the redundantly granted token
    const uatRefundRes = await fetch(`${simBaseUrl}/tokenized/checkout/payment/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${redundantTokenData.id_token}`
      },
      body: JSON.stringify({
        paymentID: p2Id,
        trxID: p2Trx,
        amount: '50.00'
      })
    });
    expect(uatRefundRes.status).toBe(200);

    // Assert that UAT_RULE_5_REFUND_TOKEN_MISMATCH was recorded in SQLite events
    const violations = checkUatViolations(simDb);
    expect(violations.some((v) => v.rule === 'UAT_RULE_5_REFUND_TOKEN_MISMATCH')).toBe(true);
    const rule5Violation = violations.find((v) => v.rule === 'UAT_RULE_5_REFUND_TOKEN_MISMATCH')!;
    expect(rule5Violation.actionPoint).toBe('Action Point #5');
  });

  it('Test 2: POST /_paysim/demo/run-suite executes all 5 Chaos Scenarios and populates state', async () => {
    const suiteRes = await fetch(`${simBaseUrl}/_paysim/demo/run-suite`, {
      method: 'POST'
    });
    expect(suiteRes.status).toBe(200);

    const suiteData = (await suiteRes.json()) as {
      success: boolean;
      timestamp: string;
      results: Array<{
        scenario: number;
        name: string;
        chaosFault: string;
        naiveResult: string;
        hardenedResult: string;
        passed: boolean;
      }>;
    };

    expect(suiteData.success).toBe(true);
    expect(suiteData.results.length).toBe(5);

    // Verify all 5 scenarios pass
    for (const r of suiteData.results) {
      if (!r.passed) {
        console.error('Failed scenario:', r);
      }
      expect(r.passed).toBe(true);
      expect(r.name).toBeDefined();
      expect(r.chaosFault).toBeDefined();
      expect(r.naiveResult).toBeDefined();
      expect(r.hardenedResult).toBeDefined();
    }

    // Verify state snapshot reflects the newly generated events
    const stateRes = await fetch(`${simBaseUrl}/_paysim/state`);
    expect(stateRes.status).toBe(200);
    const state = (await stateRes.json()) as {
      summary: {
        total_payments: number;
        completed_payments: number;
        outbox_delivered: number;
      };
      events: Array<{ kind: string }>;
    };

    expect(state.summary.total_payments).toBeGreaterThanOrEqual(8);
    expect(state.summary.completed_payments).toBeGreaterThanOrEqual(5);
    expect(state.events.length).toBeGreaterThanOrEqual(10);
  });
});
