import { type Database as DatabaseType } from 'better-sqlite3';

export type UatRuleKind =
  | 'UAT_RULE_1_REDUNDANT_TOKEN_GRANT'
  | 'UAT_RULE_2_EXECUTE_WITHOUT_SUCCESS_CALLBACK'
  | 'UAT_RULE_4_UNNECESSARY_QUERY_STATUS';

export interface UatViolationReport {
  id: number;
  ts: number;
  paymentId?: string | null;
  rule: UatRuleKind;
  actionPoint: string;
  title: string;
  description: string;
  remediation: string;
  requestSnippet?: string | null;
  responseSnippet?: string | null;
}

export const UAT_RULE_METADATA: Record<
  UatRuleKind,
  { actionPoint: string; title: string; description: string; remediation: string }
> = {
  UAT_RULE_1_REDUNDANT_TOKEN_GRANT: {
    actionPoint: 'Action Point #0',
    title: 'Redundant Token Grant (id_token not reused for 1 hour)',
    description:
      'bKash requires merchants to reuse the issued id_token for 1 hour for subsequent API requests for any number of payment gateway users. A new token was requested while an active, unexpired id_token already exists.',
    remediation:
      'Cache id_token in memory or storage and reuse id_token for 1 hour across requests. Only request a new token when no valid token exists, and call /token/refresh when id_token expires.'
  },
  UAT_RULE_2_EXECUTE_WITHOUT_SUCCESS_CALLBACK: {
    actionPoint: 'Action Point #2',
    title: 'Execute Called Without Customer Success Callback',
    description:
      'The execute API was invoked on a payment that was not in APPROVED state. In bKash checkout, execute API must only and only be called after the user approves with OTP/PIN and bKash redirects to callbackURL with status=success.',
    remediation:
      'Do not call /tokenized/checkout/execute directly after create. Wait for the browser redirect to callbackURL with status=success, and execute inside that callback handler.'
  },
  UAT_RULE_4_UNNECESSARY_QUERY_STATUS: {
    actionPoint: 'Action Point #4',
    title: 'Unnecessary Query Payment Status Call',
    description:
      'Query payment (/tokenized/checkout/payment/status) was invoked after execute API already returned a successful response without timeout. In bKash protocol, query payment should only be called if there is no response from execute API.',
    remediation:
      'Remove /tokenized/checkout/payment/status from the standard payment flow. Only invoke it inside error/timeout catch blocks when /execute fails or times out.'
  }
};

/**
 * Inspects SQLite events table for all recorded UAT violations.
 */
export function checkUatViolations(
  db: DatabaseType,
  options?: { paymentId?: string }
): UatViolationReport[] {
  let query = `
    SELECT id, ts, kind, payment_id, request, response
    FROM events
    WHERE kind LIKE 'UAT_RULE_%'
  `;
  const params: unknown[] = [];

  if (options?.paymentId) {
    query += ' AND payment_id = ?';
    params.push(options.paymentId);
  }

  query += ' ORDER BY ts ASC, id ASC';

  const rows = db.prepare(query).all(...params) as Array<{
    id: number;
    ts: number;
    kind: string;
    payment_id: string | null;
    request: string | null;
    response: string | null;
  }>;

  return rows.map((r) => {
    const kind = r.kind as UatRuleKind;
    const meta = UAT_RULE_METADATA[kind] ?? {
      actionPoint: 'Unknown Action Point',
      title: kind,
      description: 'Unspecified UAT violation recorded.',
      remediation: 'Review bKash UAT technical acceptance documentation.'
    };

    return {
      id: r.id,
      ts: r.ts,
      paymentId: r.payment_id,
      rule: kind,
      actionPoint: meta.actionPoint,
      title: meta.title,
      description: meta.description,
      remediation: meta.remediation,
      requestSnippet: r.request,
      responseSnippet: r.response
    };
  });
}

/**
 * Formats UAT violations into a human-readable ASCII terminal report.
 */
export function formatUatViolationsReport(violations: UatViolationReport[]): string {
  const lines: string[] = [];
  lines.push('================================================================================');
  lines.push('                      PAYSIM-BD UAT COMPLIANCE AUDIT REPORT                     ');
  lines.push('================================================================================');

  if (violations.length === 0) {
    lines.push('');
    lines.push('  [PASS] 0 UAT violations detected.');
    lines.push('  All integration calls comply with verified bKash Technical Acceptance Rules.');
    lines.push('');
    lines.push('================================================================================');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`  [FAIL] ${violations.length} UAT compliance violation(s) detected!`);
  lines.push('');

  violations.forEach((v, idx) => {
    const timeIso = new Date(v.ts).toISOString();
    lines.push(`--------------------------------------------------------------------------------`);
    lines.push(` Violation #${idx + 1}: ${v.title}`);
    lines.push(` Ref: ${v.actionPoint} (${v.rule})`);
    lines.push(` Time: ${timeIso} | Payment ID: ${v.paymentId ?? 'N/A'}`);
    lines.push('');
    lines.push(` Problem:`);
    lines.push(`   ${v.description}`);
    lines.push('');
    lines.push(` Remediation:`);
    lines.push(`   ${v.remediation}`);
    lines.push('');
  });

  lines.push('================================================================================');
  lines.push(` Result: FAILED (${violations.length} violation(s))`);
  lines.push('================================================================================');

  return lines.join('\n');
}

/**
 * Formats a clean chronological timeline table of events for a payment (or all recent events).
 */
export function formatTimelineTable(db: DatabaseType, paymentId?: string): string {
  let query = `
    SELECT id, ts, kind, payment_id, chaos_applied, request, response
    FROM events
  `;
  const params: unknown[] = [];
  if (paymentId) {
    query += ' WHERE payment_id = ?';
    params.push(paymentId);
  }
  query += ' ORDER BY ts ASC, id ASC LIMIT 50';

  const events = db.prepare(query).all(...params) as Array<{
    id: number;
    ts: number;
    kind: string;
    payment_id: string | null;
    chaos_applied: string | null;
    request: string | null;
    response: string | null;
  }>;

  if (events.length === 0) {
    return 'No events recorded in database.';
  }

  const lines: string[] = [];
  lines.push('---------------------------------------------------------------------------------------------------------');
  lines.push(
    `| ${'Timestamp (ISO)'.padEnd(24)} | ${'Kind / Event'.padEnd(38)} | ${'Payment ID'.padEnd(20)} | ${'Details'.padEnd(12)} |`
  );
  lines.push('---------------------------------------------------------------------------------------------------------');

  for (const e of events) {
    const timeIso = new Date(e.ts).toISOString();
    const kind = e.kind.slice(0, 38).padEnd(38);
    const pid = (e.payment_id ?? '-').slice(0, 20).padEnd(20);
    const details = e.chaos_applied ? 'Chaos' : e.kind.startsWith('UAT_') ? 'UAT Error' : 'Normal';
    lines.push(`| ${timeIso.padEnd(24)} | ${kind} | ${pid} | ${details.padEnd(12)} |`);
  }
  lines.push('---------------------------------------------------------------------------------------------------------');

  return lines.join('\n');
}
