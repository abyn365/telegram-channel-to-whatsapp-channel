import logger from './logger.js';

const baseUrl = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

const enabled = Boolean(baseUrl && token);
const memoryFallback = new Map();
const memoryLists = new Map();

function encodeArg(arg) {
  return encodeURIComponent(typeof arg === 'string' ? arg : JSON.stringify(arg));
}

async function runRedisCommand(command, ...args) {
  if (!enabled) {
    return null;
  }

  const path = [command, ...args.map(encodeArg)].join('/');
  const response = await fetch(`${baseUrl}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Upstash ${command} failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  return data.result;
}

export async function kvSet(key, value) {
  const asString = typeof value === 'string' ? value : JSON.stringify(value);

  if (!enabled) {
    memoryFallback.set(key, asString);
    return 'OK';
  }

  try {
    return await runRedisCommand('set', key, asString);
  } catch (error) {
    logger.warn(`kvSet fallback for ${key}: ${error.message}`);
    memoryFallback.set(key, asString);
    return 'OK';
  }
}

export async function kvGet(key) {
  if (!enabled) {
    return memoryFallback.get(key) ?? null;
  }

  try {
    const result = await runRedisCommand('get', key);
    return result ?? memoryFallback.get(key) ?? null;
  } catch (error) {
    logger.warn(`kvGet fallback for ${key}: ${error.message}`);
    return memoryFallback.get(key) ?? null;
  }
}

export async function kvPushForward(item, limit = 200) {
  const key = 'dashboard:forwards';
  const payload = JSON.stringify(item);

  if (!enabled) {
    const list = memoryLists.get(key) || [];
    list.unshift(payload);
    memoryLists.set(key, list.slice(0, limit));
    return;
  }

  try {
    await runRedisCommand('lpush', key, payload);
    await runRedisCommand('ltrim', key, 0, limit - 1);
  } catch (error) {
    logger.warn(`kvPushForward fallback: ${error.message}`);
    const list = memoryLists.get(key) || [];
    list.unshift(payload);
    memoryLists.set(key, list.slice(0, limit));
  }
}

export async function kvGetForwards(limit = 50) {
  const key = 'dashboard:forwards';

  let rows = [];
  if (!enabled) {
    rows = (memoryLists.get(key) || []).slice(0, limit);
  } else {
    try {
      rows = await runRedisCommand('lrange', key, 0, limit - 1) || [];
    } catch (error) {
      logger.warn(`kvGetForwards fallback: ${error.message}`);
      rows = (memoryLists.get(key) || []).slice(0, limit);
    }
  }

  return rows
    .map((raw) => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export async function kvAddChannel(channel) {
  const key = 'dashboard:channels';
  const value = String(channel || '').trim();
  if (!value) return;

  if (!enabled) {
    const set = new Set(memoryFallback.get(key) ? JSON.parse(memoryFallback.get(key)) : []);
    set.add(value);
    memoryFallback.set(key, JSON.stringify([...set]));
    return;
  }

  try {
    await runRedisCommand('sadd', key, value);
  } catch (error) {
    logger.warn(`kvAddChannel fallback: ${error.message}`);
  }
}

export async function kvGetChannels() {
  const key = 'dashboard:channels';

  if (!enabled) {
    return memoryFallback.get(key) ? JSON.parse(memoryFallback.get(key)) : [];
  }

  try {
    return await runRedisCommand('smembers', key) || [];
  } catch (error) {
    logger.warn(`kvGetChannels fallback: ${error.message}`);
    return memoryFallback.get(key) ? JSON.parse(memoryFallback.get(key)) : [];
  }
}

export { enabled as upstashEnabled };
