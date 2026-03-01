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
            
            // Check if page is in a stable state
            if (navigationState.readyState === 'complete' && 
                !navigationState.url.includes('loading') &&
                navigationState.url.includes('web.whatsapp.com')) {
                // Give a bit more time for any post-load scripts
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

/**
 * Initialize the WhatsApp Web Store by injecting the required modules
 * This is needed for newsletter/channel functionality
 */
async function initializeStore(client) {
    // Wait for page to be stable before injection
    await waitForPageStable(client);
    
    try {
        await client.pupPage.evaluate(() => {
            // This injects the Store module which is required for newsletter operations
            if (!window.Store) {
                const webpack = window.webpackChunkwhatsapp_web_client || window.webpackChunkwhatsapp_web;
                if (webpack) {
                    const modules = webpack.push([[Symbol()], {}, (req) => req]);
                    const cache = modules.c || modules;
                    for (const key in cache) {
                        const mod = cache[key];
                        if (mod && mod.exports) {
                            if (mod.exports.default && mod.exports.default.Store) {
                                window.Store = mod.exports.default.Store;
                                break;
                            }
                            if (mod.exports.Store) {
                                window.Store = mod.exports.Store;
                                break;
                            }
                        }
                    }
                }
            }
        });
    } catch (err) {
        logger.debug(`Store initialization: ${err.message}`);
    }
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

    // Try to find using which command
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

    // Check for existing session and warn if it might be stale
    const sessionPath = path.join(__dirname, '../sessions/whatsapp');
    const sessionFile = path.join(sessionPath, 'session.json');
    if (await fs.pathExists(sessionFile)) {
        try {
            const stats = await fs.stat(sessionFile);
            const sessionAge = Date.now() - stats.mtimeMs;
            // If session file is older than 30 days, warn about potential expiry
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
        // Use 5 minute timeout to allow time for QR code scanning on first run
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
            if (readyFired) return; // Prevent double-firing
            readyFired = true;
            clearTimeout(timeout);
            clearTimeout(timeoutWarning);
            logger.info('WhatsApp userbot ready.');
            
            // Initialize the Store for newsletter/channel functionality
            await initializeStore(client);
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

        // Add timeout warning after 2 minutes if still connecting
        const timeoutWarning = setTimeout(() => {
            if (!readyFired) {
                if (qrGenerated) {
                    logger.warn('WhatsApp QR code was generated but not scanned within 2 minutes. Please scan now or restart to generate a new QR code.');
                } else {
                    logger.warn('WhatsApp is taking longer than 2 minutes to connect. This may indicate a session issue - the saved session may have expired.');
                }
            }
        }, 120_000);

        // Handle puppeteer/browser errors during initialization
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
    // Initialize Store first for newsletter access
    await initializeStore(client);
    
    // Wait for page to be stable before evaluating JavaScript
    await waitForPageStable(client);
    
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await sleep(2000);
            
            // Wait for page stability before each attempt
            await waitForPageStable(client);
            
            const chats = await client.getChats();
            
            // Also try to get channels via the newsletter method
            let allItems = chats.map((c) => ({
                id: c.id._serialized,
                name: c.name,
                type: c.isGroup ? 'group' : c.isChannel ? 'channel' : 'chat',
            }));
            
            // Try to get followed channels via the newsletter API (browser context)
            try {
                const newsletterChats = await client.pupPage.evaluate(async () => {
                    const result = [];
                    try {
                        // Try to get newsletters/channels using the internal WhatsApp Web API
                        // Access the Store module that whatsapp-web.js uses
                        const store = window.Store;
                        if (store && store.Newsletter) {
                            // Try getSubscribed method
                            if (store.Newsletter.getSubscribed) {
                                const newsletters = await store.Newsletter.getSubscribed();
                                for (const nl of newsletters) {
                                    result.push({
                                        id: nl.id?._serialized || nl.id,
                                        name: nl.name || nl.title || 'WhatsApp Channel',
                                    });
                                }
                            }
                            // Try newsletters property
                            if (store.Newsletter.newsletters) {
                                const nlMap = store.Newsletter.newsletters;
                                if (nlMap && typeof nlMap.forEach === 'function') {
                                    nlMap.forEach((nl) => {
                                        result.push({
                                            id: nl.id?._serialized || nl.id,
                                            name: nl.name || nl.title || 'WhatsApp Channel',
                                        });
                                    });
                                } else if (nlMap && typeof nlMap === 'object') {
                                    for (const key in nlMap) {
                                        const nl = nlMap[key];
                                        result.push({
                                            id: nl.id?._serialized || nl.id,
                                            name: nl.name || nl.title || 'WhatsApp Channel',
                                        });
                                    }
                                }
                            }
                        }
                        
                        // Also try NewsletterManager
                        if (store && store.NewsletterManager) {
                            if (store.NewsletterManager.getSubscribedNewsletters) {
                                const newsletters = await store.NewsletterManager.getSubscribedNewsletters();
                                for (const nl of newsletters) {
                                    result.push({
                                        id: nl.id?._serialized || nl.id,
                                        name: nl.name || nl.title || 'WhatsApp Channel',
                                    });
                                }
                            }
                        }
                    } catch (e) {
                        // Newsletter access failed, ignore
                    }
                    return result;
                });
                
                // Add channels that aren't already in the list
                for (const nl of newsletterChats || []) {
                    if (nl.id && !allItems.find(c => c.id === nl.id)) {
                        allItems.push({
                            id: nl.id,
                            name: nl.name,
                            type: 'channel',
                        });
                    }
                }
            } catch (e) {
                // Newsletter store access failed, continue with regular chats
            }
            
            return allItems;
        } catch (err) {
            const errorMessage = err.message || '';
            // Check for various navigation-related errors from whatsapp-web.js and puppeteer
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

    // For newsletters/channels, use special handling
    if (/@newsletter$/i.test(targetId)) {
        const inviteCode = targetId.replace(/@newsletter$/i, '');
        
        // First, try to check if we already have access to this newsletter via the Store
        try {
            const newsletterInfo = await client.pupPage.evaluate(async (code) => {
                try {
                    const store = window.Store;
                    if (store && store.Newsletter) {
                        // Try to get the newsletter from the store
                        const newsletterId = `${code}@newsletter`;
                        
                        // Check if we have this newsletter in our followed list
                        if (store.Newsletter.getNewsletterMetadata) {
                            const metadata = await store.Newsletter.getNewsletterMetadata(newsletterId);
                            if (metadata) {
                                return { found: true, subscribed: true, metadata };
                            }
                        }
                        
                        // Try to get via newsletter store directly
                        if (store.Newsletter.newsletters) {
                            const newsletters = store.Newsletter.newsletters;
                            const found = newsletters.find(n => n.id?._serialized === newsletterId || n.id === newsletterId);
                            if (found) {
                                return { found: true, subscribed: true };
                            }
                        }
                    }
                    return { found: false };
                } catch (e) {
                    return { found: false, error: e.message };
                }
            }, inviteCode);
            
            if (newsletterInfo && newsletterInfo.found) {
                logger.info(`Found WhatsApp channel ${inviteCode} in session`);
                resolvedTargets.add(targetId);
                return;
            }
        } catch (err) {
            logger.debug(`Newsletter store check failed: ${err.message}`);
        }
        
        // Try to subscribe/follow the newsletter if we don't have access
        try {
            logger.info(`Attempting to subscribe to WhatsApp channel: ${inviteCode}`);
            
            // Use the internal API to subscribe to the newsletter
            const subscribeResult = await client.pupPage.evaluate(async (code) => {
                try {
                    const store = window.Store;
                    if (store && store.Newsletter && store.Newsletter.subscribe) {
                        const newsletterId = `${code}@newsletter`;
                        await store.Newsletter.subscribe(newsletterId);
                        return { success: true };
                    }
                    
                    // Alternative: try to join via the GroupUtils or similar
                    if (store && store.GroupUtils && store.GroupUtils.joinGroupViaInvite) {
                        const result = await store.GroupUtils.joinGroupViaInvite(code);
                        return { success: !!result };
                    }
                    
                    return { success: false, reason: 'No subscribe method available' };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }, inviteCode);
            
            if (subscribeResult && subscribeResult.success) {
                logger.info(`Successfully subscribed to WhatsApp channel: ${inviteCode}`);
                resolvedTargets.add(targetId);
                return;
            } else {
                logger.debug(`Subscribe result: ${JSON.stringify(subscribeResult)}`);
            }
        } catch (err) {
            logger.debug(`Newsletter subscribe attempt failed: ${err.message}`);
        }
        
        // Try getChannelByInviteCode as a fallback to at least verify the channel exists
        try {
            const channel = await client.getChannelByInviteCode(inviteCode);
            if (channel) {
                logger.info(`WhatsApp channel ${inviteCode} verified via invite code`);
                // Add to resolved targets even if we can't fully verify subscription
                // The actual send might still work if the user has access
                resolvedTargets.add(targetId);
                return;
            }
        } catch (err) {
            lastError = err;
        }
        
        // As a last resort, just add it to resolved targets and try to send anyway
        // Some channels allow posting even without explicit subscription check
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
 * Send a message to a WhatsApp newsletter/channel using the internal Store API
 */
async function sendNewsletterMessage(client, targetId, content, options) {
    const inviteCode = targetId.replace(/@newsletter$/i, '');
    
    return await client.pupPage.evaluate(async (code, msgContent, msgOptions) => {
        try {
            const store = window.Store;
            const newsletterId = `${code}@newsletter`;
            
            // Try different methods to send to a newsletter
            if (store.Newsletter) {
                // Method 1: Try sendNewsletterMessage
                if (store.Newsletter.sendNewsletterMessage) {
                    const result = await store.Newsletter.sendNewsletterMessage(newsletterId, msgContent, msgOptions);
                    return { success: true, method: 'sendNewsletterMessage', result };
                }
                
                // Method 2: Try to use the NewsletterManager
                if (store.NewsletterManager && store.NewsletterManager.sendToNewsletter) {
                    const result = await store.NewsletterManager.sendToNewsletter(newsletterId, msgContent, msgOptions);
                    return { success: true, method: 'NewsletterManager', result };
                }
                
                // Method 3: Try to get the newsletter chat and send via Wap
                if (store.Wap && store.Wap.newsletter) {
                    const result = await store.Wap.newsletter.sendMessage(newsletterId, msgContent);
                    return { success: true, method: 'Wap.newsletter', result };
                }
            }
            
            // Method 4: Try via msgData method
            if (store.MsgData && store.MsgData.sendNewsletterMsg) {
                const result = await store.MsgData.sendNewsletterMsg(newsletterId, msgContent);
                return { success: true, method: 'MsgData', result };
            }
            
            // Method 5: Try to use the addAndSendMsgToChat method
            if (store.SendMessage && store.SendMessage.addAndSendMsgToChat) {
                // Create a fake chat object for the newsletter
                const chat = {
                    id: newsletterId,
                    isNewsletter: true
                };
                const result = await store.SendMessage.addAndSendMsgToChat(chat, msgContent, msgOptions);
                return { success: true, method: 'SendMessage', result };
            }
            
            return { success: false, reason: 'No newsletter send method found in Store' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }, inviteCode, content, options);
}

async function sendWithRetry(client, targetId, content, options) {
    const normalizedId = normalizeWhatsAppId(targetId);
    await ensureTargetAvailable(client, normalizedId);

    // For newsletters/channels, try the specialized API first
    if (/@newsletter$/i.test(normalizedId)) {
        try {
            const result = await sendNewsletterMessage(client, normalizedId, content, options);
            if (result && result.success) {
                logger.debug(`Newsletter message sent via ${result.method}`);
                return result.result;
            }
            logger.debug(`Newsletter API send result: ${JSON.stringify(result)}`);
            // Fall through to regular sendMessage as fallback
        } catch (err) {
            logger.debug(`Newsletter API send failed: ${err.message}, trying regular sendMessage`);
        }
    }

    try {
        return await client.sendMessage(normalizedId, content, options);
    } catch (err) {
        if (!shouldRetrySend(err)) {
            throw err;
        }
        logger.warn(`WhatsApp send failed (${err.message}). Retrying once...`);
        resolvedTargets.delete(normalizedId);
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
    initializeStore,
};
