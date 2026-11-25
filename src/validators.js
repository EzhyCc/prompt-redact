/** Pure validators for Open Privacy. Zero runtime dependencies. */

/** @param {unknown} value @returns {boolean} */
export function luhn(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const digits = String(value).replace(/[^0-9]/g, '');
  if (digits.length < 12) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

/** @param {unknown} value @returns {boolean} */
export function cnMobile(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  return /^1[3-9][0-9]{9}$/.test(String(value).replace(/[\s-]/g, ''));
}

/** @param {unknown} value @returns {boolean} */
export function cnIdCard(value) {
  if (typeof value !== 'string' || !/^[0-9]{17}[0-9Xx]$/.test(value)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checkChars = '10X98765432';
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    sum += (value.charCodeAt(i) - 48) * weights[i];
  }
  return checkChars[sum % 11] === value[17].toUpperCase();
}

/** @param {unknown} value @returns {boolean} */
export function cnUscc(value) {
  if (typeof value !== 'string' || value.length !== 18) return false;
  const charset = '0123456789ABCDEFGHJKLMNPQRTUWXY';
  const weights = [1, 3, 9, 27, 135, 405, 1215, 3645, 10935, 32805, 98415, 295245, 885735, 2657205, 7971615, 23914845, 71744535];
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    const index = charset.indexOf(value[i]);
    if (index === -1) return false;
    sum += index * weights[i];
  }
  if (charset.indexOf(value[17]) === -1) return false;
  return charset[(31 - (sum % 31)) % 31] === value[17];
}

/** @param {unknown} value @returns {boolean} */
export function ipv4(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return false;
    if (Number(part) > 255) return false;
  }
  return true;
}

/** @type {Readonly<Record<string, (value: unknown) => boolean>>} */
export const validators = Object.freeze({ cnMobile, cnIdCard, cnUscc, luhn, ipv4 });
