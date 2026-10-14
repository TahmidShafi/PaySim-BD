import { describe, it, expect } from 'vitest';
import { parseAmountToPaisa, formatPaisaToAmountString } from '../../src/core/paisa.js';

describe('Paisa Parser & Formatter', () => {
  describe('parseAmountToPaisa - valid inputs', () => {
    it('parses whole integer amount strings', () => {
      expect(parseAmountToPaisa('500')).toBe(50000);
      expect(parseAmountToPaisa('1')).toBe(100);
      expect(parseAmountToPaisa('1000')).toBe(100000);
    });

    it('parses single decimal place strings (representing tenths of Taka = tens of paisa)', () => {
      expect(parseAmountToPaisa('20.5')).toBe(2050);
      expect(parseAmountToPaisa('1.1')).toBe(110);
      expect(parseAmountToPaisa('0.5')).toBe(50);
    });

    it('parses two decimal place strings', () => {
      expect(parseAmountToPaisa('20.50')).toBe(2050);
      expect(parseAmountToPaisa('0.01')).toBe(1);
      expect(parseAmountToPaisa('0.99')).toBe(99);
      expect(parseAmountToPaisa('12345.67')).toBe(1234567);
    });
  });

  describe('parseAmountToPaisa - invalid inputs', () => {
    it('rejects negative numbers', () => {
      expect(() => parseAmountToPaisa('-10')).toThrow(/Invalid amount format/);
      expect(() => parseAmountToPaisa('-0.50')).toThrow(/Invalid amount format/);
    });

    it('rejects numbers with more than 2 decimal places', () => {
      expect(() => parseAmountToPaisa('12.345')).toThrow(/Invalid amount format/);
      expect(() => parseAmountToPaisa('1.001')).toThrow(/Invalid amount format/);
    });

    it('rejects non-numeric strings', () => {
      expect(() => parseAmountToPaisa('abc')).toThrow(/Invalid amount format/);
      expect(() => parseAmountToPaisa('12a.5')).toThrow(/Invalid amount format/);
      expect(() => parseAmountToPaisa('$50')).toThrow(/Invalid amount format/);
      expect(() => parseAmountToPaisa('')).toThrow();
    });

    it('rejects zero amounts', () => {
      expect(() => parseAmountToPaisa('0')).toThrow(/greater than zero/);
      expect(() => parseAmountToPaisa('0.0')).toThrow(/greater than zero/);
      expect(() => parseAmountToPaisa('0.00')).toThrow(/greater than zero/);
    });

    it('rejects leading/trailing whitespace or invalid dots', () => {
      expect(() => parseAmountToPaisa(' 500 ')).toThrow();
      expect(() => parseAmountToPaisa('.50')).toThrow();
      expect(() => parseAmountToPaisa('50.')).toThrow();
    });

    it('rejects raw numbers (preventing float precision loss at call site)', () => {
      // @ts-expect-error testing runtime type guard
      expect(() => parseAmountToPaisa(12.5)).toThrow(TypeError);
      // @ts-expect-error testing runtime type guard
      expect(() => parseAmountToPaisa(500)).toThrow(TypeError);
    });
  });

  describe('formatPaisaToAmountString', () => {
    it('formats paisa to 2-decimal string', () => {
      expect(formatPaisaToAmountString(50000)).toBe('500.00');
      expect(formatPaisaToAmountString(2050)).toBe('20.50');
      expect(formatPaisaToAmountString(1)).toBe('0.01');
      expect(formatPaisaToAmountString(50)).toBe('0.50');
      expect(formatPaisaToAmountString(0)).toBe('0.00');
    });

    it('guarantees round-trip equality for valid amounts', () => {
      const amounts = ['500.00', '20.50', '0.01', '99.99', '100000.00'];
      for (const amt of amounts) {
        expect(formatPaisaToAmountString(parseAmountToPaisa(amt))).toBe(amt);
      }
    });

    it('rejects negative or non-integer values', () => {
      expect(() => formatPaisaToAmountString(-1)).toThrow(TypeError);
      expect(() => formatPaisaToAmountString(12.5)).toThrow(TypeError);
      // @ts-expect-error testing runtime type guard
      expect(() => formatPaisaToAmountString('500')).toThrow(TypeError);
    });
  });
});
