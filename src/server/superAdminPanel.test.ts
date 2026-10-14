import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { signCustomJwt } from './shared/jwtUtils';
import { requireAdmin } from './shared/authUtils';
import { getUserByFirebaseUid, dbQuery } from './database';

test('Super Admin Access & Control Center End-to-End', async (t) => {
  const superAdminEmail = 'niagakoin.official@gmail.com';
  const superAdminGoogleSub = '111614120305919141434';

  await t.test('allows super admin via email matching GAIN_MASTER_OWNER_EMAIL even if role missing in JWT', async () => {
    // Legacy token before Phase 4 update (no role field)
    const tokenWithoutRole = signCustomJwt({
      uid: superAdminGoogleSub,
      email: superAdminEmail,
      name: 'Niaga Koin Official',
    });

    const mockReq = {
      header: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${tokenWithoutRole}` : '',
      headers: { cookie: '' },
    } as any;

    const uid = await requireAdmin(mockReq);
    assert.equal(uid, superAdminGoogleSub);
  });

  await t.test('allows super admin with explicit role in JWT', async () => {
    const tokenWithRole = signCustomJwt({
      uid: superAdminGoogleSub,
      email: superAdminEmail,
      name: 'Niaga Koin Official',
      role: 'superadmin',
    });

    const mockReq = {
      header: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${tokenWithRole}` : '',
      headers: { cookie: '' },
    } as any;

    const uid = await requireAdmin(mockReq);
    assert.equal(uid, superAdminGoogleSub);
  });

  await t.test('allows super admin via gain_auth_token cookie', async () => {
    const token = signCustomJwt({
      uid: superAdminGoogleSub,
      email: superAdminEmail,
      name: 'Niaga Koin Official',
    });

    const mockReq = {
      header: () => '',
      headers: { cookie: `gain_auth_token=${token}` },
    } as any;

    const uid = await requireAdmin(mockReq);
    assert.equal(uid, superAdminGoogleSub);
  });

  await t.test('rejects regular non-admin user with 403 ADMIN_REQUIRED', async () => {
    const regularUserToken = signCustomJwt({
      uid: 'random-regular-user-id',
      email: 'regular.member@example.com',
      name: 'Regular Member',
      role: 'user',
    });

    const mockReq = {
      header: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${regularUserToken}` : '',
      headers: { cookie: '' },
    } as any;

    await assert.rejects(
      async () => {
        await requireAdmin(mockReq);
      },
      (err: any) => {
        assert.equal(err.statusCode, 403);
        assert.equal(err.code, 'ADMIN_REQUIRED');
        return true;
      }
    );
  });

  await t.test('rejects request with missing token with 401 AUTH_REQUIRED', async () => {
    const mockReq = {
      header: () => '',
      headers: { cookie: '' },
    } as any;

    await assert.rejects(
      async () => {
        await requireAdmin(mockReq);
      },
      (err: any) => {
        assert.equal(err.statusCode, 401);
        assert.equal(err.code, 'AUTH_REQUIRED');
        return true;
      }
    );
  });

  await t.test('verifies member directory query returns valid members', async () => {
    const result = await dbQuery<any>(`
      SELECT 
        u.id,
        u.firebase_uid,
        u.member_id,
        u.username,
        u.email,
        u.status AS member_status,
        u.role,
        u.created_at,
        sponsor.member_id AS sponsor_id,
        sponsor.username AS sponsor_name,
        COALESCE(l.status, 'NONE') AS license_status,
        l.tier AS vip_tier,
        EXISTS (
          SELECT 1 FROM licenses lic 
          WHERE lic.user_id = u.id 
            AND lic.status = 'ACTIVE' 
            AND (lic.expires_at IS NULL OR lic.expires_at > now())
        ) AS has_active_license
      FROM users u
      LEFT JOIN users sponsor ON sponsor.id = u.sponsor_user_id
      LEFT JOIN LATERAL (
        SELECT tier, status 
        FROM licenses 
        WHERE licenses.user_id = u.id AND licenses.status = 'ACTIVE' 
        ORDER BY licenses.activated_at DESC 
        LIMIT 1
      ) l ON true
      WHERE u.member_id IS NOT NULL
      ORDER BY u.created_at DESC
    `);

    assert.ok(result.rows.length >= 1, 'Should find at least 1 member');
    const member = result.rows.find((r: any) => r.member_id === 'GN-00001' || r.member_id === 'GN-00002');
    assert.ok(member, 'Should find superadmin member');
    assert.equal(member.role, 'superadmin');
  });

  await t.test('verifies member lookup by member_id GN-00001', async () => {
    const result = await dbQuery<any>(`
      SELECT 
        u.id,
        u.firebase_uid,
        u.member_id,
        u.username,
        u.email,
        u.status AS member_status,
        u.role,
        u.created_at,
        sponsor.member_id AS sponsor_id,
        sponsor.username AS sponsor_name,
        EXISTS (
          SELECT 1 FROM licenses lic 
          WHERE lic.user_id = u.id 
            AND lic.status = 'ACTIVE' 
            AND (lic.expires_at IS NULL OR lic.expires_at > now())
        ) AS has_active_license
      FROM users u
      LEFT JOIN users sponsor ON sponsor.id = u.sponsor_user_id
      WHERE upper(u.member_id) = $1
      LIMIT 1
    `, ['GN-00001']);

    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0].member_id, 'GN-00001');
  });

  t.after(() => {
    setTimeout(() => process.exit(0), 100).unref();
  });
});
