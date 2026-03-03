import { ensureAdminSeeded, signJwt, verifyPassword } from '../../../lib/auth.js';
import { getAdmin } from '../../../lib/kv.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    await ensureAdminSeeded();
    const admin = await getAdmin();
    if (!admin || req.body?.username !== admin.username || !verifyPassword(req.body?.password, admin.hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    return res.status(200).json({ token: signJwt({ sub: admin.username, role: 'admin' }) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
