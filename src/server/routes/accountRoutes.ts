import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../shared/apiError';
import {
  requireFirebaseIdentity,
  requireDatabase,
  requireAdmin,
} from '../shared/authUtils';
import {
  dbQuery,
  getUserByFirebaseUid,
  getUserByMemberId,
  ensureUser,
  createWalletIfMissing,
  getWalletSnapshot,
  createAuditEvent,
} from '../database';
import { ensureNativeDepositAddress } from '../nativeBscWallet';
import { getExchangeDescriptor } from '../../config/exchangeRegistry';

const router = Router();

router.post('/api/account/reserve-member-id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const { identity } = await requireFirebaseIdentity(req);
    const existing = await getUserByFirebaseUid(identity.uid);
    if (existing?.member_id) return res.json({ success: true, memberId: existing.member_id });
    const result = await dbQuery<{ value: number }>(`SELECT nextval('gain_member_id_seq') AS value`);
    const value = Number(result.rows[0]?.value || 0);
    if (value > 99999) return next(new ApiError(503, 'MEMBER_ID_CAPACITY_REACHED', 'configuration', 'Member ID capacity has been reached.', 'Kapasitas Member ID telah tercapai.'));
    const memberId = `GN-${String(value).padStart(5, '0')}`;
    await ensureUser({ firebaseUid: identity.uid, email: identity.email, memberId });
    await createWalletIfMissing(identity.uid, 'USDT');
    await ensureNativeDepositAddress(identity.uid);
    res.json({ success: true, memberId });
  } catch (error) { next(error); }
});

router.post('/api/account/bootstrap', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const { identity } = await requireFirebaseIdentity(req);
    const memberId = typeof req.body?.memberId === 'string' ? req.body.memberId.trim().toUpperCase() : undefined;
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().slice(0, 100) : undefined;
    const requestedSponsorId = typeof req.body?.sponsorId === 'string' ? req.body.sponsorId.trim().toUpperCase() : '';
    const masterOwnerEmail = String(process.env.GAIN_MASTER_OWNER_EMAIL || '').trim().toLowerCase();

    let sponsorMemberId: string | undefined;

    if (requestedSponsorId) {
      if (!/^GN-\d{5}$/.test(requestedSponsorId)) {
        return next(new ApiError(
          400,
          'SPONSOR_ID_INVALID',
          'validation',
          'Sponsor member ID is invalid.',
          'Member ID sponsor tidak valid.'
        ));
      }

      const sponsor = await getUserByMemberId(requestedSponsorId);

      if (!sponsor || sponsor.firebase_uid === identity.uid) {
        return next(new ApiError(
          400,
          'SPONSOR_NOT_FOUND',
          'validation',
          'Sponsor account was not found or cannot sponsor itself.',
          'Sponsor tidak ditemukan atau tidak dapat menjadi sponsor dirinya sendiri.'
        ));
      }

      sponsorMemberId = requestedSponsorId;
    } else if (masterOwnerEmail && identity.email.toLowerCase() !== masterOwnerEmail) {
      const masterOwner = await dbQuery<{ member_id: string; firebase_uid: string }>(
        `SELECT member_id, firebase_uid
           FROM users
          WHERE lower(email) = $1
            AND member_id IS NOT NULL
          LIMIT 1`,
        [masterOwnerEmail],
      );

      if (masterOwner.rows[0]?.member_id && masterOwner.rows[0].firebase_uid !== identity.uid) {
        sponsorMemberId = masterOwner.rows[0].member_id;
      }
    }
    const user = await ensureUser({ firebaseUid: identity.uid, email: identity.email, memberId, username, sponsorMemberId });
    await createWalletIfMissing(identity.uid, 'USDT');
    await ensureNativeDepositAddress(identity.uid);
        await createAuditEvent({ firebaseUid: identity.uid, eventType: 'account.bootstrap', payload: { memberId: user.member_id } });
    res.json({ success: true, userId: user.id, memberId: user.member_id });
  } catch (error) { next(error); }
});

