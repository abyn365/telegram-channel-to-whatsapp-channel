const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const mime = require('mime-types');
const path = require('path');
const logger = require('./logger');
const { execSync } = require('child_process');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for the WhatsApp Web page to be stable (no ongoing navigation)
 */
async function waitForPageStable(client, maxWaitMs = 10000) {
    const startTime = Date.now();
    const checkInterval = 500;
    
    while (Date.now() - startTime < maxWaitMs) {
        try {
            const navigationState = await client.pupPage.evaluate(() => {
                return {
                    readyState: document.readyState,
                    url: window.location.href,
                };
            });
            
            if (navigationState.readyState === 'complete' && 
                !navigationState.url.includes('loading') &&
                navigationState.url.includes('web.whatsapp.com')) {
                await sleep(500);
                return true;
            }
        } catch (e) {
            // Ignore evaluation errors during stability check
        }
        await sleep(checkInterval);
    }
    return false;
}

const resolvedTargets = new Set();

function extractInviteCode(targetId) {
    if (!targetId) return null;

    const sanitized = String(targetId).trim().replace(/^['"]+|['"]+$/g, '');
    if (!sanitized) return null;

    const channelUrlMatch = sanitized.match(/(?:https?:\/\/)?(?:www\.)?whatsapp\.com\/channel\/([a-zA-Z0-9]+)/i);
    if (channelUrlMatch) {
        return channelUrlMatch[1];
    }

    if (/^[a-zA-Z0-9]{15,}$/.test(sanitized) && !sanitized.includes('@')) {
        return sanitized;
    }

    return null;
}

function findChromeExecutable() {
    const possiblePaths = [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium',
        '/usr/bin/chromium-browser-unstable',
    ];

    for (const chromePath of possiblePaths) {
        if (fs.existsSync(chromePath)) {
            logger.info(`Found Chrome executable at: ${chromePath}`);
            return chromePath;
        }
    }

    try {
        const chromePath = execSync('which google-chrome-stable || which google-chrome || which chromium-browser || which chromium', {
            encoding: 'utf-8',
        }).trim();
        if (chromePath) {
            logger.info(`Found Chrome executable via which: ${chromePath}`);
            return chromePath;
        }
    } catch (e) {
        // Ignore
    }

    logger.warn('Chrome/Chromium executable not found, relying on Puppeteer bundled Chrome');
    return undefined;
}

async function createWhatsAppClient() {
    const executablePath = findChromeExecutable();

    const sessionPath = path.join(__dirname, '../sessions/whatsapp');
    const sessionFile = path.join(sessionPath, 'session.json');
    if (await fs.pathExists(sessionFile)) {
        try {
            const stats = await fs.stat(sessionFile);
            const sessionAge = Date.now() - stats.mtimeMs;
            if (sessionAge > 30 * 24 * 60 * 60 * 1000) {
                logger.warn('WhatsApp session appears to be older than 30 days and may have expired. If connection fails, try deleting the sessions/whatsapp folder.');
            } else {
                logger.info('Found existing WhatsApp session, attempting to reconnect...');
            }
        } catch (e) {
            // Ignore - session file may be corrupted
        }
    }

    const client = new Client({
        authStrategy: new LocalAuth({
            dataPath: path.join(__dirname, '../sessions/whatsapp'),
        }),
        puppeteer: {
            headless: 'new',
            executablePath: executablePath,
            timeout: 120000,
            protocolTimeout: 180000,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-default-apps',
                '--disable-translate',
                '--disable-sync',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        },
    });

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('WhatsApp connection timed out after 5 minutes'));
        }, 300_000);

        let qrGenerated = false;
        let readyFired = false;

        client.on('loading_screen', (percent, message) => {
            logger.info(`WhatsApp loading: ${percent}% - ${message || 'connecting...'}`);
        });

        client.on('authenticated', () => {
            logger.info('WhatsApp session authenticated successfully');
        });

        client.on('auth_logged_out', (info) => {
            logger.warn('WhatsApp auth logged out:', info);
        });

        client.on('qr', (qr) => {
            qrGenerated = true;
            logger.info('WhatsApp QR code generated — scan with your phone:');
            qrcode.generate(qr, { small: true });
            logger.info('(If QR code is not scannable, try logging into WhatsApp Web manually at web.whatsapp.com)');
        });

        client.on('ready', async () => {
            if (readyFired) return;
            readyFired = true;
            clearTimeout(timeout);
            clearTimeout(timeoutWarning);
            logger.info('WhatsApp userbot ready.');
            await sleep(1000);
            resolve();
        });

        client.on('auth_failure', (msg) => {
            clearTimeout(timeout);
            clearTimeout(timeoutWarning);
            reject(new Error(`WhatsApp auth failure: ${msg}`));
        });

        client.on('disconnected', (reason) => {
            logger.warn(`WhatsApp disconnected: ${reason}`);
        });

        const timeoutWarning = setTimeout(() => {
            if (!readyFired) {
                if (qrGenerated) {
                    logger.warn('WhatsApp QR code was generated but not scanned within 2 minutes. Please scan now or restart to generate a new QR code.');
                } else {
                    logger.warn('WhatsApp is taking longer than 2 minutes to connect. This may indicate a session issue - the saved session may have expired.');
                }
            }
        }, 120_000);

        client.on('error', (error) => {
            clearTimeout(timeout);
            clearTimeout(timeoutWarning);
            logger.error('WhatsApp client error during initialization:', error);
            if (error.message.includes('TargetCloseError') || error.message.includes('Session closed')) {
                reject(new Error('Browser closed unexpectedly during initialization. This may be due to resource constraints or Chrome compatibility issues. Try again or check system resources.'));
            } else {
                reject(error);
            }
        });

        client.initialize().catch((err) => {
            clearTimeout(timeout);
            clearTimeout(timeoutWarning);
            reject(err);
        });
    });

    return client;
}

