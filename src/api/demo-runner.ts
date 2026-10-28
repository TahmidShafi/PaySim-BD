import { type Database as DatabaseType } from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { type Clock } from '../core/clock.js';
import { createMerchantServer } from '../../merchant-demo/server.js';
import { insertWebhookSubscription } from '../storage/repositories.js';
import { createSignedNotificationEnvelope } from '../delivery/sns-signer.js';

export interface ScenarioSuiteResult {
  scenario: number;
  name: string;
  chaosFault: string;
  naiveResult: string;
  hardenedResult: string;
  passed: boolean;
}

export interface RunSuiteOptions {
  simBaseUrl: string;
  simDb: DatabaseType;
  clock: Clock;
  workerEvents?: EventEmitter;
}

async function waitForBalance(
  merchantBaseUrl: string,
  orderId: string,
  expectedBalancePaisa: number,
  timeoutMs = 1500
): Promise<number> {
  const start = Date.now();
  let currentPaisa = 0;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${merchantBaseUrl}/orders/${orderId}`);
      if (res.ok) {
        const data = (await res.json()) as { balance_paisa: number };
        currentPaisa = data.balance_paisa;
        if (currentPaisa === expectedBalancePaisa) {
          return currentPaisa;
        }
      }
    } catch {
      // transient poll error
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return currentPaisa;
}

async function waitForOrderStatus(
  merchantBaseUrl: string,
  orderId: string,
  expectedStatus: string,
  timeoutMs = 1500
): Promise<string> {
  const start = Date.now();
  let currentStatus = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${merchantBaseUrl}/orders/${orderId}`);
      if (res.ok) {
        const data = (await res.json()) as { status: string };
        currentStatus = data.status;
        if (currentStatus === expectedStatus) {
          return currentStatus;
        }
      }
    } catch {
      // transient poll error
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return currentStatus;
}

