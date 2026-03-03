import { getSettings, setSettings } from '../../../lib/kv.js';
import { verifyJwt } from '../../../lib/auth.js';

function authorized(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  const claims = verifyJwt(header.slice(7));
  return Boolean(claims?.role === 'admin');
}

function cleanText(input, fallback = '') {
  const value = String(input ?? fallback).trim();
  return value.slice(0, 4000);
}

function normalizeTemplates(raw, fallback = []) {
  if (!Array.isArray(raw)) return fallback;
  return raw
    .map((entry) => ({ channel: cleanText(entry?.channel, ''), postId: cleanText(entry?.postId, '') }))
    .filter((entry) => entry.channel && entry.postId)
    .slice(0, 100);
}

function normalizeSettings(current, payload) {
  return {
    ...current,
    botName: cleanText(payload?.botName, current.botName || 'Forward Bot'),
    infoTitle: cleanText(payload?.infoTitle, current.infoTitle || 'Sources & Admin Info'),
    infoContent: cleanText(payload?.infoContent, current.infoContent || 'Live forwarded feed'),
    contact: cleanText(payload?.contact, current.contact || ''),
    theme: payload?.theme === 'light' ? 'light' : 'dark',
    templates: normalizeTemplates(payload?.templates, current.templates || []),
  };
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    if (req.method === 'GET') return res.status(200).json(await getSettings());
    if (req.method === 'PUT') {
      const current = await getSettings();
      const next = normalizeSettings(current, req.body || {});
      await setSettings(next);
      return res.status(200).json(next);
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
