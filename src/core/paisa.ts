/**
 * No Floating-Point Money:
 * Wire format (`amount`) is ALWAYS a decimal string (e.g., "500", "20.50").
 * Database storage (`amount_paisa`) is ALWAYS an integer in paisa (50000, 2050).
 * Never use parseFloat or floating-point math for money.
 */

const AMOUNT_REGEX = /^(?<intPart>0|[1-9]\d*)(?:\.(?<fracPart>\d{1,2}))?$/;

/**
 * Parses an amount string (e.g. "500", "20.5", "20.50") into integer paisa.
 * Enforces strict validation and zero floating-point operations.
 */
export function parseAmountToPaisa(amountStr: string): number {
  if (typeof amountStr !== 'string') {
    throw new TypeError(`Amount must be a string, received ${typeof amountStr}`);
  }

  const trimmed = amountStr.trim();
  if (trimmed !== amountStr || trimmed.length === 0) {
    throw new Error(`Invalid amount string: "${amountStr}". Leading/trailing whitespace or empty string not allowed.`);
  }

  const match = AMOUNT_REGEX.exec(amountStr);
  if (!match || !match.groups) {
    throw new Error(
      `Invalid amount format: "${amountStr}". Expected positive decimal string with up to 2 decimal places.`
    );
  }

  const intPartStr = match.groups['intPart'] ?? '0';
  const fracPartStr = match.groups['fracPart'] ?? '';

  let fracPaisa = 0n;
  if (fracPartStr.length === 1) {
    fracPaisa = BigInt(fracPartStr) * 10n;
  } else if (fracPartStr.length === 2) {
    fracPaisa = BigInt(fracPartStr);
  }

  const intPaisa = BigInt(intPartStr) * 100n;
  const totalPaisa = intPaisa + fracPaisa;

  if (totalPaisa <= 0n) {
    throw new Error(`Amount must be greater than zero, received: "${amountStr}"`);
  }

  if (totalPaisa > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Amount exceeds maximum safe integer: "${amountStr}"`);
  }

  return Number(totalPaisa);
}

/**
 * Formats integer paisa into a standard 2-decimal place string (e.g. 50000 -> "500.00", 2050 -> "20.50").
 * Uses BigInt integer division with zero floating-point operations.
 */
export function formatPaisaToAmountString(paisa: number): string {
  if (!Number.isSafeInteger(paisa) || paisa < 0) {
    throw new TypeError(`Paisa must be a non-negative safe integer, received: ${paisa}`);
  }

  const p = BigInt(paisa);
  const intPart = p / 100n;
  const fracPart = p % 100n;

  return `${intPart.toString()}.${fracPart.toString().padStart(2, '0')}`;
}
