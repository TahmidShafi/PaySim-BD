import Fastify, { type FastifyInstance } from 'fastify';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { parseAmountToPaisa } from '../src/core/paisa.js';

export interface MerchantServerOptions {
  dbPath?: string;
  logger?: boolean;
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
  const raw = typeof body === 'string' ? (JSON.parse(body) as Record<string, unknown>) : (body as Record<string, unknown>);
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
} {
  const db = createMerchantDatabase(options.dbPath ?? ':memory:');
  const app = Fastify({ logger: options.logger ?? false });

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

  // 1. POST /ipn/naive: increments balance WITHOUT idempotency protection
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

  return { app, db };
}
