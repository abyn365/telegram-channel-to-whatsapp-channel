import { getSettings } from '../../../lib/kv.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const settings = await getSettings();
    return res.status(200).json(settings);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
