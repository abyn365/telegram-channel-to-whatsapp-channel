import { verifyJwt, verifyPassword, hashPassword } from '../../../lib/auth.js';
import { getAdmin, setAdmin } from '../../../lib/kv.js';

function authorized(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  const claims = verifyJwt(header.slice(7));
  return Boolean(claims?.role === 'admin');
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const admin = await getAdmin();
    if (!admin || !verifyPassword(req.body?.oldPassword, admin.hash)) {
      return res.status(400).json({ error: 'Invalid old password' });
    }
    admin.hash = hashPassword(req.body?.newPassword || '');
    await setAdmin(admin);
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