async function listChats(client, retries = 3) {
    await waitForPageStable(client);
    
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await sleep(2000);
            await waitForPageStable(client);
            
            const chats = await client.getChats();
            
            let allItems = chats.map((c) => ({
                id: c.id._serialized,
                name: c.name,
                type: c.isGroup ? 'group' : 'chat',
            }));
            
            // Get channels using the built-in getChannels method
            try {
                const channels = await client.getChannels();

                if (channels && channels.length > 0) {
                    for (const channel of channels) {
                        const channelId = channel.id._serialized;
                        if (!allItems.find(c => c.id === channelId)) {
                            allItems.push({
                                id: channelId,
                                name: channel.name || 'WhatsApp Channel',
                                type: 'channel',
                            });
                        }
                    }
                }
            } catch (err) {
                logger.debug(`Could not get channels: ${err.message}`);
            }

            // Fallback: inspect WhatsApp Web in-page store for newsletter IDs.
            const storeChannels = await getChannelCandidatesFromPageStore(client);
            if (storeChannels.length > 0) {
                for (const channel of storeChannels) {
                    if (!allItems.find((c) => c.id === channel.id)) {
                        allItems.push({
                            id: channel.id,
                            name: channel.name || 'WhatsApp Channel',
                            type: 'channel',
                        });
                    }
                }
            }

            return allItems;
        } catch (err) {
            const errorMessage = err.message || '';
            const isNavigationError = 
                errorMessage.includes('Execution context was destroyed') ||
                errorMessage.includes('navigation') ||
                errorMessage.includes('TargetCloseError') ||
                errorMessage.includes('Protocol error') ||
                errorMessage.includes('Session closed');
            
            if (isNavigationError && attempt < retries) {
                logger.warn(`listChats attempt ${attempt} failed (${errorMessage}), retrying...`);
                await sleep(3000);
                continue;
            }
            throw err;
        }
    }
}

/**
 * Normalize WhatsApp channel ID from various formats:
 * - https://whatsapp.com/channel/0029Vb7T8V460eBW2gKeNC1x -> 0029Vb7T8V460eBW2gKeNC1x@newsletter
 * - 0029Vb7T8V460eBW2gKeNC1x -> 0029Vb7T8V460eBW2gKeNC1x@newsletter
 * - 0029Vb7T8V460eBW2gKeNC1x@newsletter -> stays the same
 * - regular chat/group ID -> stays the same
 */
