import { getForwards } from '../../../src/dashboardData.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const limit = Number(req.query.limit || 30);
  const since = req.query.since || null;
  const items = await getForwards(limit, since);
  return res.status(200).json({ items });
}
