const baseUrl = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

function enc(value) {
  return encodeURIComponent(typeof value === 'string' ? value : JSON.stringify(value));
}

async function cmd(command, ...args) {
  if (!baseUrl || !token) throw new Error('Missing Upstash envs');
  const path = [command, ...args.map(enc)].join('/');
  const response = await fetch(`${baseUrl}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Upstash ${command} failed: ${response.status}`);
  }
  return (await response.json()).result;
}

export async function getSettings() {
  const raw = await cmd('get', 'dashboard:settings');
  const defaults = {
    botName: 'Forward Bot',
    infoTitle: 'Sources & Admin Info',
    infoContent: 'Live forwarded feed',
    contact: 'admin@example.com',
    theme: 'dark',
    templates: [{ channel: 'wfwitness', postId: '74427' }],
  };
  if (!raw) return defaults;
  try { return { ...defaults, ...JSON.parse(raw) }; } catch { return defaults; }
}

export async function setSettings(value) {
  await cmd('set', 'dashboard:settings', JSON.stringify(value));
  return value;
}

export async function getForwards(limit = 40, since = null, offset = 0) {
  const safeLimit = Math.min(Math.max(Number(limit) || 40, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const rows = await cmd('lrange', 'dashboard:forwards', safeOffset, safeOffset + safeLimit - 1) || [];
  const parsed = rows.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  return since ? parsed.filter((x) => x.createdAt > since) : parsed;
}

export async function getChannels() {
  return await cmd('smembers', 'dashboard:channels') || [];
}

export async function getAdmin() {
  const raw = await cmd('get', 'dashboard:admin');
  return raw ? JSON.parse(raw) : null;
}

export async function setAdmin(value) {
  await cmd('set', 'dashboard:admin', JSON.stringify(value));
}
