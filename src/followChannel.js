require('dotenv').config();
const logger = require('./logger');
const { createWhatsAppClient, normalizeWhatsAppId } = require('./whatsappClient');

async function followChannel(client, targetId) {
    const normalizedId = normalizeWhatsAppId(targetId);
    
    if (!normalizedId.includes('@newsletter')) {
        throw new Error('This command is only for WhatsApp channels (newsletters). Use a channel URL or ID like: 0029Vb7T8V460eBW2gKeNC1x');
    }
    
    const channelId = normalizedId;
    const inviteCode = normalizedId.replace('@newsletter', '');
    
    logger.info(`Attempting to follow WhatsApp channel: ${inviteCode}`);
    
    try {
        const success = await client.subscribeToChannel(channelId);
        
        if (success) {
            return { success: true, message: 'Successfully followed the channel!' };
        } else {
            return { success: false, message: 'Failed to follow the channel. You may need to follow it manually in WhatsApp.' };
        }
    } catch (err) {
        const errorMessage = err.message || '';
        
        if (errorMessage.includes('already') || errorMessage.includes('subscribed')) {
            return { success: true, message: 'Already following this channel!' };
        }
        
        logger.debug(`subscribeToChannel error: ${errorMessage}`);
        
        return { success: false, error: errorMessage };
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
    
    try {
        const result = await followChannel(client, targetId);
        
        if (result.success) {
            logger.info(result.message || 'Success!');
        } else {
            logger.error(result.message || result.error || 'Failed to follow channel');
            logger.info('');
            logger.info('To manually follow a WhatsApp channel:');
            logger.info('1. Open WhatsApp on your phone');
            logger.info('2. Go to the Updates tab');
            logger.info('3. Find your channel and tap "Follow"');
            logger.info('4. Once followed, restart the forwarder');
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
