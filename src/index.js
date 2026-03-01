require('dotenv').config();
const logger = require('./logger');
const {
    createTelegramClient,
    resolveChannelTargets,
    resolveChannelEntities,
    startListener,
} = require('./telegramClient');
const { createWhatsAppClient } = require('./whatsappClient');
const { forwardMessage } = require('./forwarder');

async function main() {
    logger.info('Starting Telegram → WhatsApp forwarder...');

    const rawChannels = process.env.TELEGRAM_CHANNELS;
    if (!rawChannels) throw new Error('TELEGRAM_CHANNELS is not set in .env');

    const targetId = process.env.WHATSAPP_TARGET_ID;
    if (!targetId) throw new Error('WHATSAPP_TARGET_ID is not set in .env');

    const channels = resolveChannelTargets(rawChannels);

    logger.info('Connecting to Telegram...');
    const telegramClient = await createTelegramClient();

    logger.info('Connecting to WhatsApp...');
    const whatsappClient = await createWhatsAppClient();

    const { channelEntities, channelTitles } = await resolveChannelEntities(telegramClient, channels);

    for (const ch of channels) {
        const title = channelTitles[ch] || channelTitles[ch.replace(/^@/, '')] || '';
        logger.info(`Watching channel: ${ch} → "${title || 'Unknown'}"`);
    }

    startListener(telegramClient, channelEntities, async (message) => {
        const chatKey = String(message.peerId?.channelId || message.peerId?.chatId || message.peerId?.userId || '');
        const titleByPeer = channelTitles[chatKey] || channelTitles[`-100${chatKey}`] || '';

        let title = titleByPeer;
        if (!title) {
            for (const val of Object.values(channelTitles)) {
                if (val) {
                    title = val;
                    break;
                }
            }
        }

        await forwardMessage(telegramClient, whatsappClient, message, targetId, title);
    });

    logger.info('Forwarder is running. Waiting for new messages...');

    process.on('SIGINT', async () => {
        logger.info('Shutting down gracefully...');
        await telegramClient.disconnect();
        await whatsappClient.destroy();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        logger.info('SIGTERM received. Shutting down...');
        await telegramClient.disconnect();
        await whatsappClient.destroy();
        process.exit(0);
    });
}

main().catch((err) => {
    logger.error('Fatal error in main:', err);
    process.exit(1);
});
