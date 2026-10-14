/**
 * Payment State Machine:
 * States: INITIATED -> APPROVED (wallet approved) -> COMPLETED
 * Terminal: FAILED, CANCELLED, EXPIRED
 *
 * Invariant 2:
 * - Calling /execute before APPROVED MUST fail and record UAT violation
 *   UAT_RULE_2_EXECUTE_WITHOUT_SUCCESS_CALLBACK.
 * - Calling /execute a second time on a COMPLETED payment MUST return an error (statusCode: 2062)
 *   and NEVER generate a second trxID.
 */

export type PaymentStatus =
  | 'INITIATED'
  | 'APPROVED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED';

export type PaymentAction =
  | 'APPROVE_PAYMENT'
  | 'WALLET_APPROVE'
  | 'EXECUTE_PAYMENT'
  | 'CANCEL_PAYMENT'
  | 'FAIL_PAYMENT'
  | 'EXPIRE_PAYMENT';

export type UatViolation = 'UAT_RULE_2_EXECUTE_WITHOUT_SUCCESS_CALLBACK';

export interface TransitionSuccess {
  ok: true;
  nextStatus: PaymentStatus;
}

export interface TransitionFailure {
  ok: false;
  statusCode: string;
  statusMessage: string;
  uatViolation?: UatViolation;
}

export type TransitionResult = TransitionSuccess | TransitionFailure;

export function transitionPayment(current: PaymentStatus, action: PaymentAction): TransitionResult {
  // Check execute payment constraints first
  if (action === 'EXECUTE_PAYMENT') {
    switch (current) {
      case 'APPROVED':
        return { ok: true, nextStatus: 'COMPLETED' };

      case 'COMPLETED':
        return {
          ok: false,
          statusCode: '2062',
          statusMessage: 'The payment has already been completed'
        };

      case 'INITIATED':
        return {
          ok: false,
          statusCode: '2019',
          statusMessage: 'Cannot execute payment: payment has not been approved by wallet callback',
          uatViolation: 'UAT_RULE_2_EXECUTE_WITHOUT_SUCCESS_CALLBACK'
        };

      case 'FAILED':
        return {
          ok: false,
          statusCode: '2029',
          statusMessage: 'Cannot execute payment: payment is in FAILED state',
          uatViolation: 'UAT_RULE_2_EXECUTE_WITHOUT_SUCCESS_CALLBACK'
        };

      case 'CANCELLED':
        return {
          ok: false,
          statusCode: '2030',
          statusMessage: 'Cannot execute payment: payment was CANCELLED by user',
          uatViolation: 'UAT_RULE_2_EXECUTE_WITHOUT_SUCCESS_CALLBACK'
        };

      case 'EXPIRED':
        return {
          ok: false,
          statusCode: '2069',
          statusMessage: 'Cannot execute payment: payment window has EXPIRED',
          uatViolation: 'UAT_RULE_2_EXECUTE_WITHOUT_SUCCESS_CALLBACK'
        };
    }
  }

  // Handle wallet approval
  if (action === 'APPROVE_PAYMENT' || action === 'WALLET_APPROVE') {
    if (current === 'INITIATED') {
      return { ok: true, nextStatus: 'APPROVED' };
    }
    return {
      ok: false,
      statusCode: '2023',
      statusMessage: `Cannot approve payment in state "${current}"`
    };
  }

  // Handle cancel
  if (action === 'CANCEL_PAYMENT') {
    if (current === 'INITIATED') {
      return { ok: true, nextStatus: 'CANCELLED' };
    }
    return {
      ok: false,
      statusCode: '2024',
      statusMessage: `Cannot cancel payment in state "${current}"`
    };
  }

  // Handle failure
  if (action === 'FAIL_PAYMENT') {
    if (current === 'INITIATED' || current === 'APPROVED') {
      return { ok: true, nextStatus: 'FAILED' };
    }
    return {
      ok: false,
      statusCode: '2025',
      statusMessage: `Cannot mark payment as failed in state "${current}"`
    };
  }

  // Handle expiration
  if (action === 'EXPIRE_PAYMENT') {
    if (current === 'INITIATED' || current === 'APPROVED') {
      return { ok: true, nextStatus: 'EXPIRED' };
    }
    return {
      ok: false,
      statusCode: '2026',
      statusMessage: `Cannot expire payment in state "${current}"`
    };
  }

  return {
    ok: false,
    statusCode: '2001',
    statusMessage: `Invalid payment action "${action}" for status "${current}"`
  };
}
