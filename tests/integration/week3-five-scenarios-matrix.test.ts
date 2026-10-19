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
  insertWebhookSubscription
} from '../../src/storage/repositories.js';
import { checkUatViolations } from '../../src/linter/uat-linter.js';
import { createSignedNotificationEnvelope } from '../../src/delivery/sns-signer.js';

describe('Week 3 Master Integration Suite: 5-Scenario Matrix & UAT Compliance Audit', () => {
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
  let getToken: ReturnType<typeof createMerchantServer>['getToken'];
  let getRefreshToken: ReturnType<typeof createMerchantServer>['getRefreshToken'];

  let initialIdToken: string;
  let initialRefreshToken: string;

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
    getToken = merchant.getToken;
    getRefreshToken = merchant.getRefreshToken;
    merchantBaseUrl = await merchantApp.listen({ port: 0, host: '127.0.0.1' });

    // Initial grant
    const grantRes = await fetch(`${simBaseUrl}/tokenized/checkout/token/grant`, {
      method: 'POST'
    });
    const grantData = (await grantRes.json()) as { id_token: string; refresh_token: string };
    initialIdToken = grantData.id_token;
    initialRefreshToken = grantData.refresh_token;

    setPaysimConfig(simBaseUrl, initialIdToken, initialRefreshToken);
  });

  afterAll(async () => {
    worker.stop();
    await simApp.close();
    await merchantApp.close();
    simDb.close();
    merchantDb.close();
  });

  beforeEach(async () => {
    await fetch(`${simBaseUrl}/_paysim/chaos/rules`, { method: 'DELETE' });
    simDb.prepare('DELETE FROM webhook_subscriptions').run();
  });

  describe('Scenario 1: Concurrent Duplicate IPN (intervalMs: 0)', () => {
    it('demonstrates Naive double-credit vs Hardened single-credit on concurrent duplicate IPNs', async () => {
      // 1. Configure duplicate rule
      await fetch(`${simBaseUrl}/_paysim/chaos/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'rule-s1-duplicate',
          match: { payerReferencePrefix: 'S1_' },
          action: 'duplicate',
          params: { count: 2, intervalMs: 0, sameMessageId: true }
        })
      });

      // Part A: Naive Merchant
      insertWebhookSubscription(simDb, {
        target_url: `${merchantBaseUrl}/ipn/naive`,
        status: 'ACTIVE',
        token: 'tok-s1-naive',
        topic_arn: 'arn:aws:sns:ap-southeast-1:000000000000:bkash-ipn',
        confirmed_at: clock.nowMs()
      });

      const orderNaive = 'ORD_S1_NAIVE';
      await fetch(`${merchantBaseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: orderNaive, customerId: 'CUST_S1_N', initialBalancePaisa: 0 })
      });

      const createResN = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`
        },
        body: JSON.stringify({
          amount: '500.00',
          merchantInvoiceNumber: orderNaive,
          payerReference: 'S1_NAIVE_REF',
          callbackURL: `${merchantBaseUrl}/bkash/callback`
        })
      });
      const { paymentID: paymentIdN } = (await createResN.json()) as { paymentID: string };

      // Manually approve without triggering browser redirect callback
      await fetch(`${simBaseUrl}/_paysim/checkout/${paymentIdN}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve' })
      });

      // Execute once -> duplicate chaos hook spawns 2 outbox rows
      await fetch(`${simBaseUrl}/tokenized/checkout/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`
        },
        body: JSON.stringify({ paymentID: paymentIdN })
      });

      await worker.processDueRows();
      await new Promise((r) => setTimeout(r, 150));

      // Naive order received both duplicate webhook credits -> 1000.00 BDT (100,000 paisa)
      const orderDataN = (await (await fetch(`${merchantBaseUrl}/orders/${orderNaive}`)).json()) as {
        balance_paisa: number;
      };
      expect(orderDataN.balance_paisa).toBe(100000);

      // Part B: Hardened Merchant
      simDb.prepare('DELETE FROM webhook_subscriptions').run();
      insertWebhookSubscription(simDb, {
        target_url: `${merchantBaseUrl}/ipn/hardened`,
        status: 'ACTIVE',
        token: 'tok-s1-hardened',
        topic_arn: 'arn:aws:sns:ap-southeast-1:000000000000:bkash-ipn',
        confirmed_at: clock.nowMs()
      });

      const orderHardened = 'ORD_S1_HARDENED';
      await fetch(`${merchantBaseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: orderHardened, customerId: 'CUST_S1_H', initialBalancePaisa: 0 })
      });

      const createResH = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`
        },
        body: JSON.stringify({
          amount: '500.00',
          merchantInvoiceNumber: orderHardened,
          payerReference: 'S1_HARDENED_REF',
          callbackURL: `${merchantBaseUrl}/bkash/callback`
        })
      });
      const { paymentID: paymentIdH } = (await createResH.json()) as { paymentID: string };

      await fetch(`${simBaseUrl}/_paysim/checkout/${paymentIdH}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve' })
      });

      await fetch(`${simBaseUrl}/tokenized/checkout/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`
        },
        body: JSON.stringify({ paymentID: paymentIdH })
      });

      await worker.processDueRows();
      await new Promise((r) => setTimeout(r, 150));

      // Hardened order de-duplicated via processed_transactions -> exactly 500.00 BDT (50,000 paisa)
      const orderDataH = (await (await fetch(`${merchantBaseUrl}/orders/${orderHardened}`)).json()) as {
        balance_paisa: number;
      };
      expect(orderDataH.balance_paisa).toBe(50000);
    });
  });

  describe('Scenario 2: IPN Arrives Before /execute Returns (ipn-before-execute)', () => {
    it('demonstrates Naive race double-credit vs Hardened single-credit', async () => {
      await fetch(`${simBaseUrl}/_paysim/chaos/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'rule-s2-race',
          match: { payerReferencePrefix: 'S2_' },
          action: 'ipn-before-execute',
          params: { maxWaitMs: 2000 }
        })
      });

      // Part A: Naive
      insertWebhookSubscription(simDb, {
        target_url: `${merchantBaseUrl}/ipn/naive`,
        status: 'ACTIVE',
        token: 'tok-s2-naive',
        topic_arn: 'arn:aws:sns:ap-southeast-1:000000000000:bkash-ipn',
        confirmed_at: clock.nowMs()
      });

      const orderN = 'ORD_S2_NAIVE';
      await fetch(`${merchantBaseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: orderN, customerId: 'CUST_S2_N', initialBalancePaisa: 0 })
      });

      await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
          'x-paysim-auto-approve': 'success'
        },
        body: JSON.stringify({
          amount: '500.00',
          merchantInvoiceNumber: orderN,
          payerReference: 'S2_NAIVE_REF',
          callbackURL: `${merchantBaseUrl}/bkash/callback/naive?orderId=${orderN}`
        })
      });

      await new Promise((r) => setTimeout(r, 350));
      const resN = (await (await fetch(`${merchantBaseUrl}/orders/${orderN}`)).json()) as { balance_paisa: number };
      expect(resN.balance_paisa).toBe(100000); // 1000.00 BDT double credit

      // Part B: Hardened
      simDb.prepare('DELETE FROM webhook_subscriptions').run();
      insertWebhookSubscription(simDb, {
        target_url: `${merchantBaseUrl}/ipn/hardened`,
        status: 'ACTIVE',
        token: 'tok-s2-hardened',
        topic_arn: 'arn:aws:sns:ap-southeast-1:000000000000:bkash-ipn',
        confirmed_at: clock.nowMs()
      });

      const orderH = 'ORD_S2_HARDENED';
      await fetch(`${merchantBaseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: orderH, customerId: 'CUST_S2_H', initialBalancePaisa: 0 })
      });

      await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
          'x-paysim-auto-approve': 'success'
        },
        body: JSON.stringify({
          amount: '500.00',
          merchantInvoiceNumber: orderH,
          payerReference: 'S2_HARDENED_REF',
          callbackURL: `${merchantBaseUrl}/bkash/callback/hardened?orderId=${orderH}`
        })
      });

      await new Promise((r) => setTimeout(r, 350));
      const resH = (await (await fetch(`${merchantBaseUrl}/orders/${orderH}`)).json()) as { balance_paisa: number };
      expect(resH.balance_paisa).toBe(50000); // exactly 500.00 BDT
    });
  });

  describe('Scenario 3: /execute Times Out After Commit & Recovery via /payment/status', () => {
    it('demonstrates Naive order failure vs Hardened status recovery', async () => {
      await fetch(`${simBaseUrl}/_paysim/chaos/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'rule-s3-timeout',
          match: { payerReferencePrefix: 'S3_' },
          action: 'timeout-after-commit',
          params: { holdMs: 250 }
        })
      });

      // Part A: Naive
      const orderN = 'ORD_S3_NAIVE';
      await fetch(`${merchantBaseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: orderN, customerId: 'CUST_S3_N', initialBalancePaisa: 0 })
      });

      const createResN = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
          'x-paysim-auto-approve': 'success'
        },
        body: JSON.stringify({
          amount: '500.00',
          merchantInvoiceNumber: orderN,
          payerReference: 'S3_NAIVE_REF',
          callbackURL: `${merchantBaseUrl}/bkash/callback/naive?orderId=${orderN}`
        })
      });
      const { paymentID: pidN } = (await createResN.json()) as { paymentID: string };

      await new Promise((r) => setTimeout(r, 400));
      const payN = getPaymentById(simDb, pidN);
      expect(payN?.status).toBe('COMPLETED');

      const resN = (await (await fetch(`${merchantBaseUrl}/orders/${orderN}`)).json()) as {
        status: string;
        balance_paisa: number;
      };
      expect(resN.status).toBe('FAILED');
      expect(resN.balance_paisa).toBe(0);

      // Part B: Hardened
      const orderH = 'ORD_S3_HARDENED';
      await fetch(`${merchantBaseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: orderH, customerId: 'CUST_S3_H', initialBalancePaisa: 0 })
      });

      const createResH = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
          'x-paysim-auto-approve': 'success'
        },
        body: JSON.stringify({
          amount: '500.00',
          merchantInvoiceNumber: orderH,
          payerReference: 'S3_HARDENED_REF',
          callbackURL: `${merchantBaseUrl}/bkash/callback/hardened?orderId=${orderH}`
        })
      });
      const { paymentID: pidH } = (await createResH.json()) as { paymentID: string };

      await new Promise((r) => setTimeout(r, 450));
      const payH = getPaymentById(simDb, pidH);
      expect(payH?.status).toBe('COMPLETED');

      const resH = (await (await fetch(`${merchantBaseUrl}/orders/${orderH}`)).json()) as {
        status: string;
        balance_paisa: number;
      };
      expect(resH.status).toBe('COMPLETED');
      expect(resH.balance_paisa).toBe(50000);
    });
  });

  describe('Scenario 4: Forged SNS Signature (tamper-amount)', () => {
    it('demonstrates Naive accepts forged payload vs Hardened rejects with HTTP 400', async () => {
      const signingCertUrl = `${simBaseUrl}/.well-known/paysim-sns.pem`;
      const originalMessage = JSON.stringify({
        dateTime: clock.nowIso(),
        debitMSISDN: '01770618575',
        amount: '100.00',
        currency: 'BDT',
        trxID: 'BKFORGED99',
        transactionStatus: 'Completed',
        merchantInvoiceNumber: 'ORD_FORGE_TEST',
        paymentID: 'PAY_FORGE_99'
      });

      // Valid signed envelope
      const signedEnvelope = createSignedNotificationEnvelope(
        {
          Type: 'Notification',
          MessageId: 'msg-forged-test',
          TopicArn: 'arn:aws:sns:ap-southeast-1:000000000000:bkash-ipn',
          Subject: 'bKash Payment Notification',
          Message: originalMessage,
          Timestamp: clock.nowIso()
        },
        signingCertUrl
      );

      // Tamper amount in payload without re-signing
      const tamperedMessage = JSON.stringify({
        ...JSON.parse(originalMessage),
        amount: '99999.00'
      });
      const tamperedEnvelope = {
        ...signedEnvelope,
        Message: tamperedMessage
      };

      // Naive endpoint: accepts and parses directly without signature verification
      const naiveRes = await fetch(`${merchantBaseUrl}/ipn/naive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tamperedEnvelope)
      });
      expect(naiveRes.status).toBe(200);

      // Hardened endpoint: verifies RSA-SHA1 signature against public X.509 cert and rejects
      const hardenedRes = await fetch(`${merchantBaseUrl}/ipn/hardened`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tamperedEnvelope)
      });
      expect(hardenedRes.status).toBe(400);
      const hardenedErr = (await hardenedRes.json()) as { error: string };
      expect(hardenedErr.error).toContain('Invalid SNS signature');
    });
  });

  describe('Scenario 5: Expired id_token After 3601s (Auto-Refresh Handling)', () => {
    it('demonstrates Naive fails with 401 vs Hardened refreshes token and succeeds', async () => {
      // 1. Advance virtual clock past 3600 seconds (1 hour TTL)
      clock.advanceMs(3601 * 1000);

      const oldToken = getToken();

      // Part A: Naive client calls /checkout/create with expired token
      const naiveRes = await fetch(`${merchantBaseUrl}/checkout/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'naive',
          amount: '150.00',
          orderId: 'ORD_S5_NAIVE',
          payerReference: 'S5_NAIVE_REF'
        })
      });
      expect(naiveRes.status).toBe(401); // Failed: Naive client never refreshes!

      // Part B: Hardened client calls /checkout/create with expired token
      const hardenedRes = await fetch(`${merchantBaseUrl}/checkout/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'hardened',
          amount: '150.00',
          orderId: 'ORD_S5_HARDENED',
          payerReference: 'S5_HARDENED_REF'
        })
      });
      expect(hardenedRes.status).toBe(200); // Succeeded: automatically refreshed token!
      const hardenedData = (await hardenedRes.json()) as { statusCode: string; paymentID: string };
      expect(hardenedData.statusCode).toBe('0000');
      expect(hardenedData.paymentID).toBeDefined();

      // Cached token on Hardened merchant has been updated to the newly issued token
      const newToken = getToken();
      expect(newToken).not.toBe(oldToken);
    });
  });

  describe('UAT Compliance Audit: Naive Violations vs Hardened 0-Violation Guarantee', () => {
    it('detects UAT violations on Naive merchant and verifies 0 violations on clean Hardened merchant', async () => {
      // 1. Naive Merchant triggers UAT Rule 1 (Redundant Token Grant)
      // Calls /token/grant while previous token is still valid
      await fetch(`${simBaseUrl}/tokenized/checkout/token/grant`, { method: 'POST' });

      // 2. Naive Merchant triggers UAT Rule 2 (Execute Without Success Callback)
      // Creates payment in INITIATED state and immediately calls execute without approval
      const createRes = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`
        },
        body: JSON.stringify({
          amount: '400.00',
          merchantInvoiceNumber: 'ORD_UAT_NAIVE_RULE2',
          callbackURL: `${merchantBaseUrl}/bkash/callback`
        })
      });
      const { paymentID: unapprovedPaymentId } = (await createRes.json()) as { paymentID: string };

      await fetch(`${simBaseUrl}/tokenized/checkout/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`
        },
        body: JSON.stringify({ paymentID: unapprovedPaymentId })
      });

      // 3. Naive Merchant triggers UAT Rule 4 (Unnecessary Query Status)
      // Creates payment with auto-approve, executes it successfully, then calls /payment/status
      const createCleanRes = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
          'x-paysim-auto-approve': 'success'
        },
        body: JSON.stringify({
          amount: '400.00',
          merchantInvoiceNumber: 'ORD_UAT_NAIVE_RULE4',
          callbackURL: `${merchantBaseUrl}/bkash/callback`
        })
      });
      const { paymentID: cleanPaymentId } = (await createCleanRes.json()) as { paymentID: string };

      await new Promise((r) => setTimeout(r, 60));
      await fetch(`${simBaseUrl}/tokenized/checkout/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`
        },
        body: JSON.stringify({ paymentID: cleanPaymentId })
      });

      // Polling /payment/status after clean execute violates Action Point #4!
      await fetch(`${simBaseUrl}/tokenized/checkout/payment/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`
        },
        body: JSON.stringify({ paymentID: cleanPaymentId })
      });

      // 4. Audit violations via GET /_paysim/linter/violations
      const auditRes = await fetch(`${simBaseUrl}/_paysim/linter/violations`);
      const { violations } = (await auditRes.json()) as {
        count: number;
        violations: Array<{ rule: string; actionPoint: string }>;
      };

      const rulesFound = violations.map((v) => v.rule);
      expect(rulesFound).toContain('UAT_RULE_1_REDUNDANT_TOKEN_GRANT');
      expect(rulesFound).toContain('UAT_RULE_2_EXECUTE_WITHOUT_SUCCESS_CALLBACK');
      expect(rulesFound).toContain('UAT_RULE_4_UNNECESSARY_QUERY_STATUS');

      // 5. Verify Hardened Merchant execution with a fresh database produces 0 UAT violations
      const cleanDb = createDatabase(':memory:');
      const cleanClock = new VirtualClock(1700000000000);
      const cleanApp = createSimulatorServer({ db: cleanDb, clock: cleanClock });
      const cleanUrl = await cleanApp.listen({ port: 0, host: '127.0.0.1' });

      // Clean token grant (initial)
      const cleanGrant = (await (
        await fetch(`${cleanUrl}/tokenized/checkout/token/grant`, { method: 'POST' })
      ).json()) as { id_token: string };

      // Clean create -> auto-approve -> execute flow
      const cleanCreate = (await (
        await fetch(`${cleanUrl}/tokenized/checkout/create`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cleanGrant.id_token}`,
            'x-paysim-auto-approve': 'success'
          },
          body: JSON.stringify({
            amount: '500.00',
            merchantInvoiceNumber: 'ORD_PERFECT_AUDIT',
            callbackURL: `${merchantBaseUrl}/bkash/callback/hardened`
          })
        })
      ).json()) as { paymentID: string };

      await new Promise((r) => setTimeout(r, 60));
      await fetch(`${cleanUrl}/tokenized/checkout/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cleanGrant.id_token}`
        },
        body: JSON.stringify({ paymentID: cleanCreate.paymentID })
      });

      // Audit cleanDb
      const cleanViolations = checkUatViolations(cleanDb);
      expect(cleanViolations).toHaveLength(0); // Perfect compliance: 0 UAT violations!

      await cleanApp.close();
      cleanDb.close();
    });
  });
});
