require('dotenv').config();
const logger = require('./logger');
const { createWhatsAppClient, listChats, normalizeWhatsAppId } = require('./whatsappClient');

function getChannelUrl(id) {
    if (id.includes('@newsletter')) {
        const channelId = id.replace('@newsletter', '');
        return `https://whatsapp.com/channel/${channelId}`;
    }
    return null;
}

async function main() {
    logger.info('Connecting to WhatsApp to list available chats...');
    const client = await createWhatsAppClient();
    
    let chats = [];
    try {
        chats = await listChats(client);
    } catch (err) {
        logger.error('Error listing chats:', err.message);
    }

    console.log('\n=== Available WhatsApp Chats ===\n');
    
    const channels = chats.filter(c => c.type === 'channel');
    const groups = chats.filter(c => c.type === 'group');
    const regularChats = chats.filter(c => c.type === 'chat');
    
    if (channels.length > 0) {
        console.log('--- WhatsApp Channels ---');
        channels.forEach((c) => {
            const url = getChannelUrl(c.id);
            console.log(`[CHANNEL] ${c.name}`);
            console.log(`  ID: ${c.id}`);
            if (url) console.log(`  URL: ${url}`);
            console.log('');
        });
    } else {
        console.log('--- WhatsApp Channels ---');
        console.log('No channels found.');
        console.log('');
    }
    
    if (groups.length > 0) {
        console.log('--- Groups ---');
        groups.forEach((c) => {
            console.log(`[GROUP] ${c.name}`);
            console.log(`  ID: ${c.id}\n`);
        });
    }
    
    if (regularChats.length > 0) {
        console.log('--- Chats ---');
        regularChats.forEach((c) => {
            console.log(`[CHAT] ${c.name}`);
            console.log(`  ID: ${c.id}\n`);
        });
    }

    console.log('\n=== Usage Tips ===');
    console.log('For WhatsApp Channels, you can use:');
    console.log('  - The full URL: https://whatsapp.com/channel/0029Vb7T8V460eBW2gKeNC1x');
    console.log('  - Or just the channel ID: 0029Vb7T8V460eBW2gKeNC1x');
    console.log('  - The code automatically adds @newsletter suffix');
    console.log('');
    
    // Check if WHATSAPP_TARGET_ID is set to a channel and provide specific guidance
    const targetId = process.env.WHATSAPP_TARGET_ID;
    if (targetId) {
        const normalizedId = normalizeWhatsAppId(targetId);
        if (normalizedId.includes('@newsletter')) {
            const inviteCode = normalizedId.replace('@newsletter', '');
            console.log('=== Your Configured Target Channel ===');
            console.log(`Channel ID: ${inviteCode}`);
            console.log(`URL: https://whatsapp.com/channel/${inviteCode}`);
            
            const foundChannel = channels.find(c => c.id === normalizedId);
            if (foundChannel) {
                console.log(`Status: ✓ Found in your channels`);
            } else {
                console.log(`Status: ✗ NOT found in your followed channels`);
                console.log('');
                console.log('IMPORTANT: You must FOLLOW this channel from your WhatsApp app!');
                console.log('');
                console.log('Steps to fix:');
                console.log('1. Open WhatsApp on your phone');
                console.log('2. Go to Updates tab → Channels');
                console.log('3. Find your channel and tap "Follow"');
                console.log('4. Or run: npm run follow-channel https://whatsapp.com/channel/' + inviteCode);
                console.log('');
                console.log('Even as a channel admin, you need to "Follow" your own channel');
                console.log('for the bot to be able to post to it.');
            }
            console.log('');
        }
    }
    
    if (channels.length === 0 && !targetId) {
        console.log('=== Troubleshooting Channels ===');
        console.log('If you have channels but they don\'t appear:');
        console.log('  1. Make sure you\'ve "Followed" the channel from your WhatsApp app');
        console.log('  2. Run: npm run follow-channel <channel-url> to subscribe via the bot');
        console.log('  3. Example: npm run follow-channel https://whatsapp.com/channel/0029Vb7T8V460eBW2gKeNC1x');
        console.log('');
        console.log('Note: As a channel admin, you may need to follow your own channel first.');
        console.log('');
    }

    await client.destroy();
    process.exit(0);
}

main().catch((err) => {
    logger.error('Error listing chats:', err);
    process.exit(1);
});
