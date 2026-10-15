import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_TEST_PRIVATE_KEY_PATH = path.join(__dirname, 'certs', 'test-key.pem');
export const DEFAULT_TEST_CERT_PATH = path.join(__dirname, 'certs', 'test-cert.pem');

export function loadDefaultTestPrivateKey(): string {
  return fs.readFileSync(DEFAULT_TEST_PRIVATE_KEY_PATH, 'utf8');
}

export function loadDefaultTestCertificate(): string {
  return fs.readFileSync(DEFAULT_TEST_CERT_PATH, 'utf8');
}

export interface SnsNotificationFields {
  Type: 'Notification';
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SigningCertURL?: string;
}

export interface SnsSubscriptionConfirmationFields {
  Type: 'SubscriptionConfirmation';
  MessageId: string;
  Token: string;
  TopicArn: string;
  Message: string;
  SubscribeURL: string;
  Timestamp: string;
  SigningCertURL?: string;
}

export interface SignedSnsEnvelope {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: '1';
  Signature: string;
  SigningCertURL: string;
  Token?: string;
  SubscribeURL?: string;
}

/**
 * Builds exact canonical string for AWS SNS Notification (alphabetical order, \n after every key & value).
 */
export function buildNotificationCanonicalString(env: SnsNotificationFields): string {
  let s = `Message\n${env.Message}\nMessageId\n${env.MessageId}\n`;
  if (env.Subject !== undefined) {
    s += `Subject\n${env.Subject}\n`;
  }
  s += `Timestamp\n${env.Timestamp}\nTopicArn\n${env.TopicArn}\nType\nNotification\n`;
  return s;
}

/**
 * Builds exact canonical string for AWS SNS SubscriptionConfirmation.
 */
export function buildSubscriptionConfirmationCanonicalString(
  env: SnsSubscriptionConfirmationFields
): string {
  return `Message\n${env.Message}\nMessageId\n${env.MessageId}\nSubscribeURL\n${env.SubscribeURL}\nTimestamp\n${env.Timestamp}\nToken\n${env.Token}\nTopicArn\n${env.TopicArn}\nType\nSubscriptionConfirmation\n`;
}

/**
 * Signs a canonical string using RSA-SHA1 (AWS SNS SignatureVersion: "1") and returns base64.
 */
export function signCanonicalString(canonicalStr: string, privateKeyPem?: string): string {
  const key = privateKeyPem ?? loadDefaultTestPrivateKey();
  const signer = crypto.createSign('RSA-SHA1');
  signer.update(canonicalStr, 'utf8');
  return signer.sign(key, 'base64');
}

export function createSignedNotificationEnvelope(
  fields: SnsNotificationFields,
  signingCertUrl: string,
  privateKeyPem?: string
): SignedSnsEnvelope {
  const canonical = buildNotificationCanonicalString(fields);
  const signature = signCanonicalString(canonical, privateKeyPem);

  const env: SignedSnsEnvelope = {
    Type: 'Notification',
    MessageId: fields.MessageId,
    TopicArn: fields.TopicArn,
    Message: fields.Message,
    Timestamp: fields.Timestamp,
    SignatureVersion: '1',
    Signature: signature,
    SigningCertURL: signingCertUrl
  };

  if (fields.Subject !== undefined) {
    env.Subject = fields.Subject;
  }

  return env;
}

export function createSignedSubscriptionConfirmationEnvelope(
  fields: SnsSubscriptionConfirmationFields,
  signingCertUrl: string,
  privateKeyPem?: string
): SignedSnsEnvelope {
  const canonical = buildSubscriptionConfirmationCanonicalString(fields);
  const signature = signCanonicalString(canonical, privateKeyPem);

  return {
    Type: 'SubscriptionConfirmation',
    MessageId: fields.MessageId,
    Token: fields.Token,
    TopicArn: fields.TopicArn,
    Message: fields.Message,
    SubscribeURL: fields.SubscribeURL,
    Timestamp: fields.Timestamp,
    SignatureVersion: '1',
    Signature: signature,
    SigningCertURL: signingCertUrl
  };
}
