import { getForwards } from '../../../lib/kv.js';

function mapCard(item) {
  return {
    id: item.messageKey || `${item.createdAt}-${item.messageId}`,
    channelTitle: item.channelTitle || item.channel || 'Unknown',
    createdAt: item.createdAt,
    mediaType: item.mediaType || 'text',
    previewType: item.previewType || item.mediaType || 'text',
    text: item.text || item.rawText || '',
    caption: item.caption || item.text || '',
    sourceLink: item.sourceLink || '',
    embed: item.channel && item.postId ? { channel: item.channel, postId: item.postId } : null,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const items = await getForwards(Number(req.query.limit || 40), req.query.since || null);
    return res.status(200).json({ cards: items.map(mapCard) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
