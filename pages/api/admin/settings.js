import { getSettings, requireAdmin, updateSettings } from '../../../src/dashboardData.js';

export default async function handler(req, res) {
  const claims = requireAdmin(req);
  if (!claims) return res.status(401).json({ error: 'Unauthorized' });

  if (req.method === 'GET') {
    return res.status(200).json(await getSettings());
  }

  if (req.method === 'PUT') {
    const updated = await updateSettings(req.body || {});
    return res.status(200).json(updated);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
