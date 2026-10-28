import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { type Database as DatabaseType } from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { z } from 'zod';
import { type Clock } from '../core/clock.js';
import { parseAmountToPaisa, formatPaisaToAmountString } from '../core/paisa.js';
import { transitionPayment, type PaymentStatus, type PaymentAction } from '../core/state-machine.js';
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
  insertChaosRule,
  getChaosRules,
  clearChaosRules,
  deleteChaosRule,
  telemetryBus,
  type PaymentRecord,
  type ChaosRuleRecord,
  type OutboxItemParam,
  type IpnOutboxRecord
} from '../storage/repositories.js';
import { renderInspectorHtml } from './inspector.js';
import { buildOutboxItems, type DuplicateChaosRule } from '../chaos/duplicate.js';
import {
  applyOutboxChaosHooks,
  executeGatewayPostCommitHook,
  type PaymentMatchContext
} from '../chaos/engine.js';
import {
  loadDefaultTestCertificate,
  createSignedNotificationEnvelope,
  createSignedSubscriptionConfirmationEnvelope
} from '../delivery/sns-signer.js';
import { checkUatViolations } from '../linter/uat-linter.js';

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

const ChaosRuleInputSchema = z.object({
  id: z.string().min(1),
  match: z.record(z.unknown()).optional(),
  match_json: z.string().optional(),
  action: z.string().min(1),
  params: z.record(z.unknown()).optional(),
  params_json: z.string().optional(),
  seed: z.number().optional().nullable()
});

