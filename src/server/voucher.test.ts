import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVoucherInDb,
  getVouchersFromDb,
  toggleVoucherStatusInDb,
  deleteVoucherInDb,
  validateVoucherForUserInDb,
} from './database';

test('Voucher System - Creation, Validation, Percentage & Fixed Discounts', async (t) => {
  await t.test('creates percentage voucher and validates discount calculation', async () => {
    const code = `TESTPCT_${Date.now()}`;
    const voucher = await createVoucherInDb({
      code,
      discountType: 'PERCENTAGE',
      discountValue: 20, // 20% OFF
      applicableTier: 'all',
      maxUses: 10,
    });

    assert.equal(voucher.code, code);
    assert.equal(voucher.discountType, 'PERCENTAGE');
    assert.equal(voucher.discountValue, 20);
    assert.equal(voucher.isActive, true);

    const validation = await validateVoucherForUserInDb({
      code,
      firebaseUid: 'test-user-uid-1',
      tier: 'starter_6',
      originalFee: 150,
    });

    assert.equal(validation.valid, true);
    assert.equal(validation.discountAmount, 30); // 20% of 150 = 30
    assert.equal(validation.finalFee, 120); // 150 - 30 = 120
  });

  await t.test('creates fixed USDT voucher and validates discount calculation', async () => {
    const code = `TESTFIXED_${Date.now()}`;
    const voucher = await createVoucherInDb({
      code,
      discountType: 'FIXED',
      discountValue: 50, // 50 USDT OFF
      applicableTier: 'starter_6',
      maxUses: 5,
    });

    assert.equal(voucher.code, code);
    assert.equal(voucher.discountType, 'FIXED');
    assert.equal(voucher.discountValue, 50);

    const validation = await validateVoucherForUserInDb({
      code,
      firebaseUid: 'test-user-uid-2',
      tier: 'starter_6',
      originalFee: 150,
    });

    assert.equal(validation.valid, true);
    assert.equal(validation.discountAmount, 50);
    assert.equal(validation.finalFee, 100);
  });

  await t.test('rejects tier mismatch', async () => {
    const code = `PROONLY_${Date.now()}`;
    await createVoucherInDb({
      code,
      discountType: 'FIXED',
      discountValue: 100,
      applicableTier: 'pro_12',
    });

    await assert.rejects(
      async () => {
        await validateVoucherForUserInDb({
          code,
          firebaseUid: 'test-user-uid-3',
          tier: 'starter_6', // Mismatch!
          originalFee: 150,
        });
      },
      (err: any) => err.code === 'VOUCHER_TIER_MISMATCH'
    );
  });

  await t.test('handles voucher status toggle and deletion', async () => {
    const code = `TOGGLETEST_${Date.now()}`;
    const created = await createVoucherInDb({
      code,
      discountType: 'PERCENTAGE',
      discountValue: 50,
    });

    const toggled = await toggleVoucherStatusInDb(created.id, false);
    assert.equal(toggled.isActive, false);

    await assert.rejects(
      async () => {
        await validateVoucherForUserInDb({
          code,
          firebaseUid: 'test-user-uid-4',
          tier: 'starter_6',
          originalFee: 150,
        });
      },
      (err: any) => err.code === 'VOUCHER_INACTIVE'
    );

    await deleteVoucherInDb(created.id);
    const vouchers = await getVouchersFromDb();
    assert.equal(vouchers.some((v) => v.id === created.id), false);
  });
});