router.get('/api/account/state', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const { identity } = await requireFirebaseIdentity(req);
    const snapshot = await getWalletSnapshot(identity.uid);
    if (!snapshot) {
      return next(new ApiError(
        404,
        'ACCOUNT_NOT_PROVISIONED',
        'not_found',
        'Financial account is not provisioned.',
        'Akun finansial belum tersedia. Silakan login ulang.'
      ));
    }

    const connectedExchangeResult = await dbQuery<{
      exchange: string;
      sandbox: boolean;
      status: string;
      updated_at: string;
      exchange_account_id?: string;
      identity_type?: 'exchange_reported' | 'credential_fingerprint' | null;
      identity_hint?: string | null;
      reported_identity_key?: string | null;
      credential_version?: number | null;
      active_exchange?: string | null;
    }>(
      `SELECT
         ec.exchange,
         ec.sandbox,
         ec.status,
         ec.updated_at,
         ea.id AS exchange_account_id,
         ea.identity_type,
         ea.identity_hint,
         ea.reported_identity_key,
         ea.credential_version,
         u.active_exchange
       FROM exchange_credentials ec
       JOIN users u ON u.id = ec.user_id
       LEFT JOIN exchange_accounts ea ON ea.user_id = ec.user_id AND lower(ea.exchange) = lower(ec.exchange)
       WHERE u.firebase_uid = $1
         AND ec.status = 'ACTIVE'
       ORDER BY ec.updated_at DESC`,
      [identity.uid],
    );

    const connectedExchanges = connectedExchangeResult.rows.map((row) => ({
      exchange: row.exchange,
      isConnected: true,
      isSandbox: Boolean(row.sandbox),
      dataSource: 'EXCHANGE_API',
      apiKeyMasked: 'API_CONNECTED',
      usdtBalance: 0,
      lastSynced: row.updated_at
        ? new Date(row.updated_at).toLocaleTimeString()
        : new Date().toLocaleTimeString(),
      exchangeAccountId: row.exchange_account_id || undefined,
      identityType: row.identity_type || undefined,
      identityHint: row.identity_hint || undefined,
      reportedIdentityKey: row.reported_identity_key || undefined,
      credentialVersion: Number(row.credential_version || 1),
      credentialStatus: row.status,
      exchangeAccountStatus: row.exchange_account_id ? 'ACTIVE' : 'UNKNOWN',
      portfolioSyncStatus: 'SYNCING',
      portfolioAsOf: undefined,
      lastSyncError: undefined,
      isActive: false,
    }));

    const persistedActiveExchange = String(connectedExchangeResult.rows[0]?.active_exchange || '').trim();
    const activeExchange =
      connectedExchanges.find(
        (item) =>
          String(item.exchange).toLowerCase() ===
          persistedActiveExchange.toLowerCase()
      )
      || (connectedExchanges.length === 1 ? connectedExchanges[0] : null);
    for (const item of connectedExchanges) {
      item.isActive = Boolean(activeExchange && String(item.exchange).toLowerCase() === String(activeExchange.exchange).toLowerCase());
    }

    const memberStatus = String(snapshot.member_status || snapshot.status || 'active').toLowerCase();
    const normalizedLicenseStatus = String(snapshot.license_status || 'NONE').toUpperCase() === 'ACTIVE' ? 'active' : 'none';

    res.json({
      success: true,
      wallet: {
        ...snapshot,
        member_status: memberStatus,
        license_status: normalizedLicenseStatus,
        account_status: normalizedLicenseStatus === 'active' ? 'active' : 'non-active',
        deposit_address: snapshot.deposit_address || '',
        connectedExchange: activeExchange,
        connectedExchanges,
        activeExchange: activeExchange?.exchange || null,
      },
    });
  } catch (error) { next(error); }
});

