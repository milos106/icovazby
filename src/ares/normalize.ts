/**
 * Strip whitespace, optional "CZ" prefix, dashes/dots, and pad to 8 digits.
 * Returns null if the input cannot be normalized to a digit-only string of
 * at most 8 characters.
 */
export function normalizeIco(input: string): string | null {
  if (typeof input !== "string") return null;
  let cleaned = input.trim().toUpperCase();
  if (cleaned.startsWith("CZ")) cleaned = cleaned.slice(2);
  cleaned = cleaned.replace(/[\s\-.]/g, "");
  if (!/^\d+$/.test(cleaned)) return null;
  if (cleaned.length > 8) return null;
  return cleaned.padStart(8, "0");
}

/**
 * Validate a Czech IČO via the ČSÚ Mod-11 algorithm.
 *
 * Steps:
 *   1. Pad input to 8 digits.
 *   2. Multiply first seven digits by weights [8, 7, 6, 5, 4, 3, 2] and sum.
 *   3. Compute `r = sum mod 11`.
 *   4. The expected 8th (check) digit is:
 *        - 1  when r == 0
 *        - 0  when r == 1
 *        - 11 - r  otherwise (always in range 2..9)
 *
 * A naive `(11 - r) mod 10` is wrong for r == 1 — it yields 0 by coincidence,
 * but the canonical spec is explicit and rejects different historical
 * misinterpretations. Real-world IČOs like 26185610 (AGROFERT) hit r == 1
 * with check digit 0, so getting this branch right matters.
 */
export function isValidIcoChecksum(ico: string): boolean {
  if (!/^\d{8}$/.test(ico)) return false;
  const weights = [8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    sum += Number(ico[i]) * (weights[i] ?? 0);
  }
  const remainder = sum % 11;
  let expected: number;
  if (remainder === 0) expected = 1;
  else if (remainder === 1) expected = 0;
  else expected = 11 - remainder;
  return Number(ico[7]) === expected;
}

export interface IcoValidationResult {
  valid: boolean;
  normalized: string | null;
  reason?: "INVALID_FORMAT" | "INVALID_CHECKSUM";
}

export function validateIco(input: string): IcoValidationResult {
  const normalized = normalizeIco(input);
  if (normalized === null) {
    return { valid: false, normalized: null, reason: "INVALID_FORMAT" };
  }
  if (!isValidIcoChecksum(normalized)) {
    return { valid: false, normalized, reason: "INVALID_CHECKSUM" };
  }
  return { valid: true, normalized };
}

/**
 * Czech DIČ for legal entities is "CZ" + IČO. For individuals it's "CZ" +
 * rodné číslo or a generated identifier; we don't validate those structurally.
 */
export function normalizeDic(input: string): string | null {
  if (typeof input !== "string") return null;
  const cleaned = input.trim().toUpperCase().replace(/\s/g, "");
  if (!/^CZ[0-9]{8,10}$/.test(cleaned)) return null;
  return cleaned;
}
