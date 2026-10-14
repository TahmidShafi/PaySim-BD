import { type Database as DatabaseType } from 'better-sqlite3';

export interface PaymentRecord {
  payment_id: string;
  invoice: string;
  amount_paisa: number;
  currency: string;
  mode: string;
  intent: string;
  payer_reference?: string | null;
  customer_msisdn?: string | null;
  callback_url: string;
  status: string;
  trx_id?: string | null;
  created_at: number;
  updated_at: number;
}

export interface IpnOutboxRecord {
  id?: number;
  payment_id: string;
  sns_message_id: string;
  sns_type: string;
  payload: string;
  signature: string;
  attempts?: number;
  next_attempt_at: number;
  locked_until?: number;
  last_http_status?: number | null;
  last_error?: string | null;
  status?: string;
}

export interface EventRecord {
  id?: number;
  ts: number;
  kind: string;
  payment_id?: string | null;
  request?: string | null;
  response?: string | null;
  chaos_applied?: string | null;
}

export interface AtomicExecutePaymentParams {
  paymentId: string;
  expectedStatus?: string; // default: 'APPROVED'
  newStatus: string;       // default: 'COMPLETED'
  trxId: string;
  updatedAt: number;
  outbox: {
    sns_message_id: string;
    sns_type: string;
    payload: string;
    signature: string;
    next_attempt_at: number;
  };
  event?: {
    kind: string;
    request?: string;
    response?: string;
    chaos_applied?: string;
  };
}

export function insertPayment(db: DatabaseType, payment: PaymentRecord): void {
  const stmt = db.prepare(`
    INSERT INTO payments (
      payment_id, invoice, amount_paisa, currency, mode, intent,
      payer_reference, customer_msisdn, callback_url, status, trx_id,
      created_at, updated_at
    ) VALUES (
      @payment_id, @invoice, @amount_paisa, @currency, @mode, @intent,
      @payer_reference, @customer_msisdn, @callback_url, @status, @trx_id,
      @created_at, @updated_at
    )
  `);

  stmt.run({
    payment_id: payment.payment_id,
    invoice: payment.invoice,
    amount_paisa: payment.amount_paisa,
    currency: payment.currency ?? 'BDT',
    mode: payment.mode ?? '0011',
    intent: payment.intent ?? 'sale',
    payer_reference: payment.payer_reference ?? null,
    customer_msisdn: payment.customer_msisdn ?? null,
    callback_url: payment.callback_url,
    status: payment.status,
    trx_id: payment.trx_id ?? null,
    created_at: payment.created_at,
    updated_at: payment.updated_at
  });
}

export function getPaymentById(db: DatabaseType, paymentId: string): PaymentRecord | undefined {
  const stmt = db.prepare('SELECT * FROM payments WHERE payment_id = ?');
  return stmt.get(paymentId) as PaymentRecord | undefined;
}

export function updatePaymentStatus(
  db: DatabaseType,
  paymentId: string,
  status: string,
  updatedAt: number,
  trxId?: string | null
): void {
  const stmt = db.prepare(`
    UPDATE payments
    SET status = ?, trx_id = COALESCE(?, trx_id), updated_at = ?
    WHERE payment_id = ?
  `);
  stmt.run(status, trxId ?? null, updatedAt, paymentId);
}

/**
 * Atomically transitions a payment from APPROVED to COMPLETED with its trx_id,
 * and enqueues an ipn_outbox record inside a synchronous BEGIN IMMEDIATE transaction.
 *
 * Invariant 4:
 * State transitions and outbox insertions MUST happen inside a single synchronous
 * db.transaction(...) using BEGIN IMMEDIATE.
 */
export function atomicExecutePaymentWithOutbox(
  db: DatabaseType,
  params: AtomicExecutePaymentParams
): void {
  const expectedStatus = params.expectedStatus ?? 'APPROVED';

  const txn = db.transaction(() => {
    const payment = db
      .prepare('SELECT status, trx_id FROM payments WHERE payment_id = ?')
      .get(params.paymentId) as { status: string; trx_id: string | null } | undefined;

    if (!payment) {
      throw new Error(`Payment with ID "${params.paymentId}" not found`);
    }

    if (payment.status !== expectedStatus) {
      throw new Error(
        `Cannot execute payment in status "${payment.status}". Expected status is "${expectedStatus}".`
      );
    }

    const updateStmt = db.prepare(`
      UPDATE payments
      SET status = ?, trx_id = ?, updated_at = ?
      WHERE payment_id = ?
    `);
    const updateResult = updateStmt.run(params.newStatus, params.trxId, params.updatedAt, params.paymentId);
    if (updateResult.changes !== 1) {
      throw new Error(`Failed to update payment status for ID "${params.paymentId}"`);
    }

    const outboxStmt = db.prepare(`
      INSERT INTO ipn_outbox (
        payment_id, sns_message_id, sns_type, payload, signature,
        attempts, next_attempt_at, locked_until, status
      ) VALUES (
        ?, ?, ?, ?, ?, 0, ?, 0, 'PENDING'
      )
    `);
    outboxStmt.run(
      params.paymentId,
      params.outbox.sns_message_id,
      params.outbox.sns_type,
      params.outbox.payload,
      params.outbox.signature,
      params.outbox.next_attempt_at
    );

    if (params.event) {
      const eventStmt = db.prepare(`
        INSERT INTO events (ts, kind, payment_id, request, response, chaos_applied)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      eventStmt.run(
        params.updatedAt,
        params.event.kind,
        params.paymentId,
        params.event.request ?? null,
        params.event.response ?? null,
        params.event.chaos_applied ?? null
      );
    }
  });

  txn.immediate();
}

export function getOutboxItemsByPaymentId(
  db: DatabaseType,
  paymentId: string
): IpnOutboxRecord[] {
  const stmt = db.prepare('SELECT * FROM ipn_outbox WHERE payment_id = ? ORDER BY id ASC');
  return stmt.all(paymentId) as IpnOutboxRecord[];
}

export function getEventsByPaymentId(
  db: DatabaseType,
  paymentId: string
): EventRecord[] {
  const stmt = db.prepare('SELECT * FROM events WHERE payment_id = ? ORDER BY id ASC');
  return stmt.all(paymentId) as EventRecord[];
}
