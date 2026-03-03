import { kvGetForwards, kvPushForward, kvAddChannel } from './redisStore.js';

export async function storeForwardPreview(preview) {
  const normalized = {
    ...preview,
    createdAt: preview.createdAt || new Date().toISOString(),
  };

  const existing = await kvGetForwards(1);
  if (existing[0] && existing[0].messageKey === normalized.messageKey) {
    return;
  }

  await kvPushForward(normalized, 300);
  if (normalized.channel) {
    await kvAddChannel(normalized.channel);
  }
}
