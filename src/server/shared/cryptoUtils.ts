import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from './apiError';

export function getSensitiveEncryptionKey(): Buffer {
  const configuredKey = String(process.env.ENCRYPTION_MASTER_KEY || '').trim();
  if (!configuredKey) throw new ApiError(503, 'ENCRYPTION_KEY_NOT_CONFIGURED', 'configuration', 'A 32-byte encryption key is required.', 'Kunci enkripsi server belum dikonfigurasi.');
  if (/^[0-9a-fA-F]{64}$/.test(configuredKey)) return Buffer.from(configuredKey, 'hex');
  const buf = Buffer.from(configuredKey, 'utf8');
  if (buf.length === 32) return buf;
  return createHash('sha256').update(configuredKey).digest();
}

export function encryptSensitiveString(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getSensitiveEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64') };
}

export function decryptSensitiveString(record: { ciphertext: string; iv: string; authTag: string }): string {
  const decipher = createDecipheriv('aes-256-gcm', getSensitiveEncryptionKey(), Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

export function generateServerTotpSecret(length = 32): string {
  const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += BASE32_ALPHABET[bytes[i] % 32];
  }
  return result;
}

export function base32Decode(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(value || '').toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
  if (!clean) return Buffer.alloc(0);
  let bits = 0; let buffer = 0; const out: number[] = [];
  for (const char of clean) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) continue;
    buffer = (buffer << 5) | idx; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((buffer >> bits) & 0xff); }
  }
  return Buffer.from(out);
}

export function calculateTotp(secret: string, counter: number): string {
  const cleanSecret = String(secret || '').replace(/\s+/g, '').toUpperCase();
  const secretBuffer = base32Decode(cleanSecret);
  if (secretBuffer.length === 0) return '000000';
  const data = Buffer.alloc(8);
  data.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  data.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', secretBuffer).update(data).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) | ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

export function verifyServerTotp(token: string, secret: string, window = 1): { valid: boolean; counter?: number } {
  const cleanToken = String(token || '').replace(/\D/g, '').trim();
  const cleanSecret = String(secret || '').replace(/\s+/g, '').toUpperCase();
  if (!/^\d{6}$/.test(cleanToken)) return { valid: false };
  if (!cleanSecret || cleanSecret.length < 16) return { valid: false };

  try {
    const counter = Math.floor(Date.now() / 1000 / 30);
    const tokenBuf = Buffer.from(cleanToken);
    for (let offset = -window; offset <= window; offset += 1) {
      const candidate = counter + offset;
      const expectedCode = calculateTotp(cleanSecret, candidate);
      const expectedBuf = Buffer.from(expectedCode);
      if (expectedBuf.length === tokenBuf.length && timingSafeEqual(expectedBuf, tokenBuf)) {
        return { valid: true, counter: candidate };
      }
    }
  } catch (_err) {
    return { valid: false };
  }
  return { valid: false };
}

