import { EventEmitter } from 'node:events';
import { type Database as DatabaseType } from 'better-sqlite3';
import { type Clock } from '../core/clock.js';

export interface OutboxWorkerOptions {
  db: DatabaseType;
  clock: Clock;
  eventEmitter?: EventEmitter;
  pollIntervalMs?: number;
}

export interface DueOutboxRow {
  id: number;
  payment_id: string;
  sns_message_id: string;
  sns_type: string;
  payload: string;
  signature: string;
  attempts: number;
  callback_url: string;
  next_attempt_at: number;
}

export class OutboxWorker {
  private db: DatabaseType;
  private clock: Clock;
  private eventEmitter?: EventEmitter;
  private pollIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isProcessing = false;
  private wakeListener: () => void;

  constructor(options: OutboxWorkerOptions) {
    this.db = options.db;
    this.clock = options.clock;
    this.eventEmitter = options.eventEmitter;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;

    this.wakeListener = () => {
      void this.processDueRows();
    };
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    if (this.eventEmitter) {
      this.eventEmitter.on('wake', this.wakeListener);
    }

    if (this.pollIntervalMs > 0) {
      this.timer = setInterval(() => {
        void this.processDueRows();
      }, this.pollIntervalMs);
    }
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.eventEmitter) {
      this.eventEmitter.off('wake', this.wakeListener);
    }
  }

  /**
   * Reads all due PENDING outbox items and dispatches them via Promise.all.
   * If multiple rows are due at the same timestamp (e.g. interval_ms = 0),
   * they fire concurrently.
   */
  async processDueRows(): Promise<number> {
    if (this.isProcessing) return 0;
    this.isProcessing = true;

    try {
      const now = this.clock.nowMs();
      const stmt = this.db.prepare(`
        SELECT o.id, o.payment_id, o.sns_message_id, o.sns_type, o.payload, o.signature,
               o.attempts, o.next_attempt_at, p.callback_url
        FROM ipn_outbox o
        JOIN payments p ON o.payment_id = p.payment_id
        WHERE o.status = 'PENDING'
          AND o.next_attempt_at <= ?
        ORDER BY o.next_attempt_at ASC, o.id ASC
      `);

      const dueRows = stmt.all(now) as DueOutboxRow[];
      if (dueRows.length === 0) {
        return 0;
      }

      // Mark all due rows as in-flight / PROCESSING to avoid double selection in overlapping polls
      const markStmt = this.db.prepare(`
        UPDATE ipn_outbox
        SET status = 'PROCESSING'
        WHERE id = ? AND status = 'PENDING'
      `);

      const validRows: DueOutboxRow[] = [];
      for (const row of dueRows) {
        const res = markStmt.run(row.id);
        if (res.changes === 1) {
          validRows.push(row);
        }
      }

      // Dispatch all valid due rows concurrently using Promise.all
      await Promise.all(
        validRows.map(async (row) => {
          await this.dispatchRow(row);
        })
      );

      return validRows.length;
    } finally {
      this.isProcessing = false;
    }
  }

  private async dispatchRow(row: DueOutboxRow): Promise<void> {
    try {
      const res = await fetch(row.callback_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-amz-sns-message-type': row.sns_type,
          'x-amz-sns-message-id': row.sns_message_id
        },
        body: row.payload
      });

      const isDelivered = res.ok;
      this.db
        .prepare(`
          UPDATE ipn_outbox
          SET attempts = attempts + 1,
              last_http_status = ?,
              status = ?,
              last_error = NULL
          WHERE id = ?
        `)
        .run(res.status, isDelivered ? 'DELIVERED' : 'FAILED', row.id);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.db
        .prepare(`
          UPDATE ipn_outbox
          SET attempts = attempts + 1,
              last_http_status = NULL,
              status = 'FAILED',
              last_error = ?
          WHERE id = ?
        `)
        .run(errMsg, row.id);
    }
  }
}
