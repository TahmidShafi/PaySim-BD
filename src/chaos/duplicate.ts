import crypto from 'node:crypto';
import { type OutboxItemParam } from '../storage/repositories.js';

export interface DuplicateChaosRule {
  type: 'duplicate';
  count: number;
  interval_ms: number;
  same_message_id?: boolean;
}

export interface BuildOutboxItemsParams {
  basePayload: string;
  signature?: string;
  snsType?: string;
  nowMs: number;
  chaosRule?: DuplicateChaosRule | null;
}

/**
 * Builds one or more outbox items for an IPN notification.
 * If a duplicate chaos rule is configured, produces `rule.count` entries
 * spaced by `rule.interval_ms` (when interval_ms: 0, timestamps are identical).
 */
export function buildOutboxItems(params: BuildOutboxItemsParams): OutboxItemParam[] {
  const {
    basePayload,
    signature = 'mock-sig-milestone1',
    snsType = 'Notification',
    nowMs,
    chaosRule
  } = params;

  if (!chaosRule || chaosRule.type !== 'duplicate' || chaosRule.count <= 1) {
    return [
      {
        sns_message_id: crypto.randomUUID(),
        sns_type: snsType,
        payload: basePayload,
        signature,
        next_attempt_at: nowMs
      }
    ];
  }

  const items: OutboxItemParam[] = [];
  const primaryMessageId = crypto.randomUUID();
  const sameMessageId = chaosRule.same_message_id ?? true;

  for (let i = 0; i < chaosRule.count; i++) {
    items.push({
      sns_message_id: sameMessageId ? primaryMessageId : crypto.randomUUID(),
      sns_type: snsType,
      payload: basePayload,
      signature,
      next_attempt_at: nowMs + i * chaosRule.interval_ms
    });
  }

  return items;
}
