require('dotenv').config();
const logger = require('./logger');
const {
    createTelegramClient,
    resolveChannelTargets,
    resolveChannelEntities,
    startListener,
} = require('./telegramClient');
const {
    createWhatsAppClient,
    normalizeWhatsAppId,
    getChannelCandidatesFromPageStore,
    resolveChannelTargetIdFromPage,
} = require('./whatsappClient');
const { forwardMessage } = require('./forwarder');

async function checkWhatsAppTarget(client, targetId) {
    const normalizedId = normalizeWhatsAppId(targetId);
    
    if (!normalizedId.includes('@newsletter')) {
        // For non-channel targets, just verify it exists
        try {
            const chat = await client.getChatById(normalizedId);
            if (chat) {
                logger.info(`WhatsApp target verified: ${chat.name || normalizedId}`);
                return true;
            }
        } catch (err) {
            logger.warn(`Could not verify WhatsApp target: ${err.message}`);
        }
        return false;
    }
    
    // For channels, check if it's in the followed channels
    const inviteCode = normalizedId.replace('@newsletter', '');
    
    try {
        const channels = await client.getChannels();
        const found = channels && channels.find(c => c.id._serialized === normalizedId);

        if (found) {
            logger.info(`WhatsApp channel verified: "${found.name}" (${inviteCode})`);
            return true;
        }

        try {
            const resolvedId = await resolveChannelTargetIdFromPage(client, normalizedId);
            const storeChannels = await getChannelCandidatesFromPageStore(client);
            const storeMatch = storeChannels.find((channel) => channel.id === resolvedId || channel.id === normalizedId);
            if (storeMatch) {
                logger.info(`WhatsApp channel loaded from WhatsApp Web store: "${storeMatch.name}" (${inviteCode})`);
                return true;
            }
        } catch (storeErr) {
            logger.debug(`Channel store lookup failed: ${storeErr.message}`);
        }

        // Channel not found in followed list
        logger.warn('');
        logger.warn('=== WHATSAPP CHANNEL NOT FOUND ===');
        logger.warn(`Channel ID: ${inviteCode}`);
        logger.warn(`URL: https://whatsapp.com/channel/${inviteCode}`);
        logger.warn('');
        logger.warn('The channel is NOT in your followed channels list.');
        logger.warn('Even as the channel admin/owner, you must "Follow" the channel');
        logger.warn('for the WhatsApp Web session to see and post to it.');
        logger.warn('');
        logger.warn('TO FIX:');
        logger.warn('  1. Run: npm run follow-channel https://whatsapp.com/channel/' + inviteCode);
        logger.warn('  2. Or open WhatsApp on your phone → Updates → Channels → Follow the channel');
        logger.warn('');

        // Try to subscribe automatically
        try {
            logger.info('Attempting to automatically follow the channel...');
            const success = await client.subscribeToChannel(normalizedId);
            if (success) {
                logger.info('Successfully followed the channel!');
                return true;
            }
        } catch (subErr) {
            logger.warn(`Auto-follow failed: ${subErr.message}`);
        }

        return false;
    } catch (err) {
        logger.warn(`Could not check channel status: ${err.message}`);
        return false;
    }
}

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

    // Check WhatsApp target availability
    await checkWhatsAppTarget(whatsappClient, targetId);

    const { channelEntities, channelTitles } = await resolveChannelEntities(telegramClient, channels);

    for (const ch of channels) {
        const title = channelTitles[ch] || channelTitles[ch.replace(/^@/, '')] || '';
        logger.info(`Watching channel: ${ch} → "${title || 'Unknown'}"`);
    }

    startListener(telegramClient, channels, async (message) => {
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
    }, channels);

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
