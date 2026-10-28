#!/usr/bin/env node
import { Command } from 'commander';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createDatabase } from '../storage/db.js';
import { SystemClock } from '../core/clock.js';
import { createSimulatorServer } from '../api/server.js';
import { OutboxWorker } from '../delivery/worker.js';
import {
  checkUatViolations,
  formatUatViolationsReport,
  formatTimelineTable
} from '../linter/uat-linter.js';

const program = new Command();

program
  .name('paysim')
  .description('PaySim-BD: Local CLI and chaos webhook simulator for bKash Checkout and AWS SNS IPN')
  .version('1.2.0');

// 1. paysim start [--port 8080] [--db ./paysim.db]
program
  .command('start')
  .description('Start the PaySim-BD HTTP simulator and outbox delivery worker')
  .option('-p, --port <port>', 'Port to listen on', '8080')
  .option('-d, --db <path>', 'SQLite database path', './paysim.db')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10) || 8080;
    const dbPath = path.resolve(opts.db);
    const db = createDatabase(dbPath);
    const clock = new SystemClock();
    const workerEvents = new EventEmitter();

    const app = createSimulatorServer({
      db,
      clock,
      workerEvents,
      logger: false
    });

    const worker = new OutboxWorker({
      db,
      clock,
      eventEmitter: workerEvents,
      pollIntervalMs: 100,
      leaseDurationMs: 30000,
      maxAttempts: 5
    });
    worker.start();

    const address = await app.listen({ port, host: '0.0.0.0' });

    console.log('================================================================================');
    console.log('                PaySim-BD: bKash Tokenized Checkout Simulator                   ');
    console.log('================================================================================');
    console.log(` Simulator URL:    ${address}`);
    console.log(` Live Inspector:   ${address}/_paysim/inspector`);
    console.log(` SQLite Database:  ${dbPath}`);
    console.log(` SNS Public Cert:  ${address}/.well-known/paysim-sns.pem`);
    console.log(` UAT Violations:   ${address}/_paysim/linter/violations`);
    console.log(` Outbox Worker:    Active (Concurrency: Promise.all, Lease: 30s)`);
    console.log('================================================================================');
    console.log(' Press Ctrl+C to stop.');

    const cleanup = async () => {
      console.log('\nStopping PaySim-BD...');
      worker.stop();
      await app.close();
      db.close();
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  });

// 2. paysim events [paymentId] [--db ./paysim.db]
program
  .command('events [paymentId]')
  .description('Print chronological timeline table of events for a payment (or all recent events)')
  .option('-d, --db <path>', 'SQLite database path', './paysim.db')
  .action((paymentId, opts) => {
    const dbPath = path.resolve(opts.db);
    const db = createDatabase(dbPath);
    try {
      const table = formatTimelineTable(db, paymentId);
      console.log(table);
    } finally {
      db.close();
    }
  });

// 3. paysim lint [--db ./paysim.db] [--payment <paymentId>]
program
  .command('lint')
  .description('Audit recorded events against verified bKash UAT Technical Acceptance Rules')
  .option('-d, --db <path>', 'SQLite database path', './paysim.db')
  .option('--payment <paymentId>', 'Filter audit by specific payment ID')
  .action((opts) => {
    const dbPath = path.resolve(opts.db);
    const db = createDatabase(dbPath);
    try {
      const violations = checkUatViolations(db, { paymentId: opts.payment });
      const report = formatUatViolationsReport(violations);
      console.log(report);

      if (violations.length > 0) {
        process.exitCode = 1;
      }
    } finally {
      db.close();
    }
  });

export { program };

// If executed directly from CLI
if (
  process.argv[1] &&
  (process.argv[1].endsWith('cli\\index.ts') ||
    process.argv[1].endsWith('cli/index.ts') ||
    process.argv[1].endsWith('cli\\index.js') ||
    process.argv[1].endsWith('cli/index.js') ||
    process.argv[1].endsWith('bin\\paysim') ||
    process.argv[1].endsWith('bin/paysim'))
) {
  program.parse(process.argv);
}

