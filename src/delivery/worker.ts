import { EventEmitter } from 'node:events';
import { type Database as DatabaseType } from 'better-sqlite3';
import { type Clock } from '../core/clock.js';
import {
  claimDueOutboxRows,
  markOutboxDelivered,
  markOutboxRetry,
  type ClaimedOutboxRow
} from '../storage/repositories.js';

export interface OutboxWorkerOptions {
  db: DatabaseType;
  clock: Clock;
  eventEmitter?: EventEmitter;
  pollIntervalMs?: number;
  leaseDurationMs?: number; // default 30000 (30s)
  maxAttempts?: number;     // default 5
}

export class OutboxWorker {
  private db: DatabaseType;
  private clock: Clock;
  private eventEmitter?: EventEmitter;
  private pollIntervalMs: number;
  private leaseDurationMs: number;
  private maxAttempts: number;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isProcessing = false;
  private wakeListener: () => void;

  constructor(options: OutboxWorkerOptions) {
    this.db = options.db;
    this.clock = options.clock;
    this.eventEmitter = options.eventEmitter;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.leaseDurationMs = options.leaseDurationMs ?? 30000;
    this.maxAttempts = options.maxAttempts ?? 5;

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
   * Claims all due PENDING or RETRY outbox items inside a synchronous SQLite immediate transaction
   * (setting 30s locked_until lease and incrementing attempts), then dispatches them concurrently via Promise.all.
   */
  async processDueRows(): Promise<number> {
    if (this.isProcessing) return 0;
    this.isProcessing = true;

    try {
      const now = this.clock.nowMs();
      const claimedRows = claimDueOutboxRows(this.db, now, this.leaseDurationMs);
      if (claimedRows.length === 0) {
        return 0;
      }

      // Dispatch all claimed rows concurrently using Promise.all
      await Promise.all(
        claimedRows.map(async (row) => {
          await this.dispatchRow(row);
        })
      );

      return claimedRows.length;
    } finally {
      this.isProcessing = false;
    }
  }

  private async dispatchRow(row: ClaimedOutboxRow): Promise<void> {
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

      if (res.ok) {
        markOutboxDelivered(this.db, row.id, res.status);
        if (this.eventEmitter) {
          this.eventEmitter.emit('ipn_delivered', row.payment_id);
        }
      } else {
        const errorText = await res.text().catch(() => '');
        const errorMsg = `HTTP ${res.status}: ${errorText.slice(0, 200)}`;
        const delayMs = Math.min(60000, 1000 * Math.pow(2, row.attempts - 1));
        const isDead = row.attempts >= this.maxAttempts;
        const nextAttemptAt = this.clock.nowMs() + delayMs;
        markOutboxRetry(this.db, row.id, nextAttemptAt, errorMsg, isDead, res.status);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const delayMs = Math.min(60000, 1000 * Math.pow(2, row.attempts - 1));
      const isDead = row.attempts >= this.maxAttempts;
      const nextAttemptAt = this.clock.nowMs() + delayMs;
      markOutboxRetry(this.db, row.id, nextAttemptAt, errMsg, isDead, null);
    }
  }
}
