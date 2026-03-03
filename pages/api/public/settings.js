import { getSettings } from '../../../src/dashboardData.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const settings = await getSettings();
  return res.status(200).json(settings);
}
