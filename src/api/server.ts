import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { type Database as DatabaseType } from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { z } from 'zod';
import { type Clock } from '../core/clock.js';
import { parseAmountToPaisa, formatPaisaToAmountString } from '../core/paisa.js';
import { transitionPayment, type PaymentStatus } from '../core/state-machine.js';
import {
  insertPayment,
  getPaymentById,
  updatePaymentStatus,
  insertToken,
  getTokenById,
  getTokenByRefreshToken,
  insertEvent,
  atomicExecutePaymentWithOutbox,
  insertWebhookSubscription,
  confirmWebhookSubscription,
  type PaymentRecord
} from '../storage/repositories.js';
import { buildOutboxItems, type DuplicateChaosRule } from '../chaos/duplicate.js';
import {
  loadDefaultTestCertificate,
  createSignedNotificationEnvelope,
  createSignedSubscriptionConfirmationEnvelope
} from '../delivery/sns-signer.js';

export interface SimulatorServerOptions {
  db: DatabaseType;
  clock: Clock;
  workerEvents?: EventEmitter;
  chaosRule?: DuplicateChaosRule | null;
  logger?: boolean;
}

const CreatePaymentSchema = z.object({
  mode: z.string().default('0011'),
  payerReference: z.string().optional().nullable(),
  callbackURL: z.string().url(),
  amount: z.string(),
  currency: z.string().default('BDT'),
  intent: z.string().default('sale'),
  merchantInvoiceNumber: z.string(),
  customerMsisdn: z.string().optional().nullable()
});

const ExecutePaymentSchema = z.object({
  paymentID: z.string()
});

const PaymentStatusSchema = z.object({
  paymentID: z.string()
});

const RefreshTokenSchema = z.object({
  refresh_token: z.string().min(1),
  app_key: z.string().optional(),
  app_secret: z.string().optional()
});

const AdvanceClockSchema = z.object({
  seconds: z.number().optional(),
  ms: z.number().optional()
});

const RegisterWebhookSchema = z.object({
  targetUrl: z.string().url()
});

let trxSequence = 0;

/**
 * Generates a deterministic, uppercase 10-character transaction ID (e.g. BK7F3A9D1E).
 */
export function generateDeterministicTrxId(paymentId: string, seq?: number): string {
  const currentSeq = seq ?? ++trxSequence;
  const hash = crypto
    .createHash('sha256')
    .update(`${paymentId}:${currentSeq}`)
    .digest('hex')
    .toUpperCase();
  return `BK${hash.slice(0, 8)}`;
}

