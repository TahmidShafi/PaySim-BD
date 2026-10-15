import crypto from 'node:crypto';
import {
  buildNotificationCanonicalString,
  buildSubscriptionConfirmationCanonicalString,
  type SnsNotificationFields,
  type SnsSubscriptionConfirmationFields
} from './sns-signer.js';

export interface VerifySnsOptions {
  allowedCertHosts?: string[];
}

export interface SnsVerificationResult {
  valid: boolean;
  error?: string;
  type?: 'Notification' | 'SubscriptionConfirmation';
}

const certCache = new Map<string, string>();

export function clearCertCache(): void {
  certCache.clear();
}

/**
 * Fetches and caches X.509 certificate with strict host-validation against AWS SNS or allowed hostnames.
 */
export async function fetchAndCacheCert(
  urlStr: string,
  allowedHosts: string[] = ['localhost', '127.0.0.1']
): Promise<string> {
  const cached = certCache.get(urlStr);
  if (cached) return cached;

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`Invalid SigningCertURL: "${urlStr}"`);
  }

  const hostname = parsed.hostname;
  const isAwsSns = /^sns\.[a-zA-Z0-9-]+\.amazonaws\.com$/.test(hostname);
  const isAllowedHost = allowedHosts.includes(hostname);

  if (!isAwsSns && !isAllowedHost) {
    throw new Error(`SigningCertURL host "${hostname}" is not allowed`);
  }

  if (!parsed.pathname.endsWith('.pem')) {
    throw new Error(`SigningCertURL must point to a .pem file: "${urlStr}"`);
  }

  const res = await fetch(urlStr);
  if (!res.ok) {
    throw new Error(`Failed to fetch certificate from "${urlStr}": HTTP ${res.status}`);
  }

  const pem = await res.text();
  if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error('Fetched file is not a valid PEM certificate');
  }

  certCache.set(urlStr, pem);
  return pem;
}

/**
 * Verifies an AWS SNS SignatureVersion "1" message payload using RSA-SHA1.
 */
export async function verifySnsMessage(
  payload: unknown,
  options: VerifySnsOptions = {}
): Promise<SnsVerificationResult> {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, error: 'Payload must be a JSON object' };
  }

  const data = payload as Record<string, unknown>;

  if (data['SignatureVersion'] !== '1') {
    return {
      valid: false,
      error: `Unsupported SignatureVersion: ${String(data['SignatureVersion'])}`
    };
  }

  const signature = data['Signature'];
  if (typeof signature !== 'string' || !signature) {
    return { valid: false, error: 'Missing Signature' };
  }

  const signingCertUrl = data['SigningCertURL'];
  if (typeof signingCertUrl !== 'string' || !signingCertUrl) {
    return { valid: false, error: 'Missing SigningCertURL' };
  }

  let certPem: string;
  try {
    certPem = await fetchAndCacheCert(
      signingCertUrl,
      options.allowedCertHosts ?? ['localhost', '127.0.0.1']
    );
  } catch (err: unknown) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }

  const type = String(data['Type'] ?? '');
  let canonicalStr = '';

  if (type === 'Notification') {
    const fields: SnsNotificationFields = {
      Type: 'Notification',
      MessageId: String(data['MessageId'] ?? ''),
      TopicArn: String(data['TopicArn'] ?? ''),
      Message: String(data['Message'] ?? ''),
      Timestamp: String(data['Timestamp'] ?? '')
    };
    if (data['Subject'] !== undefined) {
      fields.Subject = String(data['Subject']);
    }
    canonicalStr = buildNotificationCanonicalString(fields);
  } else if (type === 'SubscriptionConfirmation') {
    const fields: SnsSubscriptionConfirmationFields = {
      Type: 'SubscriptionConfirmation',
      MessageId: String(data['MessageId'] ?? ''),
      Token: String(data['Token'] ?? ''),
      TopicArn: String(data['TopicArn'] ?? ''),
      Message: String(data['Message'] ?? ''),
      SubscribeURL: String(data['SubscribeURL'] ?? ''),
      Timestamp: String(data['Timestamp'] ?? '')
    };
    canonicalStr = buildSubscriptionConfirmationCanonicalString(fields);
  } else {
    return { valid: false, error: `Unsupported SNS message type: ${type}` };
  }

  try {
    const verifier = crypto.createVerify('RSA-SHA1');
    verifier.update(canonicalStr, 'utf8');
    const isValid = verifier.verify(certPem, signature, 'base64');
    return {
      valid: isValid,
      type: type as 'Notification' | 'SubscriptionConfirmation',
      error: isValid ? undefined : 'Signature verification failed'
    };
  } catch (err: unknown) {
    return {
      valid: false,
      error: `Crypto verification error: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}
