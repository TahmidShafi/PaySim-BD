import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { type Database as DatabaseType } from 'better-sqlite3';
import {
  type ChaosRuleRecord,
  type OutboxItemParam,
  insertEvent
} from '../storage/repositories.js';

export interface ChaosMatch {
  payerReferencePrefix?: string;
  customerMsisdn?: string;
  paymentId?: string;
}

export interface PaymentMatchContext {
  paymentId: string;
  payerReference?: string | null;
  customerMsisdn?: string | null;
}

/**
 * Deterministic mulberry32 32-bit PRNG generator.
 * Produces pseudorandom numbers in [0, 1).
 */
export function mulberry32(a: number): () => number {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministically computes an initial 32-bit integer seed from a rule seed and payment ID.
 */
export function hashToSeed(ruleSeed: number | null | undefined, paymentId: string): number {
  const baseSeed = ruleSeed ?? 1337;
  let h = baseSeed ^ 0xdeadbeef;
  for (let i = 0; i < paymentId.length; i++) {
    h = Math.imul(h ^ paymentId.charCodeAt(i), 2654435761);
  }
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Checks if a given payment context satisfies the match criteria in match_json.
 */
export function matchesRule(matchJsonStr: string, context: PaymentMatchContext): boolean {
  try {
    const match = JSON.parse(matchJsonStr) as ChaosMatch;
    if (match.paymentId && match.paymentId !== context.paymentId) {
      return false;
    }
    if (match.customerMsisdn && match.customerMsisdn !== context.customerMsisdn) {
      return false;
    }
    if (match.payerReferencePrefix) {
      if (!context.payerReference || !context.payerReference.startsWith(match.payerReferencePrefix)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Applies Outbox Chaos Hooks during payment execute:
 * - duplicate: creates multiple outbox rows with configured delay and messageId sharing.
 * - delay: delays the next_attempt_at timestamp by delayMs without sleeping.
 * - corrupt-signature: tampers with the message payload or corrupts the base64 signature string.
 */
export function applyOutboxChaosHooks(
  rules: ChaosRuleRecord[],
  context: PaymentMatchContext,
  baseItem: OutboxItemParam,
  nowMs: number
): { outboxItems: OutboxItemParam[]; appliedRule?: ChaosRuleRecord } {
  for (const rule of rules) {
    if (!matchesRule(rule.match_json, context)) {
      continue;
    }

    const prng = mulberry32(hashToSeed(rule.seed, context.paymentId));
    // Consume 1 PRNG step for deterministic reproducibility
    void prng();

    if (rule.action === 'duplicate') {
      const params = JSON.parse(rule.params_json || '{}') as {
        count?: number;
        intervalMs?: number;
        interval_ms?: number;
        sameMessageId?: boolean;
        same_message_id?: boolean;
      };
      const count = params.count ?? 2;
      const intervalMs = params.intervalMs ?? params.interval_ms ?? 0;
      const sameMessageId = params.sameMessageId ?? params.same_message_id ?? true;

      const items: OutboxItemParam[] = [];
      const primaryMessageId = baseItem.sns_message_id;

      for (let i = 0; i < count; i++) {
        items.push({
          sns_message_id: sameMessageId ? primaryMessageId : crypto.randomUUID(),
          sns_type: baseItem.sns_type,
          payload: baseItem.payload,
          signature: baseItem.signature,
          next_attempt_at: nowMs + i * intervalMs
        });
      }

      return { outboxItems: items, appliedRule: rule };
    }

    if (rule.action === 'delay') {
      const params = JSON.parse(rule.params_json || '{}') as { delayMs?: number };
      const delayMs = params.delayMs ?? 1000;

      return {
        outboxItems: [
          {
            ...baseItem,
            next_attempt_at: nowMs + delayMs
          }
        ],
        appliedRule: rule
      };
    }

    if (rule.action === 'corrupt-signature') {
      const params = JSON.parse(rule.params_json || '{}') as {
        mode?: 'tamper-amount' | 'invalid-base64';
      };
      const mode = params.mode ?? 'invalid-base64';

      let corruptedPayload = baseItem.payload;
      let corruptedSignature = baseItem.signature;

      if (mode === 'tamper-amount') {
        try {
          const envelope = JSON.parse(baseItem.payload) as { Message: string };
          if (envelope.Message) {
            const inner = JSON.parse(envelope.Message) as Record<string, unknown>;
            inner['amount'] = '999999.00';
            envelope.Message = JSON.stringify(inner);
            corruptedPayload = JSON.stringify(envelope);
          } else {
            corruptedPayload = baseItem.payload.replace(/"amount":"[^"]+"/, '"amount":"999999.00"');
          }
        } catch {
          corruptedPayload = baseItem.payload + ' ';
        }
      } else {
        // Corrupt signature string
        corruptedSignature = 'INVALID_SIGNATURE_BASE64_CORRUPTED_FOR_TESTS==';
      }

      return {
        outboxItems: [
          {
            ...baseItem,
            payload: corruptedPayload,
            signature: corruptedSignature
          }
        ],
        appliedRule: rule
      };
    }
  }

  // Default: unmodified base item
  return { outboxItems: [baseItem] };
}

export interface PostCommitHookResult {
  timedOut: boolean;
  httpStatus?: number;
  errorPayload?: Record<string, unknown>;
  appliedRule?: ChaosRuleRecord;
}

/**
 * Executes Gateway Post-Commit Hooks strictly AFTER the SQLite transaction commits:
 * - ipn-before-execute: waits for the outbox worker to finish delivering the IPN before returning.
 * - timeout-after-commit: holds the request for holdMs and returns HTTP 504 / timeout, logging the event.
 */
export async function executeGatewayPostCommitHook(
  rules: ChaosRuleRecord[],
  context: PaymentMatchContext,
  db: DatabaseType,
  workerEvents: EventEmitter | undefined,
  nowMs: number,
  ipnDeliveredPromise?: Promise<void>
): Promise<PostCommitHookResult> {
  for (const rule of rules) {
    if (!matchesRule(rule.match_json, context)) {
      continue;
    }

    if (rule.action === 'ipn-before-execute') {
      const params = JSON.parse(rule.params_json || '{}') as { maxWaitMs?: number };
      const maxWaitMs = params.maxWaitMs ?? 1000;

      if (ipnDeliveredPromise) {
        let timer: NodeJS.Timeout;
        const timeoutPromise = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, maxWaitMs);
        });
        await Promise.race([ipnDeliveredPromise, timeoutPromise]);
        clearTimeout(timer!);
      }

      return { timedOut: false, appliedRule: rule };
    }

    if (rule.action === 'timeout-after-commit') {
      const params = JSON.parse(rule.params_json || '{}') as { holdMs?: number };
      const holdMs = params.holdMs ?? 150;

      // Record in events that /execute timed out after commit so UAT linter knows /payment/status is permitted
      insertEvent(db, {
        ts: nowMs,
        kind: 'EXECUTE_TIMEOUT_AFTER_COMMIT',
        payment_id: context.paymentId,
        chaos_applied: JSON.stringify(rule)
      });

      // Hold the request for holdMs
      await new Promise((resolve) => setTimeout(resolve, holdMs));

      return {
        timedOut: true,
        httpStatus: 504,
        errorPayload: {
          statusCode: '504',
          statusMessage: 'Gateway Timeout (Execute timed out after commit)'
        },
        appliedRule: rule
      };
    }
  }

  return { timedOut: false };
}