export async function runFiveScenarioSuite(options: RunSuiteOptions): Promise<ScenarioSuiteResult[]> {
  const { simBaseUrl, simDb, clock, workerEvents } = options;

  // 1. Boot ephemeral in-process Demo Merchant Server
  const merchant = createMerchantServer();
  const merchantApp = merchant.app;
  const merchantBaseUrl = await merchantApp.listen({ port: 0, host: '127.0.0.1' });

  try {
    // Initial Token Grant for the merchant session
    const grantRes = await fetch(`${simBaseUrl}/tokenized/checkout/token/grant`, { method: 'POST' });
    const { id_token: initialToken, refresh_token: initialRefreshToken } = (await grantRes.json()) as {
      id_token: string;
      refresh_token: string;
    };
    merchant.setPaysimConfig(simBaseUrl, initialToken, initialRefreshToken);

    const results: ScenarioSuiteResult[] = [];

    // --------------------------------------------------------------------------
    // Scenario 1: Concurrent Duplicate IPN (intervalMs: 0)
    // --------------------------------------------------------------------------
    {
      await fetch(`${simBaseUrl}/_paysim/chaos/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'rule-s1',
          match: { payerReferencePrefix: 'S1_' },
          action: 'duplicate',
          params: { count: 2, intervalMs: 0, sameMessageId: true }
        })
      });

      // Naive test
      simDb.prepare('DELETE FROM webhook_subscriptions').run();
      insertWebhookSubscription(simDb, {
        target_url: `${merchantBaseUrl}/ipn/naive`,
        status: 'ACTIVE',
        token: 'tok-s1-n',
        topic_arn: 'arn:aws:sns:ap-southeast-1:000000000000:bkash-ipn',
        confirmed_at: clock.nowMs()
      });

      const ordN = `SUITE_ORD_S1_NAIVE_${Date.now()}`;
      await fetch(`${merchantBaseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: ordN, customerId: 'CUST_1', initialBalancePaisa: 0 })
      });

      const crN = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${merchant.getToken()}` },
        body: JSON.stringify({
          amount: '500.00',
          merchantInvoiceNumber: ordN,
          payerReference: 'S1_N',
          callbackURL: `${merchantBaseUrl}/bkash/callback`
        })
      });
      const { paymentID: pidN } = (await crN.json()) as { paymentID: string };

      await fetch(`${simBaseUrl}/_paysim/checkout/${pidN}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve' })
      });
      await fetch(`${simBaseUrl}/tokenized/checkout/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${merchant.getToken()}` },
        body: JSON.stringify({ paymentID: pidN })
      });

      if (workerEvents) workerEvents.emit('wake');
      const balPaisaN = await waitForBalance(merchantBaseUrl, ordN, 100000);
      const balN = balPaisaN / 100;

      // Hardened test
      simDb.prepare('DELETE FROM webhook_subscriptions').run();
      insertWebhookSubscription(simDb, {
        target_url: `${merchantBaseUrl}/ipn/hardened`,
        status: 'ACTIVE',
        token: 'tok-s1-h',
        topic_arn: 'arn:aws:sns:ap-southeast-1:000000000000:bkash-ipn',
        confirmed_at: clock.nowMs()
      });

      const ordH = `SUITE_ORD_S1_HARDENED_${Date.now()}`;
      await fetch(`${merchantBaseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: ordH, customerId: 'CUST_1', initialBalancePaisa: 0 })
      });

      const crH = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${merchant.getToken()}` },
        body: JSON.stringify({
          amount: '500.00',
          merchantInvoiceNumber: ordH,
          payerReference: 'S1_H',
          callbackURL: `${merchantBaseUrl}/bkash/callback`
        })
      });
      const { paymentID: pidH } = (await crH.json()) as { paymentID: string };

      await fetch(`${simBaseUrl}/_paysim/checkout/${pidH}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve' })
      });
      await fetch(`${simBaseUrl}/tokenized/checkout/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${merchant.getToken()}` },
        body: JSON.stringify({ paymentID: pidH })
      });

      if (workerEvents) workerEvents.emit('wake');
      const balPaisaH = await waitForBalance(merchantBaseUrl, ordH, 50000);
      const balH = balPaisaH / 100;

      results.push({
        scenario: 1,
        name: 'Concurrent Duplicate IPN',
        chaosFault: 'count: 2, intervalMs: 0',
        naiveResult: `Double Credited: ${balN.toFixed(2)} BDT`,
        hardenedResult: `Idempotent 1x: ${balH.toFixed(2)} BDT`,
        passed: balN === 1000 && balH === 500
      });
    }

    // --------------------------------------------------------------------------
    // Scenario 2: IPN Arrives Before /execute Returns (Race)
    // --------------------------------------------------------------------------
    {
      await fetch(`${simBaseUrl}/_paysim/chaos/rules`, { method: 'DELETE' });
      simDb.prepare('DELETE FROM webhook_subscriptions').run();

      await fetch(`${simBaseUrl}/_paysim/chaos/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'rule-s2',
          match: { payerReferencePrefix: 'S2_' },
          action: 'ipn-before-execute',
          params: { maxWaitMs: 1500 }
        })
      });

      // Naive test
      insertWebhookSubscription(simDb, {
        target_url: `${merchantBaseUrl}/ipn/naive`,
        status: 'ACTIVE',
        token: 'tok-s2-n',
        topic_arn: 'arn:aws:sns:ap-southeast-1:000000000000:bkash-ipn',
        confirmed_at: clock.nowMs()
      });

      const ordN = `SUITE_ORD_S2_NAIVE_${Date.now()}`;
      await fetch(`${merchantBaseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: ordN, customerId: 'CUST_2', initialBalancePaisa: 0 })
      });

      await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${merchant.getToken()}`,
          'x-paysim-auto-approve': 'success'
        },
        body: JSON.stringify({
          amount: '500.00',
          merchantInvoiceNumber: ordN,
          payerReference: 'S2_N',
          callbackURL: `${merchantBaseUrl}/bkash/callback/naive?orderId=${ordN}`
        })
      });

      const balPaisaN = await waitForBalance(merchantBaseUrl, ordN, 100000);
      const balN = balPaisaN / 100;

      // Hardened test
      simDb.prepare('DELETE FROM webhook_subscriptions').run();
      insertWebhookSubscription(simDb, {
        target_url: `${merchantBaseUrl}/ipn/hardened`,
        status: 'ACTIVE',
        token: 'tok-s2-h',
        topic_arn: 'arn:aws:sns:ap-southeast-1:000000000000:bkash-ipn',
        confirmed_at: clock.nowMs()
      });

      const ordH = `SUITE_ORD_S2_HARDENED_${Date.now()}`;
      await fetch(`${merchantBaseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: ordH, customerId: 'CUST_2', initialBalancePaisa: 0 })
      });

      await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${merchant.getToken()}`,
          'x-paysim-auto-approve': 'success'
        },
        body: JSON.stringify({
          amount: '500.00',
          merchantInvoiceNumber: ordH,
          payerReference: 'S2_H',
          callbackURL: `${merchantBaseUrl}/bkash/callback/hardened?orderId=${ordH}`
        })
      });

      const balPaisaH = await waitForBalance(merchantBaseUrl, ordH, 50000);
      const balH = balPaisaH / 100;

      results.push({
        scenario: 2,
        name: 'IPN-Before-Execute Race',
        chaosFault: 'ipn-before-execute hook',
        naiveResult: `Race Double Credit: ${balN.toFixed(2)} BDT`,
        hardenedResult: `Locked 1x Credit: ${balH.toFixed(2)} BDT`,
        passed: balN === 1000 && balH === 500
      });
    }

    // --------------------------------------------------------------------------
    // Scenario 3: /execute Times Out After Commit
    // --------------------------------------------------------------------------
    {
      await fetch(`${simBaseUrl}/_paysim/chaos/rules`, { method: 'DELETE' });
      await fetch(`${simBaseUrl}/_paysim/chaos/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'rule-s3',
          match: { payerReferencePrefix: 'S3_' },
          action: 'timeout-after-commit',
          params: { holdMs: 200 }
        })
      });

      // Naive test
      const ordN = `SUITE_ORD_S3_NAIVE_${Date.now()}`;
      await fetch(`${merchantBaseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: ordN, customerId: 'CUST_3', initialBalancePaisa: 0 })
      });

      await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${merchant.getToken()}`,
          'x-paysim-auto-approve': 'success'
        },
        body: JSON.stringify({
          amount: '500.00',
          merchantInvoiceNumber: ordN,
          payerReference: 'S3_N',
          callbackURL: `${merchantBaseUrl}/bkash/callback/naive?orderId=${ordN}`
        })
      });

      const statusN = await waitForOrderStatus(merchantBaseUrl, ordN, 'FAILED');

      // Hardened test
      const ordH = `SUITE_ORD_S3_HARDENED_${Date.now()}`;
      await fetch(`${merchantBaseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: ordH, customerId: 'CUST_3', initialBalancePaisa: 0 })
      });

      await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${merchant.getToken()}`,
          'x-paysim-auto-approve': 'success'
        },
        body: JSON.stringify({
          amount: '500.00',
          merchantInvoiceNumber: ordH,
          payerReference: 'S3_H',
          callbackURL: `${merchantBaseUrl}/bkash/callback/hardened?orderId=${ordH}`
        })
      });

      const statusH = await waitForOrderStatus(merchantBaseUrl, ordH, 'COMPLETED');

      results.push({
        scenario: 3,
        name: '/execute Timeout & Recovery',
        chaosFault: 'timeout-after-commit',
        naiveResult: `Lost Funds (Status: ${statusN}, 0 BDT)`,
        hardenedResult: `Recovered via /status (500 BDT)`,
        passed: statusN === 'FAILED' && statusH === 'COMPLETED'
      });
    }

    // --------------------------------------------------------------------------
    // Scenario 4: Forged SNS Signature (Tampered Amount)
    // --------------------------------------------------------------------------
    {
      const signingCertUrl = `${simBaseUrl}/.well-known/paysim-sns.pem`;
      const origMsg = JSON.stringify({
        dateTime: clock.nowIso(),
        amount: '100.00',
        currency: 'BDT',
        trxID: `TRX_FORGE_${Date.now()}`,
        transactionStatus: 'Completed',
        merchantInvoiceNumber: 'SUITE_ORD_S4'
      });

      const env = createSignedNotificationEnvelope(
        {
          Type: 'Notification',
          MessageId: `msg-forge-${Date.now()}`,
          TopicArn: 'arn:aws:sns:ap-southeast-1:000000000000:bkash-ipn',
          Subject: 'bKash IPN',
          Message: origMsg,
          Timestamp: clock.nowIso()
        },
        signingCertUrl
      );

      const tamperedEnv = {
        ...env,
        Message: JSON.stringify({ ...JSON.parse(origMsg), amount: '99999.00' })
      };

      const resN = await fetch(`${merchantBaseUrl}/ipn/naive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tamperedEnv)
      });

      const resH = await fetch(`${merchantBaseUrl}/ipn/hardened`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tamperedEnv)
      });

      results.push({
        scenario: 4,
        name: 'Forged SNS Signature',
        chaosFault: 'tamper-amount (99,999)',
        naiveResult: `Accepted Spoofed Webhook (HTTP ${resN.status})`,
        hardenedResult: `Rejected Signature Mismatch (HTTP ${resH.status})`,
        passed: resN.status === 200 && resH.status === 400
      });
    }

    // --------------------------------------------------------------------------
    // Scenario 5: Expired id_token After 3601s (Auto-Refresh)
    // --------------------------------------------------------------------------
    {
      clock.advanceMs(3601 * 1000); // Past 1h TTL

      const ordN = `SUITE_ORD_S5_NAIVE_${Date.now()}`;
      const resN = await fetch(`${merchantBaseUrl}/checkout/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'naive', orderId: ordN, customerId: 'CUST_5', amount: '500.00' })
      });

      const ordH = `SUITE_ORD_S5_HARDENED_${Date.now()}`;
      const resH = await fetch(`${merchantBaseUrl}/checkout/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'hardened', orderId: ordH, customerId: 'CUST_5', amount: '500.00' })
      });

      results.push({
        scenario: 5,
        name: '1-Hour Token Expiry',
        chaosFault: 'clock.advanceMs(3601s)',
        naiveResult: `Checkout Failed (HTTP ${resN.status} Unauthorized)`,
        hardenedResult: `Auto-Refreshed & Succeeded (HTTP ${resH.status})`,
        passed: resN.status === 401 && resH.status === 200
      });
    }

    // Clean up chaos rules
    await fetch(`${simBaseUrl}/_paysim/chaos/rules`, { method: 'DELETE' });

    return results;
  } finally {
    await merchantApp.close();
    merchant.db.close();
  }
}
