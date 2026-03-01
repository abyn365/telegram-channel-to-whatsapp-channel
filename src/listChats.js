require('dotenv').config();
const logger = require('./logger');
const {
    createWhatsAppClientWithReconnect,
    normalizeWhatsAppId,
    extractInviteCode,
    resolveNewsletterJid,
} = require('./whatsappClient');

async function main() {
    logger.info('Connecting to WhatsApp to list available chats...');
    const sock = await createWhatsAppClientWithReconnect();

    const manualTarget = process.argv[2] || process.env.WHATSAPP_TARGET_ID;

    console.log('\n=== WhatsApp Channel / Group Info ===\n');

    if (manualTarget) {
        const normalizedId = normalizeWhatsAppId(manualTarget);
        const inviteCode = extractInviteCode(manualTarget);

        if (/@newsletter$/i.test(normalizedId) && inviteCode) {
            console.log(`Querying newsletter: ${inviteCode}`);
            try {
                const metadata = await sock.newsletterMetadata('invite', inviteCode);
                if (metadata) {
                    console.log('\n[CHANNEL FOUND]');
                    console.log(`  Name:        ${metadata.name || 'Unknown'}`);
                    console.log(`  JID:         ${metadata.id}`);
                    console.log(`  Subscribers: ${metadata.subscriberCount || 'unknown'}`);
                    console.log(`  Description: ${metadata.description || 'none'}`);
                    console.log(`  URL:         https://whatsapp.com/channel/${inviteCode}`);
                    console.log('');
                    console.log('Set in .env:');
                    console.log(`  WHATSAPP_TARGET_ID=${metadata.id}`);
                }
            } catch (err) {
                console.log(`\n[ERROR] Could not find newsletter: ${err.message}`);
                console.log('Make sure the channel URL/ID is correct.');
            }
        } else {
            console.log(`Target "${manualTarget}" appears to be a group or direct chat (${normalizedId}).`);
            console.log('Group JIDs look like: 120363xxxxxxxxxx@g.us');
        }
        console.log('');
    }

    console.log('--- Groups (fetching active groups...) ---');
    try {
        const groups = await sock.groupFetchAllParticipating();
        const groupEntries = Object.entries(groups);

        if (groupEntries.length === 0) {
            console.log('No groups found.');
        } else {
            for (const [jid, meta] of groupEntries) {
                console.log(`[GROUP] ${meta.subject || 'Unknown'}`);
                console.log(`  ID: ${jid}\n`);
            }
        }
    } catch (err) {
        console.log(`Could not fetch groups: ${err.message}`);
    }

    console.log('');
    console.log('=== Usage Tips ===');
    console.log('For WhatsApp Channels (newsletters):');
    console.log('  Run: npm run list-chats https://whatsapp.com/channel/0029Vb7T8V460eBW2gKeNC1x');
    console.log('  This will show the channel JID to use in WHATSAPP_TARGET_ID');
    console.log('');
    console.log('For Groups:');
    console.log('  Copy the group ID from above (format: 120363xxxxxxxxxx@g.us)');
    console.log('');
    console.log('Note: With Baileys (WebSocket API), no Chrome/Puppeteer is needed!');
    console.log('');

    sock.end(undefined);
    process.exit(0);
}

main().catch((err) => {
    logger.error('Error:', err);
    process.exit(1);
});
