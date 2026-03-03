import { getChannels } from '../../../src/dashboardData.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const channels = await getChannels();
  return res.status(200).json({ channels });
}
