import Fastify, { type FastifyInstance } from 'fastify';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { parseAmountToPaisa } from '../src/core/paisa.js';
import { verifySnsMessage } from '../src/delivery/sns-verifier.js';

export interface MerchantServerOptions {
  dbPath?: string;
  logger?: boolean;
  paysimBaseUrl?: string;
  idToken?: string;
}

export function createMerchantDatabase(dbPath: string = ':memory:'): DatabaseType {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      balance_paisa INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processed_transactions (
      trx_id TEXT PRIMARY KEY,
      order_id TEXT,
      processed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS callback_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id TEXT NOT NULL,
      status TEXT NOT NULL,
      execute_response TEXT,
      received_at INTEGER NOT NULL
    );
  `);

  return db;
}

interface ParsedIpn {
  trxID: string;
  transactionStatus: string;
  amountPaisa: number;
  orderId: string;
}

function extractIpnData(body: unknown): ParsedIpn {
  const raw =
    typeof body === 'string'
      ? (JSON.parse(body) as Record<string, unknown>)
      : (body as Record<string, unknown>);
  let message: Record<string, unknown> = raw;

  if (raw['Message']) {
    message =
      typeof raw['Message'] === 'string'
        ? (JSON.parse(raw['Message']) as Record<string, unknown>)
        : (raw['Message'] as Record<string, unknown>);
  }

  const trxID = String(message['trxID'] ?? '');
  const transactionStatus = String(message['transactionStatus'] ?? '');
  const amountStr = String(message['amount'] ?? '0');
  const orderId = String(message['merchantInvoiceNumber'] ?? 'DEFAULT_ORDER');

  return {
    trxID,
    transactionStatus,
    amountPaisa: parseAmountToPaisa(amountStr),
    orderId
  };
}

export function createMerchantServer(options: MerchantServerOptions = {}): {
  app: FastifyInstance;
  db: DatabaseType;
  setPaysimConfig: (paysimBaseUrl: string, idToken: string) => void;
} {
  const db = createMerchantDatabase(options.dbPath ?? ':memory:');
  const app = Fastify({ logger: options.logger ?? false });

  let paysimUrl = options.paysimBaseUrl ?? '';
  let token = options.idToken ?? '';

  const setPaysimConfig = (newUrl: string, newToken: string) => {
    paysimUrl = newUrl;
    token = newToken;
  };

  // Order management helpers
  app.post<{ Body: { orderId: string; customerId: string; initialBalancePaisa?: number } }>(
    '/orders',
    async (req, reply) => {
      const { orderId, customerId, initialBalancePaisa = 0 } = req.body;
      const stmt = db.prepare(`
        INSERT INTO orders (order_id, customer_id, balance_paisa, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(order_id) DO UPDATE SET balance_paisa = excluded.balance_paisa
      `);
      stmt.run(orderId, customerId, initialBalancePaisa, Date.now());
      return reply.code(201).send({ orderId, balancePaisa: initialBalancePaisa });
    }
  );

  app.get<{ Params: { orderId: string } }>('/orders/:orderId', async (req, reply) => {
    const row = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(req.params.orderId) as
      | { order_id: string; customer_id: string; balance_paisa: number }
      | undefined;

    if (!row) {
      return reply.code(404).send({ error: 'Order not found' });
    }
    return reply.send(row);
  });

  // GET /bkash/callback: receives browser redirect or simulated callback GET
  app.get<{
    Querystring: { paymentID: string; status: string };
  }>('/bkash/callback', async (req, reply) => {
    const { paymentID, status } = req.query;

    let executeResponse: string | null = null;

    // When status === 'success', automatically call execute on PaySim-BD
    if (status === 'success' && paysimUrl && token) {
      try {
        const res = await fetch(`${paysimUrl}/tokenized/checkout/execute`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ paymentID })
        });
        executeResponse = await res.text();
      } catch (err: unknown) {
        executeResponse = JSON.stringify({
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    db.prepare(`
      INSERT INTO callback_events (payment_id, status, execute_response, received_at)
      VALUES (?, ?, ?, ?)
    `).run(paymentID, status, executeResponse, Date.now());

    return reply.code(200).send({
      status: 'ok',
      paymentID,
      callbackStatus: status,
      executeResponse: executeResponse ? JSON.parse(executeResponse) : null
    });
  });

  // 1. POST /ipn/naive: increments balance WITHOUT idempotency or signature protection
  app.post('/ipn/naive', async (req, reply) => {
    const ipn = extractIpnData(req.body);

    if (ipn.transactionStatus === 'Completed') {
      db.prepare(`
        UPDATE orders
        SET balance_paisa = balance_paisa + ?, updated_at = ?
        WHERE order_id = ?
      `).run(ipn.amountPaisa, Date.now(), ipn.orderId);
    }

    return reply.code(200).send({ status: 'ok', mode: 'naive' });
  });

  // 2. POST /ipn/idempotent: uses processed_transactions table with atomic conflict guard
  app.post('/ipn/idempotent', async (req, reply) => {
    const ipn = extractIpnData(req.body);

    let credited = false;
    if (ipn.transactionStatus === 'Completed') {
      const txn = db.transaction(() => {
        const insertStmt = db.prepare(`
          INSERT INTO processed_transactions (trx_id, order_id, processed_at)
          VALUES (?, ?, ?)
          ON CONFLICT(trx_id) DO NOTHING
        `);

        const insertResult = insertStmt.run(ipn.trxID, ipn.orderId, Date.now());

        // Only credit order wallet if the transaction has not been processed previously
        if (insertResult.changes === 1) {
          db.prepare(`
            UPDATE orders
            SET balance_paisa = balance_paisa + ?, updated_at = ?
            WHERE order_id = ?
          `).run(ipn.amountPaisa, Date.now(), ipn.orderId);
          credited = true;
        }
      });

      txn.immediate();
    }

    return reply.code(200).send({
      status: 'ok',
      mode: 'idempotent',
      credited
    });
  });

  // 3. POST /ipn/hardened: validates AWS SNS RSA-SHA1 signature and confirms subscriptions
  app.post('/ipn/hardened', async (req, reply) => {
    const rawBody =
      typeof req.body === 'string'
        ? (JSON.parse(req.body) as Record<string, unknown>)
        : (req.body as Record<string, unknown>);

    const verifyResult = await verifySnsMessage(rawBody, {
      allowedCertHosts: ['localhost', '127.0.0.1']
    });

    if (!verifyResult.valid) {
      return reply.code(400).send({
        error: 'Invalid SNS signature',
        details: verifyResult.error
      });
    }

    const messageType = String(
      req.headers['x-amz-sns-message-type'] ?? rawBody['Type'] ?? ''
    );

    // Handshake: automatically visit SubscribeURL on SubscriptionConfirmation
    if (messageType === 'SubscriptionConfirmation') {
      const subscribeUrl = String(rawBody['SubscribeURL'] ?? '');
      if (subscribeUrl) {
        try {
          await fetch(subscribeUrl, { method: 'GET' });
        } catch (err: unknown) {
          return reply.code(500).send({
            error: 'Failed to visit SubscribeURL',
            details: err instanceof Error ? err.message : String(err)
          });
        }
      }
      return reply.code(200).send({ status: 'subscription_confirmed' });
    }

    // Payment notification: verify and run idempotent transaction
    if (messageType === 'Notification') {
      const ipn = extractIpnData(rawBody);
      let credited = false;

      if (ipn.transactionStatus === 'Completed') {
        const txn = db.transaction(() => {
          const insertStmt = db.prepare(`
            INSERT INTO processed_transactions (trx_id, order_id, processed_at)
            VALUES (?, ?, ?)
            ON CONFLICT(trx_id) DO NOTHING
          `);

          const insertResult = insertStmt.run(ipn.trxID, ipn.orderId, Date.now());

          if (insertResult.changes === 1) {
            db.prepare(`
              UPDATE orders
              SET balance_paisa = balance_paisa + ?, updated_at = ?
              WHERE order_id = ?
            `).run(ipn.amountPaisa, Date.now(), ipn.orderId);
            credited = true;
          }
        });

        txn.immediate();
      }

      return reply.code(200).send({
        status: 'ok',
        mode: 'hardened',
        credited
      });
    }

    return reply.code(200).send({ status: 'ignored', type: messageType });
  });

  return { app, db, setPaysimConfig };
}
