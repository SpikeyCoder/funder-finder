// EINs aren't stored consistently: some tables and links keep the leading
// zero ("062618866"), others drop it ("62618866"), and people type a dash
// ("06-2618866").

/** The EIN's digits if the input looks like an EIN (8–9 digits, optional dash), else null. */
export function einDigits(input: string): string | null {
  const s = input.trim();
  // An unpadded EIN loses at most one leading zero: 8 or 9 digits.
  return /^\d{2}-?\d{7}$|^\d{8,9}$/.test(s) ? s.replace(/\D/g, "") : null;
}

/** Both stored forms of an EIN (zero-padded and unpadded), for an `in.(…)` match. */
export function einVariants(digits: string): string[] {
  return [...new Set([digits.padStart(9, "0"), digits.replace(/^0+/, "")])].filter(Boolean);
}