router.post('/api/account/active-exchange', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const { identity } = await requireFirebaseIdentity(req);
    const rawExchange = String(req.body?.exchange || '').trim();
    if (!rawExchange) return next(new ApiError(400, 'ACTIVE_EXCHANGE_INVALID', 'validation', 'Exchange is required.', 'Exchange wajib dipilih.'));
    const descriptor = getExchangeDescriptor(rawExchange);
    const exchangeId = descriptor ? descriptor.id : rawExchange.toLowerCase();
    const exchangeName = descriptor ? descriptor.name : rawExchange;
    const owned = await dbQuery<{ exchange: string }>(
      `SELECT exchange FROM exchange_credentials ec JOIN users u ON u.id = ec.user_id WHERE u.firebase_uid = $1 AND ec.status = 'ACTIVE' AND (lower(ec.exchange) = lower($2) OR lower(ec.exchange) = lower($3)) LIMIT 1`,
      [identity.uid, exchangeId, exchangeName]
    );
    if (!owned.rowCount) return next(new ApiError(404, 'ACTIVE_EXCHANGE_NOT_CONNECTED', 'not_found', 'The selected exchange is not connected to this account.', 'Exchange yang dipilih belum terhubung ke akun ini.'));
    const canonicalName = descriptor ? descriptor.name : exchangeName;
    await dbQuery(`UPDATE users SET active_exchange=$2, updated_at=now() WHERE firebase_uid=$1`, [identity.uid, canonicalName]);
    res.json({ success: true, activeExchange: canonicalName });
  } catch (error) { next(error); }
});

router.post('/api/account/profile', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const { identity } = await requireFirebaseIdentity(req);
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().slice(0, 100) : undefined;
    if (!username) return next(new ApiError(400, 'PROFILE_INVALID', 'validation', 'No safe profile fields were supplied.', 'Tidak ada perubahan profil yang valid.'));
    await dbQuery(`UPDATE users SET username=$2, updated_at=now() WHERE firebase_uid=$1`, [identity.uid, username]);
    res.json({ success: true, username });
  } catch (error) { next(error); }
});

router.get('/api/referrals/direct', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const { identity } = await requireFirebaseIdentity(req);
    const result = await dbQuery<any>(`SELECT u.member_id,u.firebase_uid,u.username,u.status,u.created_at,
      EXISTS (SELECT 1 FROM licenses l WHERE l.user_id=u.id AND l.status='ACTIVE' AND (l.expires_at IS NULL OR l.expires_at > now())) AS has_active_license,
      COALESCE(SUM(CASE WHEN re.sponsor_user_id=s.id AND re.source_user_id=u.id THEN re.reward_amount ELSE 0 END),0) AS bonus_yield_usdt
      FROM users s JOIN users u ON u.sponsor_user_id=s.id
      LEFT JOIN referral_events re ON re.sponsor_user_id=s.id AND re.source_user_id=u.id
      WHERE s.firebase_uid=$1 GROUP BY u.id ORDER BY u.created_at DESC LIMIT 100`, [identity.uid]);
    res.json({ success: true, members: result.rows.map((r: any) => ({ memberId: r.member_id, userId: r.firebase_uid, username: r.username || 'Member', accountStatus: r.has_active_license ? 'active' : 'non-active', memberStatus: r.status === 'active' ? 'active' : 'suspended', licenseStatus: r.has_active_license ? 'active' : 'none', joinedAt: r.created_at, bonusYieldUsdt: Number(r.bonus_yield_usdt || 0) })) });
  } catch (error) { next(error); }
});

function maskEmail(email?: string | null): string {
  if (!email) return '***@***.com';
  const parts = email.split('@');
  if (parts.length !== 2) return '***@***.com';
  const name = parts[0];
  const domain = parts[1];
  const visible = name.length > 2 ? name.slice(0, 2) : name.slice(0, 1);
  return `${visible}***@${domain}`;
}

