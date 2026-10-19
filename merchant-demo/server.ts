import Fastify, { type FastifyInstance } from 'fastify';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { parseAmountToPaisa } from '../src/core/paisa.js';
import { verifySnsMessage } from '../src/delivery/sns-verifier.js';

export interface MerchantServerOptions {
  dbPath?: string;
  logger?: boolean;
  paysimBaseUrl?: string;
  idToken?: string;
  refreshToken?: string;
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
      status TEXT NOT NULL DEFAULT 'PENDING',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payment_orders (
      payment_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL
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
  setPaysimConfig: (paysimBaseUrl: string, idToken: string, refreshToken?: string) => void;
  getToken: () => string;
  getRefreshToken: () => string;
} {
  const db = createMerchantDatabase(options.dbPath ?? ':memory:');
  const app = Fastify({ logger: options.logger ?? false, forceCloseConnections: true });

  let paysimUrl = options.paysimBaseUrl ?? '';
  let token = options.idToken ?? '';
  let refreshToken = options.refreshToken ?? '';

  const setPaysimConfig = (newUrl: string, newToken: string, newRefreshToken?: string) => {
    paysimUrl = newUrl;
    token = newToken;
    if (newRefreshToken) {
      refreshToken = newRefreshToken;
    }
  };

  // Order management helpers
  app.post<{ Body: { orderId: string; customerId: string; initialBalancePaisa?: number; status?: string } }>(
    '/orders',
    async (req, reply) => {
      const { orderId, customerId, initialBalancePaisa = 0, status = 'PENDING' } = req.body;
      const stmt = db.prepare(`
        INSERT INTO orders (order_id, customer_id, balance_paisa, status, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(order_id) DO UPDATE SET
          balance_paisa = excluded.balance_paisa,
          status = excluded.status,
          updated_at = excluded.updated_at
      `);
      stmt.run(orderId, customerId, initialBalancePaisa, status, Date.now());
      return reply.code(201).send({ orderId, balancePaisa: initialBalancePaisa, status });
    }
  );

  app.post<{ Body: { paymentId: string; orderId: string } }>(
    '/payments/bind',
    async (req, reply) => {
      const { paymentId, orderId } = req.body;
      db.prepare(`
        INSERT INTO payment_orders (payment_id, order_id)
        VALUES (?, ?)
        ON CONFLICT(payment_id) DO UPDATE SET order_id = excluded.order_id
      `).run(paymentId, orderId);
      return reply.code(200).send({ status: 'ok', paymentId, orderId });
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

  // Helper to handle callback redirects in naive or hardened mode
  async function handleCallback(
    req: { query: { paymentID: string; status: string; mode?: string; orderId?: string } },
    reply: any,
    explicitMode?: 'naive' | 'hardened'
  ) {
    const { paymentID, status, orderId: queryOrderId } = req.query;
    const mode = explicitMode ?? (req.query.mode === 'hardened' ? 'hardened' : 'naive');

    // Resolve orderId from query, or payment_orders mapping table
    let resolvedOrderId = queryOrderId;
    if (!resolvedOrderId) {
      const row = db.prepare('SELECT order_id FROM payment_orders WHERE payment_id = ?').get(paymentID) as
        | { order_id: string }
        | undefined;
      if (row) resolvedOrderId = row.order_id;
    }

    let executeResponse: string | null = null;
    let recoveredTrxId: string | null = null;

    if (status === 'success' && paysimUrl && token) {
      if (mode === 'naive') {
        // Naive flow:
        // Calls POST /tokenized/checkout/execute with a 100ms timeout.
        // If /execute times out or returns HTTP 504, marks order as 'FAILED' and does NOT call /payment/status!
        try {
          const res = await fetch(`${paysimUrl}/tokenized/checkout/execute`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({ paymentID }),
            signal: AbortSignal.timeout(100)
          });
          executeResponse = await res.text();
          const parsed = JSON.parse(executeResponse) as {
            statusCode?: string;
            amount?: string;
            trxID?: string;
            merchantInvoiceNumber?: string;
          };

          if (res.ok && parsed.statusCode === '0000') {
            const amountPaisa = parseAmountToPaisa(parsed.amount ?? '0');
            const targetOrder = parsed.merchantInvoiceNumber ?? resolvedOrderId;
            if (targetOrder) {
              // Direct increment without idempotency guard (vulnerable to double-credit!)
              db.prepare(`
                UPDATE orders
                SET balance_paisa = balance_paisa + ?, status = 'COMPLETED', updated_at = ?
                WHERE order_id = ?
              `).run(amountPaisa, Date.now(), targetOrder);
            }
          } else {
            // Execution failed or non-200 / non-0000 -> mark order FAILED
            if (resolvedOrderId) {
              db.prepare(`
                UPDATE orders SET status = 'FAILED', updated_at = ? WHERE order_id = ?
              `).run(Date.now(), resolvedOrderId);
            }
          }
        } catch (err: unknown) {
          executeResponse = JSON.stringify({
            error: err instanceof Error ? err.message : String(err)
          });
          // Timeout or transport failure: naive merchant marks order as FAILED, leaving customer debited in bKash!
          if (resolvedOrderId) {
            db.prepare(`
              UPDATE orders SET status = 'FAILED', updated_at = ? WHERE order_id = ?
            `).run(Date.now(), resolvedOrderId);
          }
        }
      } else {
        // Hardened flow:
        // Calls POST /tokenized/checkout/execute with a 100ms timeout.
        // If /execute times out or returns HTTP 504, falls back to POST /tokenized/checkout/payment/status.
        let executeOk = false;
        let executeData: {
          statusCode?: string;
          amount?: string;
          trxID?: string;
          merchantInvoiceNumber?: string;
        } | null = null;

        try {
          let res = await fetch(`${paysimUrl}/tokenized/checkout/execute`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({ paymentID }),
            signal: AbortSignal.timeout(100)
          });

          // Hardened auto-refresh: on HTTP 401, call /token/refresh and retry once
          if (res.status === 401 && refreshToken) {
            const refreshRes = await fetch(`${paysimUrl}/tokenized/checkout/token/refresh`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ refresh_token: refreshToken })
            });
            if (refreshRes.ok) {
              const refreshData = (await refreshRes.json()) as { id_token?: string; statusCode?: string };
              if (refreshData.statusCode === '0000' && refreshData.id_token) {
                token = refreshData.id_token;
                res = await fetch(`${paysimUrl}/tokenized/checkout/execute`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                  },
                  body: JSON.stringify({ paymentID }),
                  signal: AbortSignal.timeout(100)
                });
              }
            }
          }

