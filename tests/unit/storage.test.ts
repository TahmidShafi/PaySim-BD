import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabase, runMigrations } from '../../src/storage/db.js';
import {
  insertPayment,
  getPaymentById,
  updatePaymentStatus,
  atomicExecutePaymentWithOutbox,
  getOutboxItemsByPaymentId,
  getEventsByPaymentId,
  type PaymentRecord
} from '../../src/storage/repositories.js';

describe('Storage & Database Layer', () => {
  describe('Database Initialization & PRAGMAs', () => {
    const diskDbPath = path.join(process.cwd(), 'temp-test-wal.db');

    afterEach(() => {
      // Clean up temporary database files
      for (const ext of ['', '-wal', '-shm']) {
        const file = `${diskDbPath}${ext}`;
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      }
    });

    it('enforces WAL mode, busy_timeout 5000, and foreign_keys ON for file databases', () => {
      const db = createDatabase(diskDbPath);
      try {
        const journalMode = db.pragma('journal_mode', { simple: true });
        const busyTimeout = db.pragma('busy_timeout', { simple: true });
        const foreignKeys = db.pragma('foreign_keys', { simple: true });

        expect(journalMode).toBe('wal');
        expect(busyTimeout).toBe(5000);
        expect(foreignKeys).toBe(1);
      } finally {
        db.close();
      }
    });

    it('runs migrations idempotently on in-memory database', () => {
      const db = createDatabase(':memory:');
      try {
        // Run migrations a second time to ensure idempotency
        expect(() => runMigrations(db)).not.toThrow();

        // Verify all 5 required tables exist
        const tables = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
          )
          .all() as Array<{ name: string }>;

        const tableNames = tables.map((t) => t.name);
        expect(tableNames).toContain('payments');
        expect(tableNames).toContain('tokens');
        expect(tableNames).toContain('events');
        expect(tableNames).toContain('ipn_outbox');
        expect(tableNames).toContain('chaos_rules');
      } finally {
        db.close();
      }
    });
  });

  describe('Payment Repository Operations', () => {
    let db: ReturnType<typeof createDatabase>;

    beforeEach(() => {
      db = createDatabase(':memory:');
    });

    afterEach(() => {
      db.close();
    });

    it('inserts and retrieves a payment correctly', () => {
      const payment: PaymentRecord = {
        payment_id: 'PAY_12345',
        invoice: 'INV-001',
        amount_paisa: 50000, // 500.00 BDT
        currency: 'BDT',
        mode: '0011',
        intent: 'sale',
        payer_reference: 'REF-001',
        customer_msisdn: '01770618575',
        callback_url: 'https://merchant.example.com/callback',
        status: 'INITIATED',
        trx_id: null,
        created_at: 1700000000000,
        updated_at: 1700000000000
      };

      insertPayment(db, payment);

      const retrieved = getPaymentById(db, 'PAY_12345');
      expect(retrieved).toBeDefined();
      expect(retrieved?.payment_id).toBe('PAY_12345');
      expect(retrieved?.amount_paisa).toBe(50000);
      expect(retrieved?.status).toBe('INITIATED');
      expect(retrieved?.trx_id).toBeNull();
    });

    it('updates payment status', () => {
      const payment: PaymentRecord = {
        payment_id: 'PAY_12345',
        invoice: 'INV-001',
        amount_paisa: 2050,
        currency: 'BDT',
        mode: '0011',
        intent: 'sale',
        callback_url: 'https://merchant.example.com/callback',
        status: 'INITIATED',
        created_at: 1700000000000,
        updated_at: 1700000000000
      };

      insertPayment(db, payment);
      updatePaymentStatus(db, 'PAY_12345', 'APPROVED', 1700000010000);

      const updated = getPaymentById(db, 'PAY_12345');
      expect(updated?.status).toBe('APPROVED');
      expect(updated?.updated_at).toBe(1700000010000);
    });
  });

  describe('Atomic Payment Transition & Outbox Enqueue (Invariant 4)', () => {
    let db: ReturnType<typeof createDatabase>;

    beforeEach(() => {
      db = createDatabase(':memory:');
    });

    afterEach(() => {
      db.close();
    });

    it('atomically completes payment and inserts into outbox inside BEGIN IMMEDIATE', () => {
      const payment: PaymentRecord = {
        payment_id: 'PAY_ATOMIC_1',
        invoice: 'INV-100',
        amount_paisa: 75000,
        currency: 'BDT',
        mode: '0011',
        intent: 'sale',
        callback_url: 'https://merchant.example.com/callback',
        status: 'APPROVED',
        trx_id: null,
        created_at: 1700000000000,
        updated_at: 1700000000000
      };

      insertPayment(db, payment);

      atomicExecutePaymentWithOutbox(db, {
        paymentId: 'PAY_ATOMIC_1',
        expectedStatus: 'APPROVED',
        newStatus: 'COMPLETED',
        trxId: 'TRX_SUCCESS_001',
        updatedAt: 1700000020000,
        outbox: {
          sns_message_id: 'sns-msg-1',
          sns_type: 'Notification',
          payload: JSON.stringify({ trxID: 'TRX_SUCCESS_001', amount: '750.00' }),
          signature: 'sig-mock-test',
          next_attempt_at: 1700000020000
        },
        event: {
          kind: 'PAYMENT_EXECUTED',
          response: JSON.stringify({ statusCode: '0000', trxID: 'TRX_SUCCESS_001' })
        }
      });

      // Verify payment was updated
      const updatedPayment = getPaymentById(db, 'PAY_ATOMIC_1');
      expect(updatedPayment?.status).toBe('COMPLETED');
      expect(updatedPayment?.trx_id).toBe('TRX_SUCCESS_001');
      expect(updatedPayment?.updated_at).toBe(1700000020000);

      // Verify outbox entry was inserted
      const outboxItems = getOutboxItemsByPaymentId(db, 'PAY_ATOMIC_1');
      expect(outboxItems).toHaveLength(1);
      expect(outboxItems[0]?.status).toBe('PENDING');
      expect(outboxItems[0]?.sns_message_id).toBe('sns-msg-1');

      // Verify event was recorded
      const events = getEventsByPaymentId(db, 'PAY_ATOMIC_1');
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('PAYMENT_EXECUTED');
    });

    it('rolls back atomic transaction when expected status does not match', () => {
      const payment: PaymentRecord = {
        payment_id: 'PAY_ATOMIC_FAIL_STATUS',
        invoice: 'INV-200',
        amount_paisa: 10000,
        currency: 'BDT',
        mode: '0011',
        intent: 'sale',
        callback_url: 'https://merchant.example.com/callback',
        status: 'INITIATED', // NOT APPROVED!
        trx_id: null,
        created_at: 1700000000000,
        updated_at: 1700000000000
      };

      insertPayment(db, payment);

      expect(() => {
        atomicExecutePaymentWithOutbox(db, {
          paymentId: 'PAY_ATOMIC_FAIL_STATUS',
          expectedStatus: 'APPROVED',
          newStatus: 'COMPLETED',
          trxId: 'TRX_FAIL_001',
          updatedAt: 1700000030000,
          outbox: {
            sns_message_id: 'sns-msg-fail',
            sns_type: 'Notification',
            payload: '{}',
            signature: 'sig',
            next_attempt_at: 1700000030000
          }
        });
      }).toThrow(/Cannot execute payment in status "INITIATED"/);

      // Verify rollback: payment remains INITIATED, trx_id is null, no outbox row
      const currentPayment = getPaymentById(db, 'PAY_ATOMIC_FAIL_STATUS');
      expect(currentPayment?.status).toBe('INITIATED');
      expect(currentPayment?.trx_id).toBeNull();

      const outboxItems = getOutboxItemsByPaymentId(db, 'PAY_ATOMIC_FAIL_STATUS');
      expect(outboxItems).toHaveLength(0);
    });

    it('rolls back atomic transaction on unique constraint violation for trx_id', () => {
      // First payment completed with trx_id = 'DUPLICATE_TRX'
      const payment1: PaymentRecord = {
        payment_id: 'PAY_FIRST',
        invoice: 'INV-1',
        amount_paisa: 1000,
        currency: 'BDT',
        mode: '0011',
        intent: 'sale',
        callback_url: 'https://merchant.example.com/callback',
        status: 'APPROVED',
        trx_id: null,
        created_at: 1700000000000,
        updated_at: 1700000000000
      };
      insertPayment(db, payment1);

      atomicExecutePaymentWithOutbox(db, {
        paymentId: 'PAY_FIRST',
        expectedStatus: 'APPROVED',
        newStatus: 'COMPLETED',
        trxId: 'DUPLICATE_TRX',
        updatedAt: 1700000010000,
        outbox: {
          sns_message_id: 'sns-msg-first',
          sns_type: 'Notification',
          payload: '{}',
          signature: 'sig',
          next_attempt_at: 1700000010000
        }
      });

      // Second payment in APPROVED status attempts to use the same trx_id
      const payment2: PaymentRecord = {
        payment_id: 'PAY_SECOND',
        invoice: 'INV-2',
        amount_paisa: 2000,
        currency: 'BDT',
        mode: '0011',
        intent: 'sale',
        callback_url: 'https://merchant.example.com/callback',
        status: 'APPROVED',
        trx_id: null,
        created_at: 1700000000000,
        updated_at: 1700000000000
      };
      insertPayment(db, payment2);

      expect(() => {
        atomicExecutePaymentWithOutbox(db, {
          paymentId: 'PAY_SECOND',
          expectedStatus: 'APPROVED',
          newStatus: 'COMPLETED',
          trxId: 'DUPLICATE_TRX', // Triggers UNIQUE constraint failure on payments.trx_id
          updatedAt: 1700000020000,
          outbox: {
            sns_message_id: 'sns-msg-second',
            sns_type: 'Notification',
            payload: '{}',
            signature: 'sig',
            next_attempt_at: 1700000020000
          }
        });
      }).toThrow(/UNIQUE constraint failed/);

      // Verify rollback: second payment is STILL APPROVED, trx_id is null, outbox has NO row for PAY_SECOND
      const secondPayment = getPaymentById(db, 'PAY_SECOND');
      expect(secondPayment?.status).toBe('APPROVED');
      expect(secondPayment?.trx_id).toBeNull();

      const outboxItems = getOutboxItemsByPaymentId(db, 'PAY_SECOND');
      expect(outboxItems).toHaveLength(0);
    });
  });
});
