import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs';

describe('Day 19: Compiled Build Asset & Dist Smoke Test', () => {
  let simApp: FastifyInstance;
  let simBaseUrl: string;
  let simDb: any;

  beforeAll(async () => {
    const distCertPath = path.resolve('dist/src/delivery/certs/test-cert.pem');
    const distKeyPath = path.resolve('dist/src/delivery/certs/test-key.pem');

    // If dist/ has not been built yet, run build so the smoke test is fully self-contained
    if (!fs.existsSync(distCertPath) || !fs.existsSync(distKeyPath)) {
      const { execSync } = await import('node:child_process');
      execSync('npm run build', { stdio: 'pipe' });
    }

    // Assert dist/ output exists
    expect(fs.existsSync(distCertPath)).toBe(true);
    expect(fs.existsSync(distKeyPath)).toBe(true);

    // Dynamic import directly from compiled dist/
    // @ts-ignore - dynamic import of compiled dist build without declarations
    const { createSimulatorServer } = await import('../../dist/src/api/server.js');
    // @ts-ignore - dynamic import of compiled dist build without declarations
    const { createDatabase } = await import('../../dist/src/storage/db.js');
    // @ts-ignore - dynamic import of compiled dist build without declarations
    const { VirtualClock } = await import('../../dist/src/core/clock.js');

    simDb = createDatabase(':memory:');
    const clock = new VirtualClock(1700000000000);

    simApp = createSimulatorServer({
      db: simDb,
      clock
    });

    simBaseUrl = await simApp.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    if (simApp) {
      await simApp.close();
    }
    if (simDb) {
      simDb.close();
    }
  });

  it('serves the public X.509 cert from compiled dist without ENOENT error', async () => {
    const res = await fetch(`${simBaseUrl}/.well-known/paysim-sns.pem`);
    expect(res.status).toBe(200);
    const certText = await res.text();
    expect(certText).toContain('-----BEGIN CERTIFICATE-----');
    expect(certText).toContain('-----END CERTIFICATE-----');
  });

  it('signs and verifies an AWS SNS notification using compiled dist modules', async () => {
    // @ts-ignore - dynamic import of compiled dist build without declarations
    const signerModule = (await import('../../dist/src/delivery/sns-signer.js')) as any;
    const { createSignedNotificationEnvelope, loadDefaultTestCertificate } = signerModule;
    // @ts-ignore - dynamic import of compiled dist build without declarations
    const verifierModule = (await import('../../dist/src/delivery/sns-verifier.js')) as any;
    const { verifySnsMessage } = verifierModule;

    const certFromLoader = loadDefaultTestCertificate();
    expect(certFromLoader).toContain('BEGIN CERTIFICATE');

    const signingCertUrl = `${simBaseUrl}/.well-known/paysim-sns.pem`;
    const message = JSON.stringify({
      amount: '500.00',
      currency: 'BDT',
      trxID: 'BKSMOKETEST',
      transactionStatus: 'Completed'
    });

    const envelope = createSignedNotificationEnvelope(
      {
        Type: 'Notification',
        MessageId: 'smoke-msg-1',
        TopicArn: 'arn:aws:sns:ap-southeast-1:000000000000:bkash-ipn',
        Subject: 'bKash Payment Notification',
        Message: message,
        Timestamp: new Date().toISOString()
      },
      signingCertUrl
    );

    expect(envelope.Signature).toBeDefined();
    expect(envelope.SignatureVersion).toBe('1');

    const verifyResult = await verifySnsMessage(envelope, {
      allowedCertHosts: ['localhost', '127.0.0.1']
    });

    expect(verifyResult.valid).toBe(true);
  });
});
