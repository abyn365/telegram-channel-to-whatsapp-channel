require('dotenv').config();
const logger = require('./logger');
const { createTelegramClient, resolveChannelTargets, startListener } = require('./telegramClient');
const { createWhatsAppClient } = require('./whatsappClient');
const { forwardMessage, resolveChannelTitle } = require('./forwarder');

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

    const channelTitles = {};
    for (const ch of channels) {
        channelTitles[ch] = await resolveChannelTitle(telegramClient, ch);
        logger.info(`Watching channel: ${ch} → "${channelTitles[ch]}"`);
    }

    startListener(telegramClient, channels, async (message) => {
        const chatKey = String(message.peerId?.channelId || message.peerId?.chatId || '');
        const titleByPeer = channelTitles[chatKey] || '';

        let title = titleByPeer;
        if (!title) {
            for (const [key, val] of Object.entries(channelTitles)) {
                if (val) { title = val; break; }
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
