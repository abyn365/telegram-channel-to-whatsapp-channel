import { adminLogin } from '../../../src/dashboardData.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = await adminLogin(req.body?.username, req.body?.password);
  if (!token) return res.status(401).json({ error: 'Invalid credentials' });

  return res.status(200).json({ token });
}
