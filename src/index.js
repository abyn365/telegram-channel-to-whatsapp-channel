require('dotenv').config();
const logger = require('./logger');
const {
    createTelegramClient,
    resolveChannelTargets,
    resolveChannelEntities,
    startListener,
} = require('./telegramClient');
const {
    createWhatsAppClientWithReconnect,
    checkNewsletterAccess,
} = require('./whatsappClient');
const { forwardMessage } = require('./forwarder');

async function main() {
    logger.info('Starting Telegram → WhatsApp forwarder (powered by Baileys — no Chrome needed)...');

    const rawChannels = process.env.TELEGRAM_CHANNELS;
    if (!rawChannels) throw new Error('TELEGRAM_CHANNELS is not set in .env');

    const targetId = process.env.WHATSAPP_TARGET_ID;
    if (!targetId) throw new Error('WHATSAPP_TARGET_ID is not set in .env');

    const channels = resolveChannelTargets(rawChannels);

    logger.info('Connecting to Telegram...');
    const telegramClient = await createTelegramClient();

    logger.info('Connecting to WhatsApp (WebSocket — no browser required)...');
    const whatsappSock = await createWhatsAppClientWithReconnect();

    await checkNewsletterAccess(whatsappSock, targetId);

    const { channelTitles } = await resolveChannelEntities(telegramClient, channels);

    for (const ch of channels) {
        const title = channelTitles[ch] || channelTitles[ch.replace(/^@/, '')] || '';
        logger.info(`Watching Telegram channel: ${ch} → "${title || 'Unknown'}"`);
    }

    startListener(telegramClient, channels, async (message) => {
        const chatKey = String(
            message.peerId?.channelId || message.peerId?.chatId || message.peerId?.userId || ''
        );
        const titleByPeer = channelTitles[chatKey] || channelTitles[`-100${chatKey}`] || '';

        let title = titleByPeer;
        if (!title) {
            for (const val of Object.values(channelTitles)) {
                if (val) { title = val; break; }
            }
        }

        await forwardMessage(telegramClient, whatsappSock, message, targetId, title);
    });

    logger.info('Forwarder is running. Waiting for new messages...');

    const shutdown = async (signal) => {
        logger.info(`${signal} received. Shutting down gracefully...`);
        try { await telegramClient.disconnect(); } catch {}
        try { whatsappSock.end(undefined); } catch {}
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
    logger.error('Fatal error in main:', err);
    process.exit(1);
});
