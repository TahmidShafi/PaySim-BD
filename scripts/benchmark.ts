import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createDatabase } from '../src/storage/db.js';
import { VirtualClock } from '../src/core/clock.js';
import { createSimulatorServer } from '../src/api/server.js';
import { createSignedNotificationEnvelope } from '../src/delivery/sns-signer.js';
import { verifySnsMessage } from '../src/delivery/sns-verifier.js';

interface RunResult {
  run: number;
  count: number;
  durationSec: number;
  throughput: number;
  min: number;
  median: number;
  p95: number;
  p99: number;
  max: number;
}

function computePercentiles(values: number[]): { min: number; median: number; p95: number; p99: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { min: 0, median: 0, p95: 0, p99: 0, max: 0 };

  const min = sorted[0]!;
  const max = sorted[n - 1]!;
  const median = sorted[Math.floor(n * 0.50)]!;
  const p95 = sorted[Math.floor(n * 0.95)]!;
  const p99 = sorted[Math.floor(n * 0.99)]!;

  return { min, median, p95, p99, max };
}

async function main() {
  console.log('='.repeat(70));
  console.log('PaySim-BD High-Fidelity Performance & Stress Benchmark');
  console.log('='.repeat(70));

  // 1. Detect Hardware & Environment
  const cpuModel = os.cpus()[0]?.model ?? 'Unknown CPU';
  const cpuCores = os.cpus().length;
  const totalRamGb = (os.totalmem() / (1024 ** 3)).toFixed(2);
  const osPlatform = `${os.platform()} ${os.release()} (${os.arch()})`;
  const nodeVersion = process.version;
  const dbEngine = 'better-sqlite3 (synchronous C-API)';
  const walMode = 'WAL (Write-Ahead Logging), synchronous = NORMAL, busy_timeout = 5000ms';

  console.log('\n[Hardware & Environment]');
  console.log(`- CPU:          ${cpuModel} (${cpuCores} logical cores)`);
  console.log(`- Memory:       ${totalRamGb} GB RAM`);
  console.log(`- Platform:     ${osPlatform}`);
  console.log(`- Runtime:      Node.js ${nodeVersion}`);
  console.log(`- Database:     ${dbEngine}`);
  console.log(`- Storage Mode: ${walMode}\n`);

  // 2. Setup Temporary File-backed SQLite Database with WAL
  const tempDbPath = path.join(
    os.tmpdir(),
    `paysim-benchmark-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  const db = createDatabase(tempDbPath);
  const clock = new VirtualClock(1700000000000);

  const simApp = createSimulatorServer({ db, clock });
  const simUrl = await simApp.listen({ port: 0, host: '127.0.0.1' });

  // 3. Grant initial token
  const grantRes = await fetch(`${simUrl}/tokenized/checkout/token/grant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_key: 'bench-key', app_secret: 'bench-secret' })
  });
  const { id_token: idToken } = (await grantRes.json()) as { id_token: string };

  const executeLifecycle = async (idx: number): Promise<number> => {
    const t0 = performance.now();

    // 1. Create payment
    const createRes = await fetch(`${simUrl}/tokenized/checkout/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
        'X-APP-Key': 'bench-key'
      },
      body: JSON.stringify({
        mode: '0011',
        payerReference: `BENCH_REF_${idx}`,
        callbackURL: 'http://127.0.0.1:9999/callback',
        amount: '250.00',
        currency: 'BDT',
        intent: 'sale',
        merchantInvoiceNumber: `INV-BENCH-${idx}`
      })
    });
    const { paymentID } = (await createRes.json()) as { paymentID: string };

    // 2. Headless auto-approve
    await fetch(`${simUrl}/_paysim/checkout/${paymentID}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve' })
    });

    // 3. Execute payment (triggers BEGIN IMMEDIATE transaction + RSA-SHA1 signing + outbox insert)
    await fetch(`${simUrl}/tokenized/checkout/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
        'X-APP-Key': 'bench-key'
      },
      body: JSON.stringify({ paymentID })
    });

    const t1 = performance.now();
    return t1 - t0;
  };

  // 4. Warm-up Phase (50 requests)
  console.log('[Phase 1] Warming up JIT and SQLite cache with 50 lifecycles...');
  for (let i = 0; i < 50; i++) {
    await executeLifecycle(i);
  }
  console.log('Warm-up complete.\n');

  // 5. Measurement Phase (5 runs of 200 lifecycles = 1,000 total lifecycles)
  console.log('[Phase 2] Executing 5 benchmark runs (200 full payment lifecycles per run)...');
  const runResults: RunResult[] = [];
  const allLatencies: number[] = [];

  for (let run = 1; run <= 5; run++) {
    const runLatencies: number[] = [];
    const runStart = performance.now();

    for (let i = 0; i < 200; i++) {
      const globalIdx = 50 + (run - 1) * 200 + i;
      const lat = await executeLifecycle(globalIdx);
      runLatencies.push(lat);
      allLatencies.push(lat);
    }

    const runDurationSec = (performance.now() - runStart) / 1000;
    const throughput = Math.round(200 / runDurationSec);
    const { min, median, p95, p99, max } = computePercentiles(runLatencies);

    runResults.push({
      run,
      count: 200,
      durationSec: runDurationSec,
      throughput,
      min,
      median,
      p95,
      p99,
      max
    });

    console.log(
      `  Run ${run}/5: 200 payments in ${runDurationSec.toFixed(3)}s | ` +
      `Throughput: ${throughput} req/s | Median: ${median.toFixed(2)}ms | p95: ${p95.toFixed(2)}ms | p99: ${p99.toFixed(2)}ms`
    );
  }

  // 6. Concurrent Signature Verification & SQLite Deduplication Burst Test
  console.log('\n[Phase 3] Benchmarking AWS SNS RSA-SHA1 Verification + SQLite Deduplication (500 concurrent operations)...');
  db.exec(`
    CREATE TABLE IF NOT EXISTS bench_dedup (
      trx_id TEXT PRIMARY KEY,
      processed_at INTEGER NOT NULL
    );
  `);
  const dedupStmt = db.prepare('INSERT OR IGNORE INTO bench_dedup (trx_id, processed_at) VALUES (?, ?)');

  const signingCertUrl = `${simUrl}/.well-known/paysim-sns.pem`;
  const sampleMessage = JSON.stringify({
    amount: '500.00',
    currency: 'BDT',
    trxID: 'TRX_BENCH_BURST_1',
    transactionStatus: 'Completed',
    merchantInvoiceNumber: 'INV-BURST-1'
  });
  const envelope = createSignedNotificationEnvelope(
    {
      Type: 'Notification',
      MessageId: 'bench-burst-msg-1',
      TopicArn: 'arn:aws:sns:ap-southeast-1:000000000000:bkash-ipn',
      Subject: 'bKash IPN Burst',
      Message: sampleMessage,
      Timestamp: new Date().toISOString()
    },
    signingCertUrl
  );

  // Pre-warm certificate cache
  const warmRes = await verifySnsMessage(envelope, { allowedCertHosts: ['localhost', '127.0.0.1'] });
  if (!warmRes.valid) throw new Error(`Pre-warm verification failed: ${warmRes.error}`);

  const burstCount = 500;
  const burstStart = performance.now();
  await Promise.all(
    Array.from({ length: burstCount }, async (_, i) => {
      const verifyRes = await verifySnsMessage(envelope, {
        allowedCertHosts: ['localhost', '127.0.0.1']
      });
      if (!verifyRes.valid) throw new Error(`Verification failed in burst test: ${verifyRes.error}`);
      dedupStmt.run(`TRX_BURST_${i}`, Date.now());
    })
  );
  const burstDurationSec = (performance.now() - burstStart) / 1000;
  const burstThroughput = Math.round(burstCount / burstDurationSec);
  console.log(`  Completed ${burstCount} concurrent RSA-SHA1 verifications + DB deduplications in ${burstDurationSec.toFixed(3)}s (${burstThroughput} ops/sec)\n`);

  // 7. Cleanup
  await simApp.close();
  db.close();
  if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
  if (fs.existsSync(`${tempDbPath}-wal`)) fs.unlinkSync(`${tempDbPath}-wal`);
  if (fs.existsSync(`${tempDbPath}-shm`)) fs.unlinkSync(`${tempDbPath}-shm`);

  // 8. Overall Aggregate Metrics
  const aggregate = computePercentiles(allLatencies);
  const totalDurationSec = runResults.reduce((acc, r) => acc + r.durationSec, 0);
  const overallThroughput = Math.round(1000 / totalDurationSec);

  // 9. Generate Markdown Report
  const markdownReport = `# PaySim-BD Performance Benchmark Report

Measured on **${new Date().toISOString().split('T')[0]}** using local disk-backed SQLite with Write-Ahead Logging (WAL).

## Host Hardware & Environment

| Property | Value |
| :--- | :--- |
| **CPU Model** | \`${cpuModel}\` |
| **Logical Cores** | \`${cpuCores}\` |
| **RAM** | \`${totalRamGb} GB\` |
| **Operating System** | \`${osPlatform}\` |
| **Node.js Runtime** | \`${nodeVersion}\` |
| **Database Engine** | \`${dbEngine}\` |
| **Storage Configuration** | \`${walMode}\` |

## 1. Full Payment Lifecycle Throughput & Latency

Each payment lifecycle includes:
1. \`POST /tokenized/checkout/create\` (Validation, schema parsing, state transition to \`INITIATED\`)
2. \`POST /_paysim/checkout/:paymentID/action\` (Simulated wallet OTP/PIN approval to \`APPROVED\`)
3. \`POST /tokenized/checkout/execute\` (Atomic \`BEGIN IMMEDIATE\` transaction, state update to \`COMPLETED\`, deterministic \`trxID\` generation, AWS SNS RSA-SHA1 signature computation, and \`ipn_outbox\` insertion)

> **Test Configuration:** 50-request warm-up, followed by **5 measured runs of 200 payments** (1,000 total lifecycles).

| Run | Count | Duration (s) | Throughput (req/s) | Min Latency (ms) | Median Latency (ms) | p95 Latency (ms) | p99 Latency (ms) | Max Latency (ms) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
${runResults.map((r) => `| **Run ${r.run}** | ${r.count} | ${r.durationSec.toFixed(3)}s | **${r.throughput}** | ${r.min.toFixed(2)}ms | ${r.median.toFixed(2)}ms | ${r.p95.toFixed(2)}ms | ${r.p99.toFixed(2)}ms | ${r.max.toFixed(2)}ms |`).join('\n')}
| **Aggregate** | **1,000** | **${totalDurationSec.toFixed(3)}s** | **${overallThroughput}** | **${aggregate.min.toFixed(2)}ms** | **${aggregate.median.toFixed(2)}ms** | **${aggregate.p95.toFixed(2)}ms** | **${aggregate.p99.toFixed(2)}ms** | **${aggregate.max.toFixed(2)}ms** |

## 2. SNS RSA-SHA1 Signature Verification & SQLite Deduplication Burst

Under concurrent burst load of **500 incoming webhooks**:
- **Workload:** Cryptographic RSA-SHA1 signature verification against X.509 certificate public key + SQLite idempotent deduplication query.
- **Operations:** \`${burstCount}\`
- **Total Duration:** \`${burstDurationSec.toFixed(3)}s\`
- **Throughput:** **\`${burstThroughput} ops/sec\`**
`;

  // 10. Write to docs/benchmarks.md
  const docsDir = path.resolve('docs');
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'benchmarks.md'), markdownReport, 'utf8');

  console.log('='.repeat(70));
  console.log('BENCHMARK SUMMARY (Saved to docs/benchmarks.md)');
  console.log('='.repeat(70));
  console.log(`Total Lifecycles:    1,000 payments`);
  console.log(`Overall Throughput:  ${overallThroughput} lifecycles/sec`);
  console.log(`Median Latency:      ${aggregate.median.toFixed(2)} ms`);
  console.log(`p95 Latency:         ${aggregate.p95.toFixed(2)} ms`);
  console.log(`p99 Latency:         ${aggregate.p99.toFixed(2)} ms`);
  console.log(`Verification Burst:  ${burstThroughput} ops/sec`);
  console.log('='.repeat(70));
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
