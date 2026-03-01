import 'dotenv/config';
import logger from './logger.js';
import {
    createWhatsAppClientWithReconnect,
    normalizeWhatsAppId,
    extractInviteCode,
} from './whatsappClient.js';

async function followChannel(sock, targetId) {
    const normalizedId = normalizeWhatsAppId(targetId);

    if (!/@newsletter$/i.test(normalizedId)) {
        throw new Error('This command is only for WhatsApp channels (newsletters). Use a channel URL or invite code like: 0029Vb7T8V460eBW2gKeNC1x');
    }

    const inviteCode = extractInviteCode(targetId);
    if (!inviteCode) {
        throw new Error(`Could not extract invite code from: ${targetId}`);
    }

    logger.info(`Looking up WhatsApp channel: ${inviteCode}`);

    let metadata;
    try {
        metadata = await sock.newsletterMetadata('invite', inviteCode);
        if (metadata) {
            logger.info(`Found channel: "${metadata.name || 'Unknown'}" (${metadata.id})`);
            logger.info(`Subscribers: ${metadata.subscriberCount || 'unknown'}`);
        }
    } catch (err) {
        logger.warn(`Could not fetch channel metadata: ${err.message}`);
    }

    const jid = metadata?.id
        ? (metadata.id.includes('@newsletter') ? metadata.id : `${metadata.id}@newsletter`)
        : normalizedId;

    logger.info(`Attempting to follow channel JID: ${jid}`);

    try {
        await sock.newsletterFollow(jid);
        logger.info('Successfully followed the channel!');
        return { success: true, jid, name: metadata?.name };
    } catch (err) {
        const msg = err.message || '';
        if (msg.includes('already') || msg.includes('subscribed')) {
            logger.info('Already following this channel.');
            return { success: true, jid, name: metadata?.name, alreadyFollowed: true };
        }
        logger.error(`Failed to follow channel: ${msg}`);
        return { success: false, error: msg, jid };
    }
}

async function main() {
    const targetId = process.argv[2] || process.env.WHATSAPP_TARGET_ID;

    if (!targetId) {
        console.log('Usage: npm run follow-channel <channel-url-or-invite-code>');
        console.log('');
        console.log('Examples:');
        console.log('  npm run follow-channel https://whatsapp.com/channel/0029Vb7T8V460eBW2gKeNC1x');
        console.log('  npm run follow-channel 0029Vb7T8V460eBW2gKeNC1x');
        process.exit(1);
    }

    logger.info('Connecting to WhatsApp...');
    const sock = await createWhatsAppClientWithReconnect();

    try {
        const result = await followChannel(sock, targetId);

        if (result.success) {
            logger.info(result.alreadyFollowed ? 'Already following this channel.' : 'Channel followed successfully!');
            if (result.jid) {
                logger.info('');
                logger.info('=== Add this to your .env ===');
                logger.info(`WHATSAPP_TARGET_ID=${result.jid}`);
                logger.info('');
            }
        } else {
            logger.error(`Could not follow channel: ${result.error}`);
            logger.info('');
            logger.info('You can still set WHATSAPP_TARGET_ID manually using the channel JID.');
            logger.info(`The resolved JID was: ${result.jid}`);
        }
    } catch (err) {
        logger.error('Error:', err.message);
    }

    sock.end(undefined);
    process.exit(0);
}

main().catch((err) => {
    logger.error('Fatal error:', err);
    process.exit(1);
});