const TriggerOfflineSchema = z.object({
  channel: z.enum(['ussd', 'qr']),
  amount: z.string(),
  merchantInvoiceNumber: z.string().optional(),
  payerReference: z.string().optional()
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

  const app = Fastify({ logger, forceCloseConnections: true });

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
    actionInput?: 'approve' | 'fail' | 'cancel' | 'expire',
    customerMsisdnInput?: string | null
  ): Promise<{ action: 'approve' | 'fail' | 'cancel' | 'expire'; callbackStatus: 'success' | 'failure' | 'cancel'; statusCode: string }> {
    const payment = getPaymentById(db, paymentId);
    if (!payment) {
      throw new Error(`Payment with ID "${paymentId}" not found`);
    }

    const msisdn = customerMsisdnInput ?? payment.customer_msisdn ?? payment.payer_reference ?? '';

    let action: 'approve' | 'fail' | 'cancel' | 'expire' = actionInput ?? 'approve';
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
    let paymentAction: PaymentAction = 'APPROVE_PAYMENT';

    if (action === 'fail') {
      callbackStatus = 'failure';
      paymentAction = 'FAIL_PAYMENT';
    } else if (action === 'cancel') {
      callbackStatus = 'cancel';
      paymentAction = 'CANCEL_PAYMENT';
    } else if (action === 'expire') {
      callbackStatus = 'cancel';
      paymentAction = 'EXPIRE_PAYMENT';
      statusCode = '2026';
    }

    const transitionRes = transitionPayment(payment.status as PaymentStatus, paymentAction);
    if (transitionRes.ok) {
      updatePaymentStatus(db, payment.payment_id, transitionRes.nextStatus, clock.nowMs());
      if (transitionRes.nextStatus === 'APPROVED') {
        insertEvent(db, {
          ts: clock.nowMs(),
          kind: 'WALLET_APPROVED',
          payment_id: payment.payment_id,
          request: JSON.stringify({ action, msisdn }),
          response: JSON.stringify({ status: 'APPROVED' })
        });
      }
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

    // UAT Rule 1 (Action Point #0): "You must reuse id_token for 1 hour for any subsequent API request"
    // Triggered if there is already an active, unrevoked token valid at clock.nowMs()
    const activeToken = db
      .prepare('SELECT id_token FROM tokens WHERE revoked = 0 AND id_expires_at > ? LIMIT 1')
      .get(now) as { id_token: string } | undefined;

    if (activeToken) {
      insertEvent(db, {
        ts: now,
        kind: 'UAT_RULE_1_REDUNDANT_TOKEN_GRANT',
        request: JSON.stringify(_req.body ?? {}),
        response: JSON.stringify({
          message:
            'Violated UAT Action Point #0: Requested new id_token while previous token is still valid. Must reuse id_token for 1 hour.'
        })
      });
    }

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

      insertEvent(db, {
        ts: now,
        kind: 'PAYMENT_INITIATED',
        payment_id: paymentId,
        request: JSON.stringify(body),
        response: JSON.stringify({ status: 'INITIATED', amount: body.amount })
      });

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
    Body: { action?: 'approve' | 'fail' | 'cancel' | 'expire'; customerMsisdn?: string };
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

      // Fetch active chaos rules from DB
      const dbRules = getChaosRules(db);
      const matchContext: PaymentMatchContext = {
        paymentId: payment.payment_id,
        payerReference: payment.payer_reference,
        customerMsisdn: payment.customer_msisdn
      };

      const baseOutboxItem: OutboxItemParam = {
        sns_message_id: signedNotification.MessageId,
        sns_type: 'Notification',
        payload: snsEnvelope,
        signature: signedNotification.Signature,
        next_attempt_at: now
      };

      let outboxItems: OutboxItemParam[];
      if (dbRules.length > 0) {
        const outboxResult = applyOutboxChaosHooks(dbRules, matchContext, baseOutboxItem, now);
        outboxItems = outboxResult.outboxItems;
      } else {
        outboxItems = buildOutboxItems({
          basePayload: snsEnvelope,
          signature: signedNotification.Signature,
          snsType: 'Notification',
          nowMs: now,
          chaosRule: activeChaosRule
        });
      }

      // Prepare ipn_delivered listener BEFORE committing and waking worker
      let ipnDeliveredPromise: Promise<void> | undefined;
      if (workerEvents) {
        ipnDeliveredPromise = new Promise<void>((resolve) => {
          const onDelivered = (deliveredPaymentId: string) => {
            if (deliveredPaymentId === payment.payment_id) {
              workerEvents.off('ipn_delivered', onDelivered);
              resolve();
            }
          };
          workerEvents.on('ipn_delivered', onDelivered);
        });
      }

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

      // Execute Gateway Post-Commit Hook strictly AFTER commit and worker wake
      if (dbRules.length > 0) {
        const postCommitResult = await executeGatewayPostCommitHook(
          dbRules,
          matchContext,
          db,
          workerEvents,
          now,
          ipnDeliveredPromise
        );

        if (postCommitResult.timedOut) {
          if (req.raw.destroyed) {
            return;
          }
          return reply.code(postCommitResult.httpStatus ?? 504).send(
            postCommitResult.errorPayload ?? {
              statusCode: '504',
              statusMessage: 'Gateway Timeout'
            }
          );
        }
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

      // UAT Rule 4 (Action Point #4): "Query payment should only be called if there is no response from the execute API"
      // Triggered if payment already had a successful /execute without an EXECUTE_TIMEOUT_AFTER_COMMIT fault
      const paymentEvents = db
        .prepare('SELECT kind FROM events WHERE payment_id = ?')
        .all(payment.payment_id) as Array<{ kind: string }>;

      const hasExecuted = paymentEvents.some((e) => e.kind === 'PAYMENT_EXECUTED');
      const hasTimedOut = paymentEvents.some((e) => e.kind === 'EXECUTE_TIMEOUT_AFTER_COMMIT');

      if (hasExecuted && !hasTimedOut) {
        insertEvent(db, {
          ts: clock.nowMs(),
          kind: 'UAT_RULE_4_UNNECESSARY_QUERY_STATUS',
          payment_id: payment.payment_id,
          request: JSON.stringify(req.body ?? {}),
          response: JSON.stringify({
            message:
              'Violated UAT Action Point #4: Query payment was called after execute API had already returned successfully without timeout.'
          })
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

  // 10. POST /_paysim/chaos/rules (Register or upsert chaos rule)
  app.post('/_paysim/chaos/rules', async (req, reply) => {
    const parseResult = ChaosRuleInputSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'Invalid chaos rule parameters',
        details: parseResult.error.issues
      });
    }

    const { id, match, match_json, action, params, params_json, seed } = parseResult.data;
    const finalMatchJson = match_json ?? JSON.stringify(match ?? {});
    const finalParamsJson = params_json ?? JSON.stringify(params ?? {});

    const record: ChaosRuleRecord = {
      id,
      match_json: finalMatchJson,
      action,
      params_json: finalParamsJson,
      seed: seed ?? null
    };

    insertChaosRule(db, record);

    return reply.code(200).send({
      status: 'ok',
      rule: record
    });
  });

  // 11. DELETE /_paysim/chaos/rules (Clear all chaos rules)
  app.delete('/_paysim/chaos/rules', async (_req, reply) => {
    clearChaosRules(db);
    activeChaosRule = null;
    return reply.code(200).send({ status: 'cleared' });
  });

  // 12. GET /_paysim/chaos/rules (List all chaos rules)
  app.get('/_paysim/chaos/rules', async (_req, reply) => {
    const rules = getChaosRules(db);
    return reply.code(200).send({ rules });
  });

  // 13. GET /_paysim/linter/violations (Audit report of all UAT compliance violations)
  app.get<{ Querystring: { paymentId?: string } }>(
    '/_paysim/linter/violations',
    async (req, reply) => {
      const { paymentId } = req.query;
      const violations = checkUatViolations(db, { paymentId });
      return reply.code(200).send({
        count: violations.length,
        violations
      });
    }
  );

  // 14. GET /_paysim/state (JSON snapshot of system state)
  app.get('/_paysim/state', async (_req, reply) => {
    const totalPayments = (db.prepare('SELECT COUNT(*) as c FROM payments').get() as { c: number }).c;
    const completedPayments = (db.prepare("SELECT COUNT(*) as c FROM payments WHERE status = 'COMPLETED'").get() as { c: number }).c;
    const outboxPending = (db.prepare("SELECT COUNT(*) as c FROM ipn_outbox WHERE status = 'PENDING'").get() as { c: number }).c;
    const outboxRetry = (db.prepare("SELECT COUNT(*) as c FROM ipn_outbox WHERE status = 'RETRY'").get() as { c: number }).c;
    const outboxDelivered = (db.prepare("SELECT COUNT(*) as c FROM ipn_outbox WHERE status = 'DELIVERED'").get() as { c: number }).c;
    const outboxDead = (db.prepare("SELECT COUNT(*) as c FROM ipn_outbox WHERE status = 'DEAD'").get() as { c: number }).c;
    const totalViolations = (db.prepare("SELECT COUNT(*) as c FROM events WHERE kind LIKE 'UAT_RULE_%'").get() as { c: number }).c;

    const payments = db.prepare('SELECT * FROM payments ORDER BY created_at DESC, rowid DESC LIMIT 50').all();
    const outbox = db.prepare('SELECT * FROM ipn_outbox ORDER BY id DESC LIMIT 50').all();
    const events = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 100').all();
    const violations = checkUatViolations(db);

    return reply.code(200).send({
      summary: {
        total_payments: totalPayments,
        completed_payments: completedPayments,
        outbox_pending: outboxPending,
        outbox_retry: outboxRetry,
        outbox_delivered: outboxDelivered,
        outbox_dead: outboxDead,
        total_violations: totalViolations
      },
      payments,
      outbox,
      events,
      violations
    });
  });

  // 15. GET /_paysim/events/stream (Server-Sent Events real-time telemetry stream)
  app.get('/_paysim/events/stream', async (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    reply.raw.write(': connected\n\n');

    const onEvent = (event: unknown) => {
      try {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Stream may have closed
      }
    };

    telemetryBus.on('event', onEvent);

    await new Promise<void>((resolve) => {
      req.raw.on('close', () => {
        telemetryBus.off('event', onEvent);
        resolve();
      });
    });
  });

  // 16. POST /_paysim/outbox/:id/replay (Deterministic webhook redelivery)
  app.post<{ Params: { id: string } }>('/_paysim/outbox/:id/replay', async (req, reply) => {
    const idNum = parseInt(req.params.id, 10);
    if (isNaN(idNum)) {
      return reply.code(400).send({ error: 'Invalid outbox ID' });
    }

    const orig = db.prepare('SELECT * FROM ipn_outbox WHERE id = ?').get(idNum) as IpnOutboxRecord | undefined;
    if (!orig) {
      return reply.code(404).send({ error: 'Outbox item not found' });
    }

    const insertStmt = db.prepare(`
      INSERT INTO ipn_outbox (
        payment_id, sns_message_id, sns_type, payload, signature,
        attempts, next_attempt_at, locked_until, status
      ) VALUES (?, ?, ?, ?, ?, 0, ?, 0, 'PENDING')
    `);

    const result = insertStmt.run(
      orig.payment_id,
      orig.sns_message_id,
      orig.sns_type,
      orig.payload,
      orig.signature,
      clock.nowMs()
    );

    const newOutboxId = Number(result.lastInsertRowid);

    insertEvent(db, {
      ts: clock.nowMs(),
      kind: 'IPN_REPLAY_TRIGGERED',
      payment_id: orig.payment_id,
      request: JSON.stringify({ originalOutboxId: idNum }),
      response: JSON.stringify({ newOutboxId, status: 'PENDING' })
    });

    if (workerEvents) {
      workerEvents.emit('wake');
    }

    return reply.code(200).send({
      success: true,
      originalId: idNum,
      newOutboxId
    });
  });

  // 17. POST /_paysim/trigger/offline (Simulated USSD *247# or Merchant QR Payment)
  app.post('/_paysim/trigger/offline', async (req, reply) => {
    const parseResult = TriggerOfflineSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'Invalid offline payment parameters',
        details: parseResult.error.issues
      });
    }

    const { channel, amount, merchantInvoiceNumber, payerReference } = parseResult.data;
    const amountPaisa = parseAmountToPaisa(amount);
    const amountStr = formatPaisaToAmountString(amountPaisa);

    // Verified bKash transactionType codes
    const transactionType = channel === 'ussd' ? '10002175' : '10003126';
    const nowMs = clock.nowMs();
    const nowIso = clock.nowIso();

    const trxId = generateDeterministicTrxId(`offline-${nowMs}`);
    const paymentId = `OFFLINE-${channel.toUpperCase()}-${nowMs}`;
    const invoice = merchantInvoiceNumber ?? `INV-OFFLINE-${nowMs}`;
    const payerRef = payerReference ?? '01700000000';

    // Insert completed payment record
    insertPayment(db, {
      payment_id: paymentId,
      invoice,
      amount_paisa: amountPaisa,
      currency: 'BDT',
      mode: '0011',
      intent: transactionType,
      payer_reference: payerRef,
      customer_msisdn: payerRef,
      callback_url: '',
      status: 'COMPLETED',
      trx_id: trxId,
      created_at: nowMs,
      updated_at: nowMs
    });

    // Construct inner AWS SNS notification message
    const innerMessage = JSON.stringify({
      dateTime: nowIso,
      debitMSISDN: payerRef,
      amount: amountStr,
      currency: 'BDT',
      trxID: trxId,
      transactionStatus: 'Completed',
      merchantInvoiceNumber: invoice,
      paymentID: paymentId,
      payerReference: payerRef,
      transactionType
    });

    const host = req.headers.host ?? '127.0.0.1';
    const signingCertUrl = `http://${host}/.well-known/paysim-sns.pem`;

    const signedNotification = createSignedNotificationEnvelope(
      {
        Type: 'Notification',
        MessageId: crypto.randomUUID(),
        TopicArn: 'arn:aws:sns:ap-southeast-1:000000000000:bkash-ipn',
        Subject: 'bKash Payment Notification',
        Message: innerMessage,
        Timestamp: nowIso
      },
      signingCertUrl
    );

    const payload = JSON.stringify(signedNotification);

    // Insert into ipn_outbox
    const outboxResult = db.prepare(`
      INSERT INTO ipn_outbox (
        payment_id, sns_message_id, sns_type, payload, signature,
        attempts, next_attempt_at, locked_until, status
      ) VALUES (?, ?, 'Notification', ?, ?, 0, ?, 0, 'PENDING')
    `).run(
      paymentId,
      signedNotification.MessageId,
      payload,
      signedNotification.Signature,
      nowMs
    );

    const outboxId = Number(outboxResult.lastInsertRowid);

    insertEvent(db, {
      ts: nowMs,
      kind: 'OFFLINE_PAYMENT_TRIGGERED',
      payment_id: paymentId,
      request: JSON.stringify(req.body),
      response: JSON.stringify({ trxId, transactionType, outboxId })
    });

    if (workerEvents) {
      workerEvents.emit('wake');
    }

    return reply.code(200).send({
      success: true,
      channel,
      trxID: trxId,
      paymentId,
      outboxId
    });
  });

  // 18. GET /_paysim/inspector (Single-file embedded UI)
  app.get('/_paysim/inspector', async (_req, reply) => {
    return reply.type('text/html').send(renderInspectorHtml());
  });

  return app;
}
