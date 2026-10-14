import { describe, it, expect } from 'vitest';
import { transitionPayment } from '../../src/core/state-machine.js';

describe('Payment State Machine', () => {
  describe('Legal Transitions', () => {
    it('transitions INITIATED -> APPROVED via APPROVE_PAYMENT or WALLET_APPROVE', () => {
      const res1 = transitionPayment('INITIATED', 'APPROVE_PAYMENT');
      expect(res1).toEqual({ ok: true, nextStatus: 'APPROVED' });

      const res2 = transitionPayment('INITIATED', 'WALLET_APPROVE');
      expect(res2).toEqual({ ok: true, nextStatus: 'APPROVED' });
    });

    it('transitions APPROVED -> COMPLETED via EXECUTE_PAYMENT', () => {
      const res = transitionPayment('APPROVED', 'EXECUTE_PAYMENT');
      expect(res).toEqual({ ok: true, nextStatus: 'COMPLETED' });
    });

    it('transitions INITIATED -> CANCELLED via CANCEL_PAYMENT', () => {
      const res = transitionPayment('INITIATED', 'CANCEL_PAYMENT');
      expect(res).toEqual({ ok: true, nextStatus: 'CANCELLED' });
    });

    it('transitions INITIATED -> FAILED via FAIL_PAYMENT', () => {
      const res = transitionPayment('INITIATED', 'FAIL_PAYMENT');
      expect(res).toEqual({ ok: true, nextStatus: 'FAILED' });
    });

    it('transitions INITIATED -> EXPIRED via EXPIRE_PAYMENT', () => {
      const res = transitionPayment('INITIATED', 'EXPIRE_PAYMENT');
      expect(res).toEqual({ ok: true, nextStatus: 'EXPIRED' });
    });

    it('transitions APPROVED -> FAILED via FAIL_PAYMENT', () => {
      const res = transitionPayment('APPROVED', 'FAIL_PAYMENT');
      expect(res).toEqual({ ok: true, nextStatus: 'FAILED' });
    });

    it('transitions APPROVED -> EXPIRED via EXPIRE_PAYMENT', () => {
      const res = transitionPayment('APPROVED', 'EXPIRE_PAYMENT');
      expect(res).toEqual({ ok: true, nextStatus: 'EXPIRED' });
    });
  });

  describe('bKash UAT Rule 2 & EXECUTE_PAYMENT constraints', () => {
    it('flags UAT violation when EXECUTE_PAYMENT is called on INITIATED status', () => {
      const res = transitionPayment('INITIATED', 'EXECUTE_PAYMENT');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.uatViolation).toBe('UAT_RULE_2_EXECUTE_WITHOUT_SUCCESS_CALLBACK');
        expect(res.statusCode).toBe('2019');
      }
    });

    it('flags UAT violation when EXECUTE_PAYMENT is called on FAILED status', () => {
      const res = transitionPayment('FAILED', 'EXECUTE_PAYMENT');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.uatViolation).toBe('UAT_RULE_2_EXECUTE_WITHOUT_SUCCESS_CALLBACK');
        expect(res.statusCode).toBe('2029');
      }
    });

    it('flags UAT violation when EXECUTE_PAYMENT is called on CANCELLED status', () => {
      const res = transitionPayment('CANCELLED', 'EXECUTE_PAYMENT');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.uatViolation).toBe('UAT_RULE_2_EXECUTE_WITHOUT_SUCCESS_CALLBACK');
        expect(res.statusCode).toBe('2030');
      }
    });

    it('flags UAT violation when EXECUTE_PAYMENT is called on EXPIRED status', () => {
      const res = transitionPayment('EXPIRED', 'EXECUTE_PAYMENT');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.uatViolation).toBe('UAT_RULE_2_EXECUTE_WITHOUT_SUCCESS_CALLBACK');
        expect(res.statusCode).toBe('2069');
      }
    });

    it('rejects duplicate EXECUTE_PAYMENT on COMPLETED status with statusCode 2062 without duplicate trxID', () => {
      const res = transitionPayment('COMPLETED', 'EXECUTE_PAYMENT');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.statusCode).toBe('2062');
        expect(res.statusMessage).toMatch(/already been completed/);
        // Duplicate execute on completed is a business rejection, not callback-skipping UAT violation
        expect(res.uatViolation).toBeUndefined();
      }
    });
  });

  describe('Terminal state protections', () => {
    it('prevents cancelling or approving an already COMPLETED payment', () => {
      const cancelRes = transitionPayment('COMPLETED', 'CANCEL_PAYMENT');
      expect(cancelRes.ok).toBe(false);

      const approveRes = transitionPayment('COMPLETED', 'APPROVE_PAYMENT');
      expect(approveRes.ok).toBe(false);
    });

    it('prevents approving an already CANCELLED or FAILED payment', () => {
      expect(transitionPayment('CANCELLED', 'APPROVE_PAYMENT').ok).toBe(false);
      expect(transitionPayment('FAILED', 'APPROVE_PAYMENT').ok).toBe(false);
    });
  });
});
