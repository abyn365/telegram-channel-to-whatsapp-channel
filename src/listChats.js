require('dotenv').config();
const logger = require('./logger');
const { createWhatsAppClient, listChats } = require('./whatsappClient');

async function main() {
    logger.info('Connecting to WhatsApp to list available chats...');
    const client = await createWhatsAppClient();
    const chats = await listChats(client);

    console.log('\n=== Available WhatsApp Chats ===\n');
    chats.forEach((c) => {
        console.log(`[${c.type.toUpperCase()}] ${c.name}`);
        console.log(`  ID: ${c.id}\n`);
    });

    await client.destroy();
    process.exit(0);
}

main().catch((err) => {
    logger.error('Error listing chats:', err);
    process.exit(1);
});