function normalizeWhatsAppId(targetId) {
    if (!targetId) return targetId;

    const sanitized = String(targetId).trim().replace(/^['"]+|['"]+$/g, '');
    if (!sanitized) return sanitized;

    if (/@newsletter$/i.test(sanitized)) {
        return sanitized.replace(/@newsletter$/i, '@newsletter');
    }

    if (sanitized.includes('@')) {
        return sanitized;
    }

    const channelUrlMatch = sanitized.match(/(?:https?:\/\/)?(?:www\.)?whatsapp\.com\/channel\/([a-zA-Z0-9]+)/i);
    if (channelUrlMatch) {
        return `${channelUrlMatch[1]}@newsletter`;
    }

    if (/^120\d{10,}$/.test(sanitized)) {
        return `${sanitized}@g.us`;
    }

    if (/^[a-zA-Z0-9]{15,}$/.test(sanitized)) {
        return `${sanitized}@newsletter`;
    }

    return sanitized;
}

async function resolveChannelTargetId(client, targetId) {
    const normalizedId = normalizeWhatsAppId(targetId);

    if (!/@newsletter$/i.test(normalizedId)) {
        return normalizedId;
    }

    const inviteCode = extractInviteCode(targetId) || normalizedId.replace(/@newsletter$/i, '');

    try {
        const channel = await client.getChannelByInviteCode(inviteCode);
        const resolvedId = channel?.id?._serialized;

        if (resolvedId && /@newsletter$/i.test(resolvedId)) {
            if (resolvedId !== normalizedId) {
                logger.info(`Resolved channel invite code ${inviteCode} to WhatsApp channel ID ${resolvedId}`);
            }
            return resolvedId;
        }
    } catch (err) {
        logger.debug(`Could not resolve invite code ${inviteCode} to channel ID: ${err.message}`);
    }

    return normalizedId;
}


async function getChannelCandidatesFromPageStore(client) {
    try {
        const candidates = await client.pupPage.evaluate(() => {
            const ids = new Map();
            const addCandidate = (id, name, source, raw) => {
                if (!id || typeof id !== 'string' || !id.includes('@newsletter')) return;
                if (!ids.has(id)) {
                    ids.set(id, {
                        id,
                        name: name || 'WhatsApp Channel',
                        source,
                        raw: raw || '',
                    });
                }
            };

            const inspectModels = (models, source) => {
                if (!Array.isArray(models)) return;
                for (const item of models) {
                    try {
                        const serialized = item?.id?._serialized || item?.id?.toString?.() || item?.jid?._serialized || item?.jid || item?._serialized;
                        const name = item?.name || item?.formattedTitle || item?.displayName || item?.newsletterMetadata?.name;
                        const raw = JSON.stringify(item || {});
                        addCandidate(serialized, name, source, raw);
                    } catch (e) {
                        // ignore model parsing errors
                    }
                }
            };

            const store = window.Store || {};
            inspectModels(store.Chat?.models, 'Store.Chat.models');

            for (const [key, value] of Object.entries(store)) {
                if (!value) continue;
                if (Array.isArray(value?.models) && /newsletter|channel/i.test(key)) {
                    inspectModels(value.models, `Store.${key}.models`);
                }
            }

            return Array.from(ids.values());
        });

        return Array.isArray(candidates) ? candidates : [];
    } catch (err) {
        logger.debug(`Could not inspect WhatsApp Web store for channels: ${err.message}`);
        return [];
    }
}

async function resolveChannelTargetIdFromPage(client, targetId) {
    const normalizedId = normalizeWhatsAppId(targetId);
    if (!/@newsletter$/i.test(normalizedId)) return normalizedId;

    const inviteCode = extractInviteCode(targetId) || normalizedId.replace(/@newsletter$/i, '');

    try {
        await client.pupPage.goto(`https://web.whatsapp.com/channel/${inviteCode}`, {
            waitUntil: 'networkidle2',
            timeout: 45000,
        });
        await sleep(2500);
    } catch (err) {
        logger.debug(`Could not navigate to channel page ${inviteCode}: ${err.message}`);
    }

    const candidates = await getChannelCandidatesFromPageStore(client);
    if (!candidates.length) return normalizedId;

    const match = candidates.find((c) => c.raw && c.raw.includes(inviteCode));
    if (match?.id) {
        if (match.id !== normalizedId) {
            logger.info(`Resolved channel via WhatsApp Web store: ${match.id} (invite code ${inviteCode})`);
        }
        return match.id;
    }

    const fallback = candidates[0];
    if (fallback?.id) {
        logger.warn(`Could not map invite code ${inviteCode} exactly; using discovered channel ID ${fallback.id} from ${fallback.source}`);
        return fallback.id;
    }

    return normalizedId;
}

async function ensureTargetAvailable(client, targetId) {
    if (!targetId || resolvedTargets.has(targetId)) return;

    let lastError;

    // For regular chats and groups, try getChatById
    if (!/@newsletter$/i.test(targetId)) {
        try {
            const chat = await client.getChatById(targetId);
            if (chat) {
                resolvedTargets.add(targetId);
                return;
            }
        } catch (err) {
            lastError = err;
        }
    }

    // For newsletters/channels, use built-in methods
    if (/@newsletter$/i.test(targetId)) {
        const inviteCode = targetId.replace(/@newsletter$/i, '');
        
        // First, check if we already have access to this channel
        try {
            const channels = await client.getChannels();
            const found = channels && channels.find(c => c.id._serialized === targetId);
            
            if (found) {
                logger.info(`Found WhatsApp channel "${found.name}" (${inviteCode}) in your channels`);
                resolvedTargets.add(targetId);
                return;
            }
        } catch (err) {
            logger.debug(`getChannels check failed: ${err.message}`);
        }
        
        // Try to get channel by invite code and ensure it's loaded
        try {
            const channel = await client.getChannelByInviteCode(inviteCode);
            if (channel) {
                logger.info(`WhatsApp channel ${inviteCode} found via invite code: ${channel.name || 'Unknown'}`);
                
                // Check if we need to subscribe (required for sending)
                try {
                    const success = await client.subscribeToChannel(targetId);
                    if (success) {
                        logger.info(`Successfully subscribed to WhatsApp channel: ${inviteCode}`);
                    }
                } catch (subErr) {
                    // Might already be subscribed, that's fine
                    logger.debug(`Subscribe attempt: ${subErr.message}`);
                }
                
                // Wait a moment for the subscription to take effect
                await sleep(2000);
                
                resolvedTargets.add(targetId);
                return;
            }
        } catch (err) {
            lastError = err;
            logger.debug(`getChannelByInviteCode failed: ${err.message}`);
        }
        
        // Try to subscribe directly
        try {
            const success = await client.subscribeToChannel(targetId);
            if (success) {
                logger.info(`Successfully subscribed to WhatsApp channel: ${inviteCode}`);
                await sleep(2000);
                resolvedTargets.add(targetId);
                return;
            }
        } catch (err) {
            logger.debug(`Direct subscribe failed: ${err.message}`);
        }
        
        // Still add to resolved targets - the send might work if user has access
        logger.warn(`Could not verify WhatsApp channel ${inviteCode}, but will attempt to send anyway.`);
        resolvedTargets.add(targetId);
        return;
    }

    const message = `WhatsApp target ID "${targetId}" could not be resolved. Make sure it matches a chat, group, or channel you can post to.`;
    const error = new Error(message);
    if (lastError) {
        error.cause = lastError;
    }
    throw error;
}

function shouldRetrySend(err) {
    const message = err?.message || '';
    return message.includes('Execution context was destroyed') || message.includes('t: t');
}

/**
 * Pre-load a channel to ensure it's available in the WhatsApp Web session
 */
async function preloadChannel(client, channelId) {
    const inviteCode = channelId.replace(/@newsletter$/i, '');
    
    try {
        // Try to get channel metadata first
        const channel = await client.getChannelByInviteCode(inviteCode);
        if (channel) {
            logger.debug(`Pre-loaded channel: ${channel.name || inviteCode}`);
            
            // Ensure we're subscribed
            try {
                await client.subscribeToChannel(channelId);
                logger.debug(`Subscription confirmed for ${inviteCode}`);
            } catch (subErr) {
                // May already be subscribed
                logger.debug(`Subscription check: ${subErr.message}`);
            }
            
            return true;
        }
    } catch (err) {
        logger.warn(`Could not pre-load channel ${inviteCode}: ${err.message}`);
    }
    
    // Try alternative approach: navigate to the channel in WhatsApp Web
    try {
        logger.info(`Attempting to load channel via navigation: ${inviteCode}`);
        await client.pupPage.goto(`https://web.whatsapp.com/channel/${inviteCode}`, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        await sleep(3000);
        
        // Verify the channel loaded
        const channelUrl = client.pupPage.url();
        if (channelUrl.includes(inviteCode) || channelUrl.includes('channel')) {
            logger.info(`Successfully navigated to channel in WhatsApp Web`);
            
            // Try to subscribe again
            try {
                await client.subscribeToChannel(channelId);
            } catch (subErr) {
                logger.debug(`Post-navigation subscribe: ${subErr.message}`);
            }
            
            return true;
        }
    } catch (navErr) {
        logger.warn(`Navigation approach failed: ${navErr.message}`);
    }
    
    return false;
}

async function sendWithRetry(client, targetId, content, options) {
    let normalizedId = await resolveChannelTargetId(client, targetId);

    if (normalizedId.includes('@newsletter')) {
        normalizedId = await resolveChannelTargetIdFromPage(client, normalizedId);
    }
    
    // For channels, try to pre-load before ensuring target
    if (normalizedId.includes('@newsletter')) {
        await preloadChannel(client, normalizedId);
        await sleep(1000);
    }
    
    await ensureTargetAvailable(client, normalizedId);

    try {
        return await client.sendMessage(normalizedId, content, options);
    } catch (err) {
        const errMsg = err?.message || '';
        
        // Handle specific channel errors
        if (errMsg.includes('t: t') || errMsg.includes('Evaluation failed')) {
            const inviteCode = normalizedId.replace('@newsletter', '');
            logger.error('');
            logger.error('=== CHANNEL SEND ERROR ===');
            logger.error(`Channel ID: ${inviteCode}`);
            logger.error('This error usually means the channel is not properly followed/loaded.');
            logger.error('');
            logger.error('TO FIX THIS ISSUE:');
            logger.error('');
            logger.error('Option 1 - Follow via command line:');
            logger.error(`  npm run follow-channel https://whatsapp.com/channel/${inviteCode}`);
            logger.error('');
            logger.error('Option 2 - Follow manually in WhatsApp:');
            logger.error('  1. Open WhatsApp on your phone');
            logger.error('  2. Go to Updates tab → Channels');
            logger.error('  3. Search for your channel and tap "Follow"');
            logger.error('  4. Restart the forwarder');
            logger.error('');
            logger.error('IMPORTANT: Even as a channel admin/owner, you must "Follow"');
            logger.error('your own channel for the WhatsApp Web session to see and post to it.');
            logger.error('');
            throw new Error(`Failed to send to WhatsApp channel. Channel not properly followed. Run: npm run follow-channel https://whatsapp.com/channel/${inviteCode}`);
        }
        
        if (!shouldRetrySend(err)) {
            throw err;
        }
        logger.warn(`WhatsApp send failed (${errMsg}). Retrying once...`);
        resolvedTargets.delete(normalizedId);
        await preloadChannel(client, normalizedId);
        await sleep(2000);
        await ensureTargetAvailable(client, normalizedId);
        return client.sendMessage(normalizedId, content, options);
    }
}

async function sendText(client, targetId, text) {
    if (!text || !text.trim()) return;
    await sendWithRetry(client, targetId, text);
}

async function sendMediaFile(client, targetId, filePath, caption) {
    const mimeType = mime.lookup(filePath) || 'application/octet-stream';
    const data = await fs.readFile(filePath);
    const base64 = data.toString('base64');
    const filename = path.basename(filePath);
    const media = new MessageMedia(mimeType, base64, filename);
    await sendWithRetry(client, targetId, media, { caption: caption || '' });
}

async function sendMessage(client, targetId, payload) {
    const { text, filePath, mediaType } = payload;

    if (filePath && (await fs.pathExists(filePath))) {
        try {
            const captionText = text || '';
            await sendMediaFile(client, targetId, filePath, captionText);
        } finally {
            await fs.remove(filePath).catch(() => {});
        }
        return;
    }

    if (text && text.trim()) {
        await sendText(client, targetId, text);
    }
}

module.exports = {
    createWhatsAppClient,
    listChats,
    sendMessage,
    normalizeWhatsAppId,
    resolveChannelTargetId,
    resolveChannelTargetIdFromPage,
    getChannelCandidatesFromPageStore,
    extractInviteCode,
};