router.get('/api/account/directory', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    await requireAdmin(req);
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

    const members = result.rows.map((row: any) => ({
      memberId: row.member_id,
      userId: row.firebase_uid,
      username: row.username || 'Member',
      accountStatus: row.has_active_license ? 'active' : 'non-active',
      memberStatus: row.member_status === 'active' ? 'active' : 'suspended',
      licenseStatus: row.has_active_license ? 'active' : 'none',
      vipTier: row.vip_tier || undefined,
      emailMasked: maskEmail(row.email),
      sponsorId: row.sponsor_id || undefined,
      sponsorName: row.sponsor_name || undefined,
      joinedAt: row.created_at ? new Date(row.created_at).toISOString().split('T')[0] : '-',
      role: row.role || 'user',
    }));

    res.json({ success: true, members });
  } catch (error) { next(error); }
});

router.get('/api/account/lookup-member/:memberId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const cleanId = String(req.params.memberId || '').trim().toUpperCase();
    if (!cleanId) return res.json({ success: false, member: null });

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
    `, [cleanId]);

    if (!result.rowCount) return res.json({ success: true, member: null });

    const row = result.rows[0];
    const member = {
      memberId: row.member_id,
      userId: row.firebase_uid,
      username: row.username || 'Member',
      accountStatus: row.has_active_license ? 'active' : 'non-active',
      memberStatus: row.member_status === 'active' ? 'active' : 'suspended',
      licenseStatus: row.has_active_license ? 'active' : 'none',
      emailMasked: maskEmail(row.email),
      sponsorId: row.sponsor_id || undefined,
      sponsorName: row.sponsor_name || undefined,
      joinedAt: row.created_at ? new Date(row.created_at).toISOString().split('T')[0] : '-',
      role: row.role || 'user',
    };

    res.json({ success: true, member });
  } catch (error) { next(error); }
});

router.post('/api/account/promote-user', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const { identity } = await requireFirebaseIdentity(req);
    const { targetEmail, targetUserId, newRole } = req.body;

    const currentUser = await getUserByFirebaseUid(identity.uid);
    const masterOwnerEmail = String(process.env.GAIN_MASTER_OWNER_EMAIL || '').trim().toLowerCase();
    const adminEmails = String(process.env.ADMIN_EMAILS || '').toLowerCase();
    const isMaster = (masterOwnerEmail && identity.email.toLowerCase() === masterOwnerEmail)
      || (adminEmails && adminEmails.includes(identity.email.toLowerCase()));

    if (!currentUser || (currentUser.role !== 'superadmin' && !isMaster)) {
      throw new ApiError(403, 'FORBIDDEN', 'security', 'Only superadmin can promote users.');
    }

    if (newRole !== 'admin' && newRole !== 'user') {
      throw new ApiError(400, 'INVALID_ROLE', 'validation', 'Role must be admin or user.');
    }

    if (!targetEmail && !targetUserId) {
      throw new ApiError(400, 'INVALID_INPUT', 'validation', 'Must provide targetEmail or targetUserId.');
    }

    if (newRole === 'user' && targetEmail && masterOwnerEmail && targetEmail.trim().toLowerCase() === masterOwnerEmail) {
      throw new ApiError(400, 'CANNOT_DEMOTE_SUPERADMIN', 'validation', 'Super admin cannot be demoted.');
    }

    let result;
    if (targetUserId) {
      result = await dbQuery(`UPDATE users SET role = $1, updated_at = now() WHERE firebase_uid = $2 RETURNING id, member_id, email`, [newRole, targetUserId]);
    } else {
      result = await dbQuery(`UPDATE users SET role = $1, updated_at = now() WHERE lower(email) = lower($2) RETURNING id, member_id, email`, [newRole, targetEmail]);
    }

    if (result.rowCount === 0) {
      throw new ApiError(404, 'NOT_FOUND', 'not_found', 'User not found.');
    }

    await createAuditEvent({
      firebaseUid: identity.uid,
      eventType: newRole === 'admin' ? 'admin.user.promoted' : 'admin.user.demoted',
      payload: { targetUserId, targetEmail, newRole }
    }).catch(() => {});

    res.json({ success: true, message: `User role updated to ${newRole}` });
  } catch (error) {
    next(error);
  }
});

export default router;
