require('dotenv').config();
const logger = require('./logger');
const { createWhatsAppClient, listChats } = require('./whatsappClient');

function getChannelUrl(id) {
    // If it's a channel ID (has @newsletter suffix), convert to URL format
    if (id.includes('@newsletter')) {
        const channelId = id.replace('@newsletter', '');
        return `https://whatsapp.com/channel/${channelId}`;
    }
    return null;
}

async function main() {
    logger.info('Connecting to WhatsApp to list available chats...');
    const client = await createWhatsAppClient();
    const chats = await listChats(client);

    console.log('\n=== Available WhatsApp Chats ===\n');
    
    // Separate channels, groups, and chats
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
    console.log('Note: If your channel doesn\'t appear above but you\'re an admin:');
    console.log('  1. Make sure you\'ve "Followed" the channel from your WhatsApp app');
    console.log('  2. Run: npm run follow-channel <channel-url> to subscribe via the bot');
    console.log('  3. Or manually follow via WhatsApp: Updates tab → Find channel → Follow');
    console.log('');

    await client.destroy();
    process.exit(0);
}

main().catch((err) => {
    logger.error('Error listing chats:', err);
    process.exit(1);
});
