import { getSettings, setSettings } from '../../../lib/kv.js';
import { verifyJwt } from '../../../lib/auth.js';

function authorized(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  const claims = verifyJwt(header.slice(7));
  return Boolean(claims?.role === 'admin');
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    if (req.method === 'GET') return res.status(200).json(await getSettings());
    if (req.method === 'PUT') {
      const current = await getSettings();
      const next = { ...current, ...(req.body || {}), templates: Array.isArray(req.body?.templates) ? req.body.templates : current.templates };
      await setSettings(next);
      return res.status(200).json(next);
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