export function createSimulatorServer(options: SimulatorServerOptions): FastifyInstance {
  const { db, clock, workerEvents, logger = false } = options;
  let activeChaosRule = options.chaosRule ?? null;

  const app = Fastify({ logger });

  // Optional chaos rule toggle at runtime
  app.decorate('setChaosRule', (rule: DuplicateChaosRule | null) => {
    activeChaosRule = rule;
  });

  // Serve public X.509 certificate for SNS signature verification
  app.get('/.well-known/paysim-sns.pem', async (_req, reply) => {
    const cert = loadDefaultTestCertificate();
    return reply.header('Content-Type', 'application/x-pem-file').send(cert);
  });

  // Token authentication helper
  const verifyBearerToken = async (req: FastifyRequest, reply: FastifyReply) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return reply.code(401).send({
        statusCode: '2007',
        statusMessage: 'Unauthorized: Missing Authorization header'
      });
    }

    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    const tokenRecord = getTokenById(db, token);

    if (!tokenRecord || (tokenRecord.revoked ?? 0) === 1 || tokenRecord.id_expires_at <= clock.nowMs()) {
      return reply.code(401).send({
        statusCode: '2007',
        statusMessage: 'Unauthorized: Invalid or expired token'
      });
    }
  };

  /**
   * Performs wallet state transition and dispatches simulated asynchronous GET callback
   */
  async function performWalletAction(
    paymentId: string,
    actionInput?: 'approve' | 'fail' | 'cancel',
    customerMsisdnInput?: string | null
  ): Promise<{ action: 'approve' | 'fail' | 'cancel'; callbackStatus: 'success' | 'failure' | 'cancel'; statusCode: string }> {
    const payment = getPaymentById(db, paymentId);
    if (!payment) {
      throw new Error(`Payment with ID "${paymentId}" not found`);
    }

    const msisdn = customerMsisdnInput ?? payment.customer_msisdn ?? payment.payer_reference ?? '';

    let action: 'approve' | 'fail' | 'cancel' = actionInput ?? 'approve';
    let statusCode = '0000';

    // bKash sandbox test wallet automatic mapping
    if (msisdn === '01823074817') {
      action = 'fail';
      statusCode = '2023'; // Insufficient balance
    } else if (msisdn === '01823074818') {
      action = 'fail';
      statusCode = '2024'; // Debit block
    } else if (['01770618575', '01619777283', '01877722345'].includes(msisdn)) {
      action = 'approve';
      statusCode = '0000';
    }

    let callbackStatus: 'success' | 'failure' | 'cancel' = 'success';
    let paymentAction: 'APPROVE_PAYMENT' | 'FAIL_PAYMENT' | 'CANCEL_PAYMENT' = 'APPROVE_PAYMENT';

    if (action === 'fail') {
      callbackStatus = 'failure';
      paymentAction = 'FAIL_PAYMENT';
    } else if (action === 'cancel') {
      callbackStatus = 'cancel';
      paymentAction = 'CANCEL_PAYMENT';
    }

    const transitionRes = transitionPayment(payment.status as PaymentStatus, paymentAction);
    if (transitionRes.ok) {
      updatePaymentStatus(db, payment.payment_id, transitionRes.nextStatus, clock.nowMs());
    }

    // Fire asynchronous HTTP GET request to callbackURL: <callbackURL>?paymentID=<id>&status=<status>
    const delim = payment.callback_url.includes('?') ? '&' : '?';
    const callbackTarget = `${payment.callback_url}${delim}paymentID=${payment.payment_id}&status=${callbackStatus}`;
    fetch(callbackTarget, { method: 'GET' }).catch(() => {
      // Fire-and-forget
    });

    return { action, callbackStatus, statusCode };
  }

  // 1. POST /tokenized/checkout/token/grant
  app.post('/tokenized/checkout/token/grant', async (_req, reply) => {
    const now = clock.nowMs();
    const idToken = `tok_${crypto.randomUUID().replace(/-/g, '')}`;
    const refreshToken = `ref_${crypto.randomUUID().replace(/-/g, '')}`;
    const expiresIn = 3600; // 1 hour (3600 seconds)
    const refreshExpiresIn = 2419200; // 28 days (2,419,200 seconds)

    insertToken(db, {
      id_token: idToken,
      refresh_token: refreshToken,
      issued_at: now,
      id_expires_at: now + expiresIn * 1000,
      refresh_expires_at: now + refreshExpiresIn * 1000,
      revoked: 0
    });

    return reply.code(200).send({
      statusCode: '0000',
      statusMessage: 'Successful',
      id_token: idToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refreshToken
    });
  });

  // 2. POST /tokenized/checkout/token/refresh
  app.post('/tokenized/checkout/token/refresh', async (req, reply) => {
    const parseResult = RefreshTokenSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(401).send({
        statusCode: '2007',
        statusMessage: 'Unauthorized: Missing refresh_token'
      });
    }

    const { refresh_token } = parseResult.data;
    const tokenRecord = getTokenByRefreshToken(db, refresh_token);
    const now = clock.nowMs();

    if (!tokenRecord || (tokenRecord.revoked ?? 0) === 1 || now >= tokenRecord.refresh_expires_at) {
      return reply.code(401).send({
        statusCode: '2007',
        statusMessage: 'Unauthorized: Invalid or expired refresh token'
      });
    }

    const newIdToken = `tok_${crypto.randomUUID().replace(/-/g, '')}`;
    const expiresIn = 3600; // 1 hour

    // Preserve the original refresh_expires_at timestamp per bKash UAT specification!
    insertToken(db, {
      id_token: newIdToken,
      refresh_token: tokenRecord.refresh_token,
      issued_at: now,
      id_expires_at: now + expiresIn * 1000,
      refresh_expires_at: tokenRecord.refresh_expires_at,
      revoked: 0
    });

    return reply.code(200).send({
      statusCode: '0000',
      statusMessage: 'Successful',
      id_token: newIdToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: tokenRecord.refresh_token
    });
  });

  // 3. POST /_paysim/clock/advance (Virtual clock control for testing)
  app.post('/_paysim/clock/advance', async (req, reply) => {
    const parseResult = AdvanceClockSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(400).send({ error: 'Invalid advance parameters' });
    }

    const deltaMs = (parseResult.data.ms ?? 0) + (parseResult.data.seconds ?? 0) * 1000;
    if (deltaMs > 0) {
      clock.advanceMs(deltaMs);
    }

    return reply.code(200).send({
      nowMs: clock.nowMs(),
      nowIso: clock.nowIso()
    });
  });

  // 4. POST /tokenized/checkout/create
  app.post(
    '/tokenized/checkout/create',
    { preHandler: verifyBearerToken },
    async (req, reply) => {
      const parseResult = CreatePaymentSchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.code(200).send({
          statusCode: '2001',
          statusMessage: `Validation error: ${parseResult.error.issues.map((i) => i.message).join(', ')}`
        });
      }

      const body = parseResult.data;
      let amountPaisa: number;
      try {
        amountPaisa = parseAmountToPaisa(body.amount);
      } catch (err: unknown) {
        return reply.code(200).send({
          statusCode: '2002',
          statusMessage: err instanceof Error ? err.message : 'Invalid amount'
        });
      }

      const paymentId = `TR0011${crypto.randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`;
      const now = clock.nowMs();

      // Created in INITIATED state per real bKash protocol
      const paymentRecord: PaymentRecord = {
        payment_id: paymentId,
        invoice: body.merchantInvoiceNumber,
        amount_paisa: amountPaisa,
        currency: body.currency,
        mode: body.mode,
        intent: body.intent,
        payer_reference: body.payerReference ?? null,
        customer_msisdn: body.customerMsisdn ?? null,
        callback_url: body.callbackURL,
        status: 'INITIATED',
        trx_id: null,
        created_at: now,
        updated_at: now
      };

      insertPayment(db, paymentRecord);

      const host = req.headers.host ?? '127.0.0.1';
      const bkashURL = `http://${host}/_paysim/checkout/${paymentId}`;

      // Support Headless CI Auto-Approve on /create
      const autoApproveHeader = req.headers['x-paysim-auto-approve'];
      if (autoApproveHeader) {
        const headerVal = String(autoApproveHeader).toLowerCase();
        let autoAction: 'approve' | 'fail' | 'cancel' = 'approve';
        if (headerVal === 'failure' || headerVal === 'fail') autoAction = 'fail';
        else if (headerVal === 'cancel') autoAction = 'cancel';

        setImmediate(() => {
          void performWalletAction(paymentId, autoAction, body.customerMsisdn);
        });
      }

      return reply.code(200).send({
        statusCode: '0000',
        statusMessage: 'Successful',
        paymentID: paymentId,
        bkashURL,
        callbackURL: body.callbackURL,
        successCallbackURL: `${body.callbackURL}?status=success&paymentID=${paymentId}`,
        failureCallbackURL: `${body.callbackURL}?status=failure&paymentID=${paymentId}`,
        cancelledCallbackURL: `${body.callbackURL}?status=cancel&paymentID=${paymentId}`,
        amount: formatPaisaToAmountString(amountPaisa),
        intent: body.intent,
        currency: body.currency,
        paymentCreateTime: clock.nowIso(),
        transactionStatus: 'Initiated',
        merchantInvoiceNumber: body.merchantInvoiceNumber
      });
    }
  );

  // 5. POST /_paysim/checkout/:paymentID/action (Simulator wallet action)
  app.post<{
    Params: { paymentID: string };
    Body: { action?: 'approve' | 'fail' | 'cancel'; customerMsisdn?: string };
  }>('/_paysim/checkout/:paymentID/action', async (req, reply) => {
    const { paymentID } = req.params;
    const payment = getPaymentById(db, paymentID);
    if (!payment) {
      return reply.code(404).send({ error: 'Payment not found' });
    }

    const { action, customerMsisdn } = req.body ?? {};
    const result = await performWalletAction(paymentID, action, customerMsisdn);

    return reply.code(200).send({
      statusCode: result.statusCode,
      statusMessage: result.callbackStatus === 'success' ? 'Successful' : 'Failed',
      paymentID,
      action: result.action,
      status: result.callbackStatus
    });
  });

  // 6. POST /tokenized/checkout/execute
  app.post(
    '/tokenized/checkout/execute',
    { preHandler: verifyBearerToken },
    async (req, reply) => {
      const parseResult = ExecutePaymentSchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.code(200).send({
          statusCode: '2001',
          statusMessage: 'Missing paymentID'
        });
      }

      const { paymentID } = parseResult.data;
      const payment = getPaymentById(db, paymentID);
      if (!payment) {
        return reply.code(200).send({
          statusCode: '2019',
          statusMessage: 'Payment not found'
        });
      }

      // Check transition via state machine
      const transitionResult = transitionPayment(payment.status as PaymentStatus, 'EXECUTE_PAYMENT');
      if (!transitionResult.ok) {
        // Record UAT violation event if Rule 2 was violated
        if (transitionResult.uatViolation) {
          insertEvent(db, {
            ts: clock.nowMs(),
            kind: transitionResult.uatViolation,
            payment_id: payment.payment_id,
            request: JSON.stringify(req.body),
            response: JSON.stringify({
              statusCode: transitionResult.statusCode,
              statusMessage: transitionResult.statusMessage
            })
          });
        }

        return reply.code(200).send({
          statusCode: transitionResult.statusCode,
          statusMessage: transitionResult.statusMessage
        });
      }

      // Generate deterministic 10-character uppercase transaction ID
      const trxId = generateDeterministicTrxId(payment.payment_id);
      const now = clock.nowMs();
      const amountStr = formatPaisaToAmountString(payment.amount_paisa);

      // Construct inner notification message JSON
      const innerMessage = JSON.stringify({
        dateTime: clock.nowIso(),
        debitMSISDN: payment.customer_msisdn ?? '01770618575',
        amount: amountStr,
        currency: payment.currency,
        trxID: trxId,
        transactionStatus: 'Completed',
        merchantInvoiceNumber: payment.invoice,
        paymentID: payment.payment_id,
        payerReference: payment.payer_reference,
        transactionType: payment.intent
      });

      const host = req.headers.host ?? '127.0.0.1';
      const signingCertUrl = `http://${host}/.well-known/paysim-sns.pem`;

      // Construct signed AWS SNS Notification envelope (SignatureVersion: 1, RSA-SHA1)
      const signedNotification = createSignedNotificationEnvelope(
        {
          Type: 'Notification',
          MessageId: crypto.randomUUID(),
          TopicArn: 'arn:aws:sns:ap-southeast-1:000000000000:bkash-ipn',
          Subject: 'bKash Payment Notification',
          Message: innerMessage,
          Timestamp: clock.nowIso()
        },
        signingCertUrl
      );

      const snsEnvelope = JSON.stringify(signedNotification);

      // Apply duplicate chaos rule if configured
      const outboxItems = buildOutboxItems({
        basePayload: snsEnvelope,
        signature: signedNotification.Signature,
        snsType: 'Notification',
        nowMs: now,
        chaosRule: activeChaosRule
      });

      // Synchronous atomic transaction: state transition + outbox enqueue
      atomicExecutePaymentWithOutbox(db, {
        paymentId: payment.payment_id,
        expectedStatus: 'APPROVED',
        newStatus: 'COMPLETED',
        trxId,
        updatedAt: now,
        outbox: outboxItems,
        event: {
          kind: 'PAYMENT_EXECUTED',
          response: JSON.stringify({ statusCode: '0000', trxID: trxId })
        }
      });

      // Post-commit hook: wake the outbox delivery worker AFTER SQLite commits
      if (workerEvents) {
        workerEvents.emit('wake');
      }

      return reply.code(200).send({
        statusCode: '0000',
        statusMessage: 'Successful',
        paymentID: payment.payment_id,
        trxID: trxId,
        transactionStatus: 'Completed',
        amount: amountStr,
        currency: payment.currency,
        intent: payment.intent,
        paymentExecuteTime: clock.nowIso(),
        merchantInvoiceNumber: payment.invoice,
        payerReference: payment.payer_reference,
        customerMsisdn: payment.customer_msisdn ?? '01770618575'
      });
    }
  );

  // 7. POST /tokenized/checkout/payment/status
  app.post(
    '/tokenized/checkout/payment/status',
    { preHandler: verifyBearerToken },
    async (req, reply) => {
      const parseResult = PaymentStatusSchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.code(200).send({
          statusCode: '2001',
          statusMessage: 'Missing paymentID'
        });
      }

      const { paymentID } = parseResult.data;
      const payment = getPaymentById(db, paymentID);
      if (!payment) {
        return reply.code(200).send({
          statusCode: '2019',
          statusMessage: 'Payment not found'
        });
      }

      return reply.code(200).send({
        statusCode: '0000',
        statusMessage: 'Successful',
        paymentID: payment.payment_id,
        trxID: payment.trx_id,
        transactionStatus: payment.status === 'COMPLETED' ? 'Completed' : payment.status,
        amount: formatPaisaToAmountString(payment.amount_paisa),
        currency: payment.currency,
        intent: payment.intent,
        merchantInvoiceNumber: payment.invoice
      });
    }
  );

  // 8. POST /_paysim/webhooks/register (AWS SNS SubscriptionConfirmation Handshake)
  app.post('/_paysim/webhooks/register', async (req, reply) => {
    const parseResult = RegisterWebhookSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(400).send({ error: 'Invalid targetUrl' });
    }

    const { targetUrl } = parseResult.data;
    const token = crypto.randomUUID().replace(/-/g, '');
    const topicArn = 'arn:aws:sns:ap-southeast-1:000000000000:bkash-ipn';
    const host = req.headers.host ?? '127.0.0.1';
    const subscribeUrl = `http://${host}/_paysim/sns/confirm?token=${token}`;
    const signingCertUrl = `http://${host}/.well-known/paysim-sns.pem`;

    insertWebhookSubscription(db, {
      target_url: targetUrl,
      status: 'PENDING_CONFIRMATION',
      token,
      topic_arn: topicArn,
      confirmed_at: null
    });

    const message = `You have chosen to subscribe to the topic ${topicArn}.\nTo confirm the subscription, visit the SubscribeURL included in this message.`;

    const confirmationEnvelope = createSignedSubscriptionConfirmationEnvelope(
      {
        Type: 'SubscriptionConfirmation',
        MessageId: crypto.randomUUID(),
        Token: token,
        TopicArn: topicArn,
        Message: message,
        SubscribeURL: subscribeUrl,
        Timestamp: clock.nowIso()
      },
      signingCertUrl
    );

    const payload = JSON.stringify(confirmationEnvelope);

    db.prepare(`
      INSERT INTO ipn_outbox (
        payment_id, sns_message_id, sns_type, payload, signature,
        attempts, next_attempt_at, locked_until, status
      ) VALUES (?, ?, 'SubscriptionConfirmation', ?, ?, 0, ?, 0, 'PENDING')
    `).run(
      targetUrl,
      confirmationEnvelope.MessageId,
      payload,
      confirmationEnvelope.Signature,
      clock.nowMs()
    );

    if (workerEvents) {
      workerEvents.emit('wake');
    }

    return reply.code(200).send({
      status: 'PENDING_CONFIRMATION',
      targetUrl,
      token,
      subscribeURL: subscribeUrl
    });
  });

  // 9. GET /_paysim/sns/confirm (Subscription confirmation activation endpoint)
  app.get<{ Querystring: { token: string } }>('/_paysim/sns/confirm', async (req, reply) => {
    const { token } = req.query;
    if (!token) {
      return reply.code(400).send({ error: 'Missing token' });
    }

    const sub = confirmWebhookSubscription(db, token, clock.nowMs());
    if (!sub) {
      return reply.code(404).send({ error: 'Invalid or expired token' });
    }

    return reply.code(200).send({
      status: 'ACTIVE',
      targetUrl: sub.target_url,
      confirmedAt: clock.nowIso()
    });
  });

  return app;
}