          executeResponse = await res.text();
          if (res.ok) {
            executeData = JSON.parse(executeResponse);
            if (executeData?.statusCode === '0000' && executeData.trxID) {
              executeOk = true;
            }
          }
        } catch (err: unknown) {
          executeResponse = JSON.stringify({
            error: err instanceof Error ? err.message : String(err)
          });
        }

        if (executeOk && executeData?.trxID) {
          // Normal execute success: run shared idempotent credit
          const targetOrder = executeData.merchantInvoiceNumber ?? resolvedOrderId;
          const amountPaisa = parseAmountToPaisa(executeData.amount ?? '0');
          if (targetOrder) {
            const txn = db.transaction(() => {
              const insertStmt = db.prepare(`
                INSERT INTO processed_transactions (trx_id, order_id, processed_at)
                VALUES (?, ?, ?)
                ON CONFLICT(trx_id) DO NOTHING
              `);
              const insertResult = insertStmt.run(executeData!.trxID!, targetOrder, Date.now());
              if (insertResult.changes === 1) {
                db.prepare(`
                  UPDATE orders
                  SET balance_paisa = balance_paisa + ?, status = 'COMPLETED', updated_at = ?
                  WHERE order_id = ?
                `).run(amountPaisa, Date.now(), targetOrder);
              } else {
                db.prepare(`
                  UPDATE orders
                  SET status = 'COMPLETED', updated_at = ?
                  WHERE order_id = ?
                `).run(Date.now(), targetOrder);
              }
            });
            txn.immediate();
          }
        } else {
          // FALLBACK RECOVERY: Query /tokenized/checkout/payment/status
          try {
            const statusRes = await fetch(`${paysimUrl}/tokenized/checkout/payment/status`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
              },
              body: JSON.stringify({ paymentID })
            });
            if (statusRes.ok) {
              const statusData = (await statusRes.json()) as {
                statusCode: string;
                transactionStatus: string;
                trxID?: string;
                amount?: string;
                merchantInvoiceNumber?: string;
              };

              if (statusData.statusCode === '0000' && statusData.transactionStatus === 'Completed' && statusData.trxID) {
                recoveredTrxId = statusData.trxID;
                const targetOrder = statusData.merchantInvoiceNumber ?? resolvedOrderId;
                const amountPaisa = parseAmountToPaisa(statusData.amount ?? '0');
                if (targetOrder) {
                  const txn = db.transaction(() => {
                    const insertStmt = db.prepare(`
                      INSERT INTO processed_transactions (trx_id, order_id, processed_at)
                      VALUES (?, ?, ?)
                      ON CONFLICT(trx_id) DO NOTHING
                    `);
                    const insertResult = insertStmt.run(statusData.trxID!, targetOrder, Date.now());
                    if (insertResult.changes === 1) {
                      db.prepare(`
                        UPDATE orders
                        SET balance_paisa = balance_paisa + ?, status = 'COMPLETED', updated_at = ?
                        WHERE order_id = ?
                      `).run(amountPaisa, Date.now(), targetOrder);
                    } else {
                      db.prepare(`
                        UPDATE orders
                        SET status = 'COMPLETED', updated_at = ?
                        WHERE order_id = ?
                      `).run(Date.now(), targetOrder);
                    }
                  });
                  txn.immediate();
                }
              }
            }
          } catch {
            // Ignore status query error
          }
        }
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
      mode,
      executeResponse: executeResponse ? JSON.parse(executeResponse) : null,
      recoveredTrxId
    });
  }

  // GET /bkash/callback: receives browser redirect or simulated callback GET
  app.get<{
    Querystring: { paymentID: string; status: string; mode?: string; orderId?: string };
  }>('/bkash/callback', async (req, reply) => {
    return handleCallback(req, reply);
  });

  app.get<{
    Querystring: { paymentID: string; status: string; orderId?: string };
  }>('/bkash/callback/naive', async (req, reply) => {
    return handleCallback(req, reply, 'naive');
  });

  app.get<{
    Querystring: { paymentID: string; status: string; orderId?: string };
  }>('/bkash/callback/hardened', async (req, reply) => {
    return handleCallback(req, reply, 'hardened');
  });

  // 1. POST /ipn/naive: increments balance WITHOUT idempotency or signature protection
  app.post('/ipn/naive', async (req, reply) => {
    const ipn = extractIpnData(req.body);

    if (ipn.transactionStatus === 'Completed') {
      db.prepare(`
        UPDATE orders
        SET balance_paisa = balance_paisa + ?, status = 'COMPLETED', updated_at = ?
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
            SET balance_paisa = balance_paisa + ?, status = 'COMPLETED', updated_at = ?
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
              SET balance_paisa = balance_paisa + ?, status = 'COMPLETED', updated_at = ?
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

  // Endpoint to demonstrate checkout initiate with auto-refresh (Scenario 5)
  app.post<{
    Body: {
      mode?: 'naive' | 'hardened';
      amount: string;
      orderId: string;
      customerMsisdn?: string;
      payerReference?: string;
    };
  }>('/checkout/create', async (req, reply) => {
    const { mode = 'hardened', amount, orderId, customerMsisdn, payerReference } = req.body;

    const makeCreateCall = async (currentToken: string) => {
      return fetch(`${paysimUrl}/tokenized/checkout/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${currentToken}`,
          'x-paysim-auto-approve': 'success'
        },
        body: JSON.stringify({
          amount,
          merchantInvoiceNumber: orderId,
          payerReference: payerReference ?? `REF_${orderId}`,
          customerMsisdn,
          callbackURL: `${req.headers.host ? `http://${req.headers.host}` : ''}/bkash/callback/${mode}?orderId=${orderId}`
        })
      });
    };

    let res = await makeCreateCall(token);

    if (res.status === 401 && mode === 'hardened' && refreshToken) {
      const refreshRes = await fetch(`${paysimUrl}/tokenized/checkout/token/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken })
      });
      if (refreshRes.ok) {
        const refreshData = (await refreshRes.json()) as { id_token?: string; statusCode?: string };
        if (refreshData.statusCode === '0000' && refreshData.id_token) {
          token = refreshData.id_token;
          res = await makeCreateCall(token);
        }
      }
    }

    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return reply.code(res.status).send(data);
  });

  return {
    app,
    db,
    setPaysimConfig,
    getToken: () => token,
    getRefreshToken: () => refreshToken
  };
}
