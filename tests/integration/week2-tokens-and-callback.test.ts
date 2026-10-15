import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { createDatabase } from '../../src/storage/db.js';
import { VirtualClock } from '../../src/core/clock.js';
import { createSimulatorServer } from '../../src/api/server.js';
import { createMerchantServer } from '../../merchant-demo/server.js';
import { getPaymentById, getEventsByPaymentId } from '../../src/storage/repositories.js';
import { type FastifyInstance } from 'fastify';

describe('Week 2 Integration: Tokens, Clock, Wallets, and Callback Flow', () => {
  let simApp: FastifyInstance;
  let simBaseUrl: string;
  let simDb: ReturnType<typeof createDatabase>;
  let clock: VirtualClock;
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

    const merchant = createMerchantServer();
    merchantApp = merchant.app;
    merchantDb = merchant.db;
    setPaysimConfig = merchant.setPaysimConfig;

    merchantBaseUrl = await merchantApp.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await simApp.close();
    await merchantApp.close();
    simDb.close();
    merchantDb.close();
  });

  it('enforces 1-hour id_token expiry and 28-day refresh_token lifecycle (Day 7)', async () => {
    // 1. Grant initial token
    const grantRes = await fetch(`${simBaseUrl}/tokenized/checkout/token/grant`, {
      method: 'POST'
    });
    const grantData = (await grantRes.json()) as {
      statusCode: string;
      id_token: string;
      refresh_token: string;
      expires_in: number;
    };
    expect(grantData.statusCode).toBe('0000');
    expect(grantData.expires_in).toBe(3600);
    const initialIdToken = grantData.id_token;
    const refreshToken = grantData.refresh_token;

    // 2. Token should work immediately for /create
    const createRes1 = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${initialIdToken}`
      },
      body: JSON.stringify({
        amount: '100.00',
        merchantInvoiceNumber: 'INV-TOK-1',
        callbackURL: `${merchantBaseUrl}/bkash/callback`
      })
    });
    expect(createRes1.status).toBe(200);

    // 3. Advance virtual clock by 3601 seconds (past 1 hour)
    const advRes = await fetch(`${simBaseUrl}/_paysim/clock/advance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds: 3601 })
    });
    expect(advRes.status).toBe(200);

    // 4. Using expired id_token must return HTTP 401 Unauthorized
    const createResExpired = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${initialIdToken}`
      },
      body: JSON.stringify({
        amount: '100.00',
        merchantInvoiceNumber: 'INV-TOK-EXPIRED',
        callbackURL: `${merchantBaseUrl}/bkash/callback`
      })
    });
    expect(createResExpired.status).toBe(401);
    const expiredData = (await createResExpired.json()) as { statusCode: string };
    expect(expiredData.statusCode).toBe('2007');

    // 5. Refresh id_token using the refresh_token
    const refreshRes = await fetch(`${simBaseUrl}/tokenized/checkout/token/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken })
    });
    expect(refreshRes.status).toBe(200);
    const refreshData = (await refreshRes.json()) as {
      statusCode: string;
      id_token: string;
      refresh_token: string;
    };
    expect(refreshData.statusCode).toBe('0000');
    expect(refreshData.id_token).not.toBe(initialIdToken);
    expect(refreshData.refresh_token).toBe(refreshToken);
    const newIdToken = refreshData.id_token;

    // 6. New id_token works
    const createRes2 = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${newIdToken}`
      },
      body: JSON.stringify({
        amount: '100.00',
        merchantInvoiceNumber: 'INV-TOK-2',
        callbackURL: `${merchantBaseUrl}/bkash/callback`
      })
    });
    expect(createRes2.status).toBe(200);

    // 7. Advance clock past 28 days from initial grant (28 * 24 * 3600 = 2,419,200 seconds)
    await fetch(`${simBaseUrl}/_paysim/clock/advance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds: 2419200 })
    });

    // 8. Refreshing now MUST fail with HTTP 401 because the original 28-day window expired
    const refreshExpiredRes = await fetch(`${simBaseUrl}/tokenized/checkout/token/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken })
    });
    expect(refreshExpiredRes.status).toBe(401);
  });

  it('enforces UAT Rule 2 when calling /execute before approval, returning HTTP-200 with 2029 (Day 9)', async () => {
    // Grant token
    const grantRes = await fetch(`${simBaseUrl}/tokenized/checkout/token/grant`, {
      method: 'POST'
    });
    const { id_token } = (await grantRes.json()) as { id_token: string };

    // Create payment without auto-approve (remains INITIATED)
    const createRes = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${id_token}`
      },
      body: JSON.stringify({
        amount: '250.00',
        merchantInvoiceNumber: 'INV-RULE2',
        callbackURL: `${merchantBaseUrl}/bkash/callback`
      })
    });
    const { paymentID, transactionStatus } = (await createRes.json()) as {
      paymentID: string;
      transactionStatus: string;
    };
    expect(transactionStatus).toBe('Initiated');

    // Calling /execute while in INITIATED state violates UAT Rule 2
    const execRes = await fetch(`${simBaseUrl}/tokenized/checkout/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${id_token}`
      },
      body: JSON.stringify({ paymentID })
    });

    // Must return HTTP 200 with statusCode: 2029 per bKash envelope specification
    expect(execRes.status).toBe(200);
    const execData = (await execRes.json()) as { statusCode: string; statusMessage: string };
    expect(execData.statusCode).toBe('2029');

    // Verify audit event was logged in the events table
    const events = getEventsByPaymentId(simDb, paymentID);
    expect(events.some((e) => e.kind === 'UAT_RULE_2_EXECUTE_WITHOUT_SUCCESS_CALLBACK')).toBe(true);
  });

  it('rejects duplicate /execute with statusCode 2062 and prevents duplicate trxID (Day 9)', async () => {
    const grantRes = await fetch(`${simBaseUrl}/tokenized/checkout/token/grant`, {
      method: 'POST'
    });
    const { id_token } = (await grantRes.json()) as { id_token: string };

    // Create payment
    const createRes = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${id_token}`
      },
      body: JSON.stringify({
        amount: '300.00',
        merchantInvoiceNumber: 'INV-DUP-EXEC',
        callbackURL: `${merchantBaseUrl}/bkash/callback`
      })
    });
    const { paymentID } = (await createRes.json()) as { paymentID: string };

    // Approve payment via wallet action endpoint
    const actionRes = await fetch(`${simBaseUrl}/_paysim/checkout/${paymentID}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve' })
    });
    expect(actionRes.status).toBe(200);

    // First /execute call succeeds
    const exec1Res = await fetch(`${simBaseUrl}/tokenized/checkout/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${id_token}`
      },
      body: JSON.stringify({ paymentID })
    });
    expect(exec1Res.status).toBe(200);
    const exec1Data = (await exec1Res.json()) as { statusCode: string; trxID: string };
    expect(exec1Data.statusCode).toBe('0000');
    const firstTrxId = exec1Data.trxID;

    // Second duplicate /execute call MUST return HTTP 200 with statusCode: 2062
    const exec2Res = await fetch(`${simBaseUrl}/tokenized/checkout/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${id_token}`
      },
      body: JSON.stringify({ paymentID })
    });
    expect(exec2Res.status).toBe(200);
    const exec2Data = (await exec2Res.json()) as { statusCode: string; statusMessage: string };
    expect(exec2Data.statusCode).toBe('2062');
    expect(exec2Data.statusMessage).toMatch(/already been executed/);

    // Verify database trx_id was not modified or duplicated
    const paymentInDb = getPaymentById(simDb, paymentID);
    expect(paymentInDb?.trx_id).toBe(firstTrxId);
  });

  it('runs full create -> auto-approve -> GET /bkash/callback -> execute flow with test wallets (Day 8)', async () => {
    const grantRes = await fetch(`${simBaseUrl}/tokenized/checkout/token/grant`, {
      method: 'POST'
    });
    const { id_token } = (await grantRes.json()) as { id_token: string };

    // Configure merchant demo with PaySim details
    setPaysimConfig(simBaseUrl, id_token);

    // 1. Success wallet (01770618575)
    const createSuccessRes = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${id_token}`,
        'x-paysim-auto-approve': 'success'
      },
      body: JSON.stringify({
        amount: '400.00',
        customerMsisdn: '01770618575',
        merchantInvoiceNumber: 'INV-WALLET-SUCCESS',
        callbackURL: `${merchantBaseUrl}/bkash/callback`
      })
    });
    const { paymentID: successPaymentId } = (await createSuccessRes.json()) as { paymentID: string };

    // Wait for auto-approve and GET callback dispatch
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Verify payment in simulator transitioned to COMPLETED through merchant callback execute
    const successPayment = getPaymentById(simDb, successPaymentId);
    expect(successPayment?.status).toBe('COMPLETED');
    expect(successPayment?.trx_id).toBeDefined();

    // 2. Insufficient balance wallet (01823074817)
    const createFailRes = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${id_token}`
      },
      body: JSON.stringify({
        amount: '500.00',
        customerMsisdn: '01823074817',
        merchantInvoiceNumber: 'INV-WALLET-FAIL',
        callbackURL: `${merchantBaseUrl}/bkash/callback`
      })
    });
    const { paymentID: failPaymentId } = (await createFailRes.json()) as { paymentID: string };

    // Trigger wallet action with insufficient balance wallet
    const actionFailRes = await fetch(`${simBaseUrl}/_paysim/checkout/${failPaymentId}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerMsisdn: '01823074817' })
    });
    const actionFailData = (await actionFailRes.json()) as { statusCode: string; status: string };
    expect(actionFailData.statusCode).toBe('2023'); // Insufficient Balance
    expect(actionFailData.status).toBe('failure');

    // Allow callback to arrive
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify payment in simulator remains FAILED and was NOT executed
    const failPayment = getPaymentById(simDb, failPaymentId);
    expect(failPayment?.status).toBe('FAILED');
    expect(failPayment?.trx_id).toBeNull();
  });
});
