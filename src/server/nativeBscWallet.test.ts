import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveNativeBscAddressFromSeedHex } from './nativeBscWallet';

test('derives the canonical EVM BIP32/BIP44 address at index 0', () => {
  const seed = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
  assert.equal(
    deriveNativeBscAddressFromSeedHex(seed, 0),
    '0x919538116b4f25f1ce01429fd9ed7964556bf565',
  );
});

test('getNativeWalletStatus includes default autoWithdrawalMaxAmount', async () => {
  const { getNativeWalletStatus } = await import('./nativeBscWallet');
  const status = await getNativeWalletStatus();
  assert.equal(typeof status.autoWithdrawalMaxAmount, 'number');
  assert.ok(status.autoWithdrawalMaxAmount > 0);
});
