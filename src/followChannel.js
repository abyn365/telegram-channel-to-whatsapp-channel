require('dotenv').config();
const logger = require('./logger');
const { createWhatsAppClient, normalizeWhatsAppId, resolveChannelTargetId, resolveChannelTargetIdFromPage, extractInviteCode } = require('./whatsappClient');

async function followChannel(client, targetId) {
    const normalizedId = normalizeWhatsAppId(targetId);
    
    if (!normalizedId.includes('@newsletter')) {
        throw new Error('This command is only for WhatsApp channels (newsletters). Use a channel URL or ID like: 0029Vb7T8V460eBW2gKeNC1x');
    }
    
    const inviteCode = extractInviteCode(targetId) || normalizedId.replace('@newsletter', '');
    let channelId = await resolveChannelTargetId(client, targetId);
    channelId = await resolveChannelTargetIdFromPage(client, channelId);
    
    logger.info(`Attempting to follow WhatsApp channel: ${inviteCode}`);
    
    // First, try to get channel info
    try {
        const channel = await client.getChannelByInviteCode(inviteCode);
        if (channel) {
            logger.info(`Found channel: ${channel.name || 'Unknown'}`);
            if (channel.id?._serialized) {
                logger.info(`Resolved channel ID: ${channel.id._serialized}`);
            }
        }
    } catch (err) {
        logger.warn(`Could not get channel info: ${err.message}`);
    }
    
    // Try to subscribe/follow
    try {
        const success = await client.subscribeToChannel(channelId);
        
        if (success) {
            return { success: true, message: 'Successfully followed the channel!' };
        } else {
            return { success: false, message: 'Failed to follow the channel. You may need to follow it manually in WhatsApp.' };
        }
    } catch (err) {
        const errorMessage = err.message || '';
        
        if (errorMessage.includes('already') || errorMessage.includes('subscribed') || errorMessage.includes('owner')) {
            return { success: true, message: 'Already following this channel (or you are the owner)!' };
        }
        
        logger.debug(`subscribeToChannel error: ${errorMessage}`);
        
        return { success: false, error: errorMessage, resolvedChannelId: channelId };
    }
}

async function main() {
    const targetId = process.argv[2] || process.env.WHATSAPP_TARGET_ID;
    
    if (!targetId) {
        console.log('Usage: npm run follow-channel <channel-url-or-id>');
        console.log('   or: Set WHATSAPP_TARGET_ID in .env and run npm run follow-channel');
        console.log('');
        console.log('Examples:');
        console.log('  npm run follow-channel https://whatsapp.com/channel/0029Vb7T8V460eBW2gKeNC1x');
        console.log('  npm run follow-channel 0029Vb7T8V460eBW2gKeNC1x');
        process.exit(1);
    }
    
    logger.info('Connecting to WhatsApp...');
    const client = await createWhatsAppClient();

    if (client.__provider === 'waha') {
        logger.error('follow-channel is not supported with WHATSAPP_PROVIDER=waha.');
        logger.info('Please follow the channel from your phone, then run `npm run list-chats` to copy the channel @newsletter ID from WAHA.');
        await client.destroy();
        process.exit(1);
    }
    
    try {
        const result = await followChannel(client, targetId);
        
        if (result.success) {
            logger.info(result.message || 'Success!');
            logger.info('');
            logger.info('The channel should now be available for posting.');
            logger.info('Try running the forwarder again.');
        } else {
            logger.error(result.message || result.error || 'Failed to follow channel');
            if (result.resolvedChannelId) {
                logger.info(`Resolved channel target used: ${result.resolvedChannelId}`);
            }
            logger.info('');
            logger.info('=== Manual Follow Instructions ===');
            logger.info('If the automatic follow failed, you can manually follow:');
            logger.info('');
            logger.info('1. Open WhatsApp on your phone');
            logger.info('2. Go to the Updates tab');
            logger.info('3. Tap "Find channels" or search for your channel');
            logger.info('4. Find your channel and tap "Follow"');
            logger.info('5. Once followed, restart the forwarder');
            logger.info('');
            logger.info('IMPORTANT: Even as a channel admin/owner, you must "Follow"');
            logger.info('your own channel for the WhatsApp Web session to see it.');
        }
    } catch (err) {
        logger.error('Error:', err.message);
    }
    
    await client.destroy();
    process.exit(0);
}

main().catch((err) => {
    logger.error('Fatal error:', err);
    process.exit(1);
});
