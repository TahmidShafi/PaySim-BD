import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../../src/storage/db.js';
import { insertEvent } from '../../src/storage/repositories.js';
import {
  checkUatViolations,
  formatUatViolationsReport,
  formatTimelineTable,
  type UatViolationReport
} from '../../src/linter/uat-linter.js';
import { program } from '../../src/cli/index.js';

describe('Unit & CLI Viewer: UAT Linter & Timeline Formatter (Day 18)', () => {
  let db: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('detects all 3 UAT compliance rules from recorded events table', () => {
    const now = 1700000000000;

    // 1. Record Rule 1: Redundant Token Grant
    insertEvent(db, {
      ts: now,
      kind: 'UAT_RULE_1_REDUNDANT_TOKEN_GRANT',
      request: JSON.stringify({}),
      response: JSON.stringify({ message: 'Token already active' })
    });

    // 2. Record Rule 2: Execute called without success callback
    insertEvent(db, {
      ts: now + 1000,
      kind: 'UAT_RULE_2_EXECUTE_WITHOUT_SUCCESS_CALLBACK',
      payment_id: 'TR_TEST_101',
      request: JSON.stringify({ paymentID: 'TR_TEST_101' }),
      response: JSON.stringify({ statusCode: '2029' })
    });

    // 3. Record Rule 4: Unnecessary Query Status
    insertEvent(db, {
      ts: now + 2000,
      kind: 'UAT_RULE_4_UNNECESSARY_QUERY_STATUS',
      payment_id: 'TR_TEST_102',
      request: JSON.stringify({ paymentID: 'TR_TEST_102' }),
      response: JSON.stringify({ message: 'Queried after successful execute' })
    });

    // Non-violation event
    insertEvent(db, {
      ts: now + 3000,
      kind: 'PAYMENT_EXECUTED',
      payment_id: 'TR_TEST_102'
    });

    const allViolations = checkUatViolations(db);
    expect(allViolations).toHaveLength(3);

    expect(allViolations[0]?.rule).toBe('UAT_RULE_1_REDUNDANT_TOKEN_GRANT');
    expect(allViolations[0]?.actionPoint).toBe('Action Point #0');
    expect(allViolations[0]?.remediation).toContain('reuse id_token for 1 hour');

    expect(allViolations[1]?.rule).toBe('UAT_RULE_2_EXECUTE_WITHOUT_SUCCESS_CALLBACK');
    expect(allViolations[1]?.actionPoint).toBe('Action Point #2');
    expect(allViolations[1]?.paymentId).toBe('TR_TEST_101');

    expect(allViolations[2]?.rule).toBe('UAT_RULE_4_UNNECESSARY_QUERY_STATUS');
    expect(allViolations[2]?.actionPoint).toBe('Action Point #4');
    expect(allViolations[2]?.paymentId).toBe('TR_TEST_102');

    // Test paymentId filter
    const filtered = checkUatViolations(db, { paymentId: 'TR_TEST_101' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.paymentId).toBe('TR_TEST_101');
  });

  it('formats clean PASS and FAIL reports for terminal and CI gate', () => {
    // Empty report -> PASS
    const passReport = formatUatViolationsReport([]);
    expect(passReport).toContain('[PASS] 0 UAT violations detected');
    expect(passReport).toContain('All integration calls comply');

    // Violations present -> FAIL with remediation
    const sampleViolations: UatViolationReport[] = [
      {
        id: 1,
        ts: 1700000000000,
        paymentId: 'TR_FAIL_1',
        rule: 'UAT_RULE_1_REDUNDANT_TOKEN_GRANT',
        actionPoint: 'Action Point #0',
        title: 'Redundant Token Grant',
        description: 'New token requested within 1 hour',
        remediation: 'Cache id_token and reuse across calls'
      }
    ];

    const failReport = formatUatViolationsReport(sampleViolations);
    expect(failReport).toContain('[FAIL] 1 UAT compliance violation(s) detected!');
    expect(failReport).toContain('Violation #1: Redundant Token Grant');
    expect(failReport).toContain('Action Point #0');
    expect(failReport).toContain('Remediation:');
    expect(failReport).toContain('Result: FAILED (1 violation(s))');
  });

  it('formats clean ASCII timeline table of events for paysim events', () => {
    // Empty table
    expect(formatTimelineTable(db)).toBe('No events recorded in database.');

    // Populated table
    insertEvent(db, {
      ts: 1700000000000,
      kind: 'TOKEN_GRANTED'
    });
    insertEvent(db, {
      ts: 1700000005000,
      kind: 'PAYMENT_EXECUTED',
      payment_id: 'TR_TIMELINE_1'
    });

    const table = formatTimelineTable(db);
    expect(table).toContain('Timestamp (ISO)');
    expect(table).toContain('Kind / Event');
    expect(table).toContain('Payment ID');
    expect(table).toContain('TOKEN_GRANTED');
    expect(table).toContain('PAYMENT_EXECUTED');
    expect(table).toContain('TR_TIMELINE_1');
  });

  it('configures Commander CLI commands correctly', () => {
    expect(program.name()).toBe('paysim');
    const commandNames = program.commands.map((cmd) => cmd.name());
    expect(commandNames).toContain('start');
    expect(commandNames).toContain('events');
    expect(commandNames).toContain('lint');
  });
});
