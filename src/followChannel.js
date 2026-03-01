require('dotenv').config();
const logger = require('./logger');
const { createWhatsAppClient, initializeStore, normalizeWhatsAppId } = require('./whatsappClient');

async function followChannel(client, targetId) {
    const normalizedId = normalizeWhatsAppId(targetId);
    
    if (!normalizedId.includes('@newsletter')) {
        throw new Error('This command is only for WhatsApp channels (newsletters). Use a channel URL or ID like: 0029Vb7T8V460eBW2gKeNC1x');
    }
    
    const inviteCode = normalizedId.replace('@newsletter', '');
    
    logger.info(`Attempting to follow WhatsApp channel: ${inviteCode}`);
    
    // Initialize Store first
    await initializeStore(client);
    
    // Try to follow the channel
    const result = await client.pupPage.evaluate(async (code) => {
        try {
            const store = window.Store;
            const newsletterId = `${code}@newsletter`;
            
            // Method 1: Try Newsletter.subscribe
            if (store.Newsletter && store.Newsletter.subscribe) {
                try {
                    await store.Newsletter.subscribe(newsletterId);
                    return { success: true, method: 'Newsletter.subscribe', message: 'Successfully followed the channel!' };
                } catch (e) {
                    if (e.message && e.message.includes('already')) {
                        return { success: true, method: 'Newsletter.subscribe', message: 'Already following this channel!' };
                    }
                    // Continue to other methods
                }
            }
            
            // Method 2: Try NewsletterManager
            if (store.NewsletterManager && store.NewsletterManager.subscribe) {
                try {
                    await store.NewsletterManager.subscribe(newsletterId);
                    return { success: true, method: 'NewsletterManager.subscribe', message: 'Successfully followed the channel!' };
                } catch (e) {
                    if (e.message && e.message.includes('already')) {
                        return { success: true, method: 'NewsletterManager.subscribe', message: 'Already following this channel!' };
                    }
                }
            }
            
            // Method 3: Try via Wap.newsletter
            if (store.Wap && store.Wap.newsletter && store.Wap.newsletter.subscribe) {
                try {
                    await store.Wap.newsletter.subscribe(newsletterId);
                    return { success: true, method: 'Wap.newsletter.subscribe', message: 'Successfully followed the channel!' };
                } catch (e) {
                    if (e.message && e.message.includes('already')) {
                        return { success: true, method: 'Wap.newsletter.subscribe', message: 'Already following this channel!' };
                    }
                }
            }
            
            // Method 4: Try to create newsletter subscription via addNewsletterParticipant
            if (store.GroupUtils && store.GroupUtils.addNewsletterParticipant) {
                try {
                    await store.GroupUtils.addNewsletterParticipant(newsletterId);
                    return { success: true, method: 'GroupUtils.addNewsletterParticipant', message: 'Successfully followed the channel!' };
                } catch (e) {
                    // Continue
                }
            }
            
            return { success: false, message: 'Could not find a method to follow the channel. You may need to follow it manually in WhatsApp.' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }, inviteCode);
    
    return result;
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
