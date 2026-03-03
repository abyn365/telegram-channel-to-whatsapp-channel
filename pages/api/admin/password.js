import { requireAdmin, rotatePassword } from '../../../src/dashboardData.js';

export default async function handler(req, res) {
  const claims = requireAdmin(req);
  if (!claims) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed' });

  const ok = await rotatePassword(req.body?.oldPassword, req.body?.newPassword);
  if (!ok) return res.status(400).json({ error: 'Invalid old password' });

  return res.status(200).json({ ok: true });
}
