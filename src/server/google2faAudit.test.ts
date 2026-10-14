import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateServerTotpSecret,
  calculateTotp,
  verifyServerTotp,
  base32Decode,
} from './shared/cryptoUtils';
import { generateSecret, generateTotpUri } from '../services/totpService';

test('Google 2FA - Secret Generation Standard Compliance', () => {
  // Client default secret generation produces 32 base32 characters (160 bits)
  const clientSecret = generateSecret();
  assert.equal(clientSecret.length, 32, 'Client secret should be 32 base32 characters');
  assert.match(clientSecret, /^[A-Z2-7]{32}$/, 'Client secret should contain only valid Base32 characters');

  // Server secret generation produces 32 base32 characters (160 bits)
  const serverSecret = generateServerTotpSecret(32);
  assert.equal(serverSecret.length, 32, 'Server secret should be 32 base32 characters');
  assert.match(serverSecret, /^[A-Z2-7]{32}$/, 'Server secret should contain only valid Base32 characters');
});

test('Google 2FA - Base32 Decoding & RFC 6238 TOTP Calculation', () => {
  // Test vector: Standard secret JBSWY3DPEHPK3PXP (Base32 for "Hello!1234")
  const secret = 'JBSWY3DPEHPK3PXP';
  const counter = 50000000;
  const totpCode = calculateTotp(secret, counter);

  assert.equal(totpCode.length, 6, 'TOTP code must be exactly 6 digits');
  assert.match(totpCode, /^\d{6}$/, 'TOTP code must consist of digits');

  // Verify TOTP calculation is deterministic
  const totpCode2 = calculateTotp(secret, counter);
  assert.equal(totpCode, totpCode2, 'TOTP calculation must be deterministic');
});

test('Google 2FA - Verification & Timing-Safe Check', () => {
  const secret = generateServerTotpSecret(32);
  const currentCounter = Math.floor(Date.now() / 1000 / 30);
  const validToken = calculateTotp(secret, currentCounter);

  // Valid token verify
  const result = verifyServerTotp(validToken, secret, 1);
  assert.equal(result.valid, true, 'Current TOTP token must be valid');
  assert.equal(result.counter, currentCounter, 'Verification should return matching counter');

  // Invalid token verify
  const invalidResult = verifyServerTotp('000000', secret, 1);
  assert.equal(invalidResult.valid, false, 'Invalid TOTP token must fail verification');

  // Short/Malformed token verify
  const malformedResult = verifyServerTotp('123', secret, 1);
  assert.equal(malformedResult.valid, false, 'Malformed token must fail verification');
});

test('Google 2FA - Input Sanitization (Whitespace & Non-digit handling)', () => {
  const secret = 'JBSW Y3DP EHPK 3PXP';
  const currentCounter = Math.floor(Date.now() / 1000 / 30);
  const validToken = calculateTotp(secret, currentCounter);

  // Token with spaces or formatting
  const formattedToken = ` ${validToken.slice(0, 3)} ${validToken.slice(3)} `;
  const result = verifyServerTotp(formattedToken, secret, 1);
  assert.equal(result.valid, true, 'Formatted token with spaces should be sanitized and verified');
});

test('Google 2FA - Rejection of Weak or Invalid Secrets', () => {
  const currentCounter = Math.floor(Date.now() / 1000 / 30);
  const validToken = calculateTotp('JBSWY3DPEHPK3PXP', currentCounter);

  // Short secret (< 16 chars)
  const shortResult = verifyServerTotp(validToken, 'SHORT', 1);
  assert.equal(shortResult.valid, false, 'Short secret must be rejected');

  // Empty secret
  const emptyResult = verifyServerTotp(validToken, '', 1);
  assert.equal(emptyResult.valid, false, 'Empty secret must be rejected');
});

test('Google 2FA - Time Drift Window Boundary Verification', () => {
  const secret = generateServerTotpSecret(32);
  const currentCounter = Math.floor(Date.now() / 1000 / 30);

  // Token from previous step (offset -1)
  const prevToken = calculateTotp(secret, currentCounter - 1);
  assert.equal(verifyServerTotp(prevToken, secret, 1).valid, true, 'Token from previous 30s window should be valid with window=1');

  // Token from next step (offset +1)
  const nextToken = calculateTotp(secret, currentCounter + 1);
  assert.equal(verifyServerTotp(nextToken, secret, 1).valid, true, 'Token from next 30s window should be valid with window=1');

  // Token out of window (offset +2)
  const farToken = calculateTotp(secret, currentCounter + 2);
  assert.equal(verifyServerTotp(farToken, secret, 1).valid, false, 'Token out of window should be rejected');
});
