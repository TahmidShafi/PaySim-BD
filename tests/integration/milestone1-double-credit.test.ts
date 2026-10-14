import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { createDatabase } from '../../src/storage/db.js';
import { VirtualClock } from '../../src/core/clock.js';
import { createSimulatorServer } from '../../src/api/server.js';
import { OutboxWorker } from '../../src/delivery/worker.js';
import { createMerchantServer } from '../../merchant-demo/server.js';
import { type FastifyInstance } from 'fastify';

describe('Milestone 1 Integration: Walking Skeleton & Double-Credit Proof', () => {
  let simApp: FastifyInstance;
  let simBaseUrl: string;
  let simDb: ReturnType<typeof createDatabase>;
  let clock: VirtualClock;
  let worker: OutboxWorker;
  let workerEvents: EventEmitter;

  let merchantApp: FastifyInstance;
  let merchantBaseUrl: string;
  let merchantDb: ReturnType<typeof createMerchantServer>['db'];

  beforeAll(async () => {
    // 1. Initialize Simulator
    simDb = createDatabase(':memory:');
    clock = new VirtualClock(1700000000000);
    workerEvents = new EventEmitter();

    simApp = createSimulatorServer({
      db: simDb,
      clock,
      workerEvents,
      chaosRule: {
        type: 'duplicate',
        count: 2,
        interval_ms: 0,
        same_message_id: true
      }
    });

    const simAddress = await simApp.listen({ port: 0, host: '127.0.0.1' });
    simBaseUrl = simAddress;

    // 2. Initialize Delivery Worker
    worker = new OutboxWorker({
      db: simDb,
      clock,
      eventEmitter: workerEvents,
      pollIntervalMs: 50
    });
    worker.start();

    // 3. Initialize Demo Merchant
    const merchantResult = createMerchantServer();
    merchantApp = merchantResult.app;
    merchantDb = merchantResult.db;

    const merchantAddress = await merchantApp.listen({ port: 0, host: '127.0.0.1' });
    merchantBaseUrl = merchantAddress;
  });

  afterAll(async () => {
    worker.stop();
    await simApp.close();
    await merchantApp.close();
    simDb.close();
    merchantDb.close();
  });

  it('demonstrates double-credit vulnerability on /ipn/naive under duplicate webhook delivery', async () => {
    const orderId = 'ORD_NAIVE_1001';

    // 1. Initialize order with 0 balance on merchant
    await fetch(`${merchantBaseUrl}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, customerId: 'CUST_A', initialBalancePaisa: 0 })
    });

    // 2. Grant token from simulator
    const grantRes = await fetch(`${simBaseUrl}/tokenized/checkout/token/grant`, {
      method: 'POST'
    });
    const grantData = (await grantRes.json()) as { id_token: string; statusCode: string };
    expect(grantData.statusCode).toBe('0000');
    const token = grantData.id_token;

    // 3. Create payment of 500.00 BDT pointing to merchant's /ipn/naive endpoint
    const createRes = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        amount: '500.00',
        currency: 'BDT',
        intent: 'sale',
        merchantInvoiceNumber: orderId,
        callbackURL: `${merchantBaseUrl}/ipn/naive`
      })
    });
    const createData = (await createRes.json()) as { paymentID: string; statusCode: string };
    expect(createData.statusCode).toBe('0000');
    expect(createData.paymentID).toBeDefined();

    // 4. Execute payment
    const execRes = await fetch(`${simBaseUrl}/tokenized/checkout/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ paymentID: createData.paymentID })
    });
    const execData = (await execRes.json()) as {
      statusCode: string;
      trxID: string;
      transactionStatus: string;
    };
    expect(execData.statusCode).toBe('0000');
    expect(execData.transactionStatus).toBe('Completed');
    expect(execData.trxID).toHaveLength(10);

    // 5. Allow outbox worker to deliver both duplicate webhook requests concurrently
    await worker.processDueRows();

    // Small delay to ensure merchant Fastify finishes updating SQLite
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 6. Verify customer wallet balance was credited TWICE (100,000 paisa = 1000.00 BDT)
    const orderRes = await fetch(`${merchantBaseUrl}/orders/${orderId}`);
    const orderData = (await orderRes.json()) as { balance_paisa: number };

    // PROOF: Double credit occurred because naive handler didn't de-duplicate transactions!
    expect(orderData.balance_paisa).toBe(100000);
  });

  it('demonstrates idempotency protection on /ipn/idempotent under duplicate webhook delivery', async () => {
    const orderId = 'ORD_IDEMPOTENT_2002';

    // 1. Initialize order with 0 balance on merchant
    await fetch(`${merchantBaseUrl}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, customerId: 'CUST_B', initialBalancePaisa: 0 })
    });

    // 2. Grant token from simulator
    const grantRes = await fetch(`${simBaseUrl}/tokenized/checkout/token/grant`, {
      method: 'POST'
    });
    const grantData = (await grantRes.json()) as { id_token: string; statusCode: string };
    expect(grantData.statusCode).toBe('0000');
    const token = grantData.id_token;

    // 3. Create payment of 500.00 BDT pointing to merchant's /ipn/idempotent endpoint
    const createRes = await fetch(`${simBaseUrl}/tokenized/checkout/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        amount: '500.00',
        currency: 'BDT',
        intent: 'sale',
        merchantInvoiceNumber: orderId,
        callbackURL: `${merchantBaseUrl}/ipn/idempotent`
      })
    });
    const createData = (await createRes.json()) as { paymentID: string; statusCode: string };
    expect(createData.statusCode).toBe('0000');
    expect(createData.paymentID).toBeDefined();

    // 4. Execute payment
    const execRes = await fetch(`${simBaseUrl}/tokenized/checkout/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ paymentID: createData.paymentID })
    });
    const execData = (await execRes.json()) as {
      statusCode: string;
      trxID: string;
      transactionStatus: string;
    };
    expect(execData.statusCode).toBe('0000');
    expect(execData.transactionStatus).toBe('Completed');
    expect(execData.trxID).toHaveLength(10);

    // 5. Allow outbox worker to deliver both duplicate webhook requests concurrently
    await worker.processDueRows();

    // Small delay to ensure merchant Fastify finishes updating SQLite
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 6. Verify customer wallet balance was credited EXACTLY ONCE (50,000 paisa = 500.00 BDT)
    const orderRes = await fetch(`${merchantBaseUrl}/orders/${orderId}`);
    const orderData = (await orderRes.json()) as { balance_paisa: number };

    // PROOF: Idempotent handler prevented the duplicate credit!
    expect(orderData.balance_paisa).toBe(50000);
  });
});
