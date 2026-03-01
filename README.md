# Telegram → WhatsApp Channel Forwarder

A userbot that watches one or more **Telegram channels** and automatically forwards every new message to a **WhatsApp channel (newsletter) or group**.

**Powered by [Baileys](https://github.com/WhiskeySockets/Baileys) — no Chrome or Puppeteer required.** Connects directly to WhatsApp Web via WebSocket, saving ~500 MB of RAM compared to browser-based approaches.

Supports all major Telegram content types:

| Type | Forwarded as |
|---|---|
| Text messages | Text message |
| Photos | **Native image** (viewable in-app) + caption |
| Videos | **Native video** (viewable in-app) + caption |
| Audio / Voice | Audio file |
| Documents / Files | File attachment + caption |
| Animated GIFs | Video (gifPlayback) |
| Stickers | WebP sticker |
| Webpage previews | Text with link |
| Polls | Formatted text |
| Locations | Google Maps link |
| Contacts | Formatted text |

---

## ✨ Key Features

- **🖼️ Native Media Viewing**: Images and videos are sent as native WhatsApp media that can be viewed directly in the app (not as downloadable documents)
- **📝 Caption Support**: Full caption support for all media types - captions are properly attached to images/videos
- **🔄 Smart Fallback**: If native media fails, automatically retries with alternative methods
- **⚡ Production Ready**: Health monitoring, automatic reconnection, graceful shutdown, and comprehensive error handling
- **🌐 Translation Support**: Optional automatic translation to Indonesian (or any language) via LibreTranslate
- **📊 Queue Management**: Message queue with rate limiting to avoid WhatsApp bans
- **🔍 Deduplication**: Prevents duplicate message forwarding

---

## Prerequisites

- **Ubuntu VPS** (20.04 / 22.04 / 24.04 recommended)
- **Node.js 18+** — install via [nvm](https://github.com/nvm-sh/nvm) or NodeSource
- **PM2** (optional) — `npm install -g pm2`
- **Telegram API credentials** — get from [my.telegram.org](https://my.telegram.org)

> ✅ No Chrome or Chromium installation needed — Baileys uses WebSockets directly.

---

## 1 · Clone & Install

```bash
git clone https://github.com/abyn365/telegram-channel-to-whatsapp-channel.git
cd telegram-channel-to-whatsapp-channel
npm install
```

---

## 2 · Configure

```bash
cp .env.example .env
nano .env
```

Fill in the required values:

```env
# Telegram — from https://my.telegram.org
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=abcdef1234567890abcdef1234567890
TELEGRAM_PHONE=+1234567890

# Comma-separated Telegram channels to watch
TELEGRAM_CHANNELS=@mychannel,@anotherchannel

# WhatsApp target (channel JID or group JID — see Step 3)
WHATSAPP_TARGET_ID=120363282083849178@newsletter

# Optional - Media settings
NEWSLETTER_MEDIA_MODE=native  # "native" for in-app viewing, "document" for files
MAX_FILE_SIZE_MB=50
SEND_DELAY_MS=1500

# Optional - Translation
TRANSLATE_TO_ID=true
LIBRETRANSLATE_URL=http://127.0.0.1:5000/translate
```

### Important Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `NEWSLETTER_MEDIA_MODE` | How to send media to WhatsApp channels: `native` (viewable in-app) or `document` (downloadable file) | `native` |
| `WHATSAPP_SEND_SOURCE_LINK` | Include link to original Telegram message | `true` |
| `MAX_RETRIES` | Number of retry attempts for failed messages | `3` |
| `SEND_DELAY_MS` | Delay between messages to avoid rate limits | `1500` |
| `HEALTH_CHECK_INTERVAL_MS` | How often to check connection health | `60000` |

---

## 3 · Find Your WhatsApp Channel or Group ID

### For WhatsApp Channels (newsletters):

Run with your channel's invite URL:

```bash
npm run list-chats https://whatsapp.com/channel/0029Vb7T8V460eBW2gKeNC1x
```

This will output:

```
[CHANNEL FOUND]
  Name:        My Channel
  JID:         120363282083849178@newsletter
  Subscribers: 1234
  URL:         https://whatsapp.com/channel/0029Vb7T8V460eBW2gKeNC1x

Set in .env:
  WHATSAPP_TARGET_ID=120363282083849178@newsletter
```

Copy the JID into your `.env`.

### For Groups:

```bash
npm run list-chats
```

This lists all groups your account is in. Copy the group JID (e.g. `120363xxxxxxxxxx@g.us`).

### Follow / subscribe to a channel:

```bash
npm run follow-channel https://whatsapp.com/channel/0029Vb7T8V460eBW2gKeNC1x
```

---

## 4 · First Run — Authenticate Both Accounts

```bash
npm start
```

> If `TRANSLATE_TO_ID=true`, this command also starts LibreTranslate locally via virtualenv `.venv-libretranslate`.

### Telegram
You will be prompted for:
1. Your **verification code** (sent via SMS or Telegram app)
2. Your **2FA password** (if enabled)

Session is saved to `sessions/telegram.session`.

### WhatsApp
A **QR code** will appear in the terminal.  
Open WhatsApp on your phone → **Linked Devices** → **Link a Device** → scan QR.

Session is saved to `sessions/baileys/` — persistent across restarts.

---

## 5 · Run in the Background with PM2

```bash
npm install -g pm2
npm run start:pm2
```

The PM2 command above runs **2 processes**:
- `tg-wa-translator` (LibreTranslate)
- `tg-wa-forwarder` (Telegram → WhatsApp bridge)

Useful commands:

```bash
pm2 list                          # see all processes
pm2 logs tg-wa-forwarder tg-wa-translator   # stream live logs
pm2 restart tg-wa-forwarder tg-wa-translator # restart
pm2 stop tg-wa-forwarder tg-wa-translator    # stop
```

Auto-start on reboot:

```bash
pm2 startup        # follow the printed command
pm2 save
```

---

## 6 · Media Handling

### Native Media (Recommended)

By default, `NEWSLETTER_MEDIA_MODE=native` sends images and videos as native WhatsApp media that users can view directly in the app:

- **Images**: Display inline, tap to view full size
- **Videos**: Play directly in the chat
- **Captions**: Attached to the media (for regular chats) or sent as separate message (for channels)

### Document Mode

If you experience issues with native media, set `NEWSLETTER_MEDIA_MODE=document` to send all media as downloadable files.

### Caption Handling

The system handles captions intelligently:

1. **Regular chats**: Caption is attached directly to the media
2. **Channels**: Caption is sent as a separate text message after the media (due to WhatsApp channel limitations)
3. **Fallback**: If media fails to send, the caption text is still delivered

---

## 7 · Health Monitoring

The forwarder includes built-in health monitoring:

- **Connection Health**: Checks WhatsApp and Telegram connection status every minute
- **Queue Status**: Monitors message queue size and processing statistics
- **Automatic Reconnection**: Reconnects automatically with exponential backoff
- **Memory Monitoring**: Optional periodic memory usage logging (`LOG_MEMORY_USAGE=true`)

View health status in logs:
```
Health check: Telegram=OK, WhatsApp=OK, Queue=0 pending, 42 processed, 0 failed
```

---

## 8 · Directory Structure

```
.
├── src/
│   ├── index.js            # Entry point, health monitoring
│   ├── telegramClient.js   # GramJS userbot, media download, event listener
│   ├── whatsappClient.js   # Baileys WebSocket client, native media support
│   ├── forwarder.js        # Message queue + download → format → send pipeline
│   ├── messageFormatter.js # Builds WhatsApp message text/caption
│   ├── logger.js           # Winston logger (console + file)
│   ├── forwardedStore.js   # Deduplication store
│   ├── translator.js       # LibreTranslate integration
│   ├── listChats.js        # Utility: look up WhatsApp channel/group IDs
│   └── followChannel.js    # Utility: follow/subscribe to a WhatsApp channel
├── sessions/
│   ├── baileys/            # WhatsApp auth (Baileys multi-file state)
│   └── telegram.session    # Telegram session string
├── logs/                   # Log files (gitignored)
├── temp/                   # Temporary media files (auto-cleaned)
├── ecosystem.config.js     # PM2 configuration
├── .env.example            # Environment variable template
└── package.json
```

---

## 9 · Troubleshooting

| Problem | Solution |
|---|---|
| WhatsApp QR not showing | Run `npm start` in an interactive terminal |
| Session expired (WhatsApp) | Delete `sessions/baileys/` and re-scan QR |
| Session expired (Telegram) | Delete `sessions/telegram.session` and re-login |
| Telegram flood/ban errors | Use your own API credentials, avoid mass testing |
| Large files not forwarded | Increase `MAX_FILE_SIZE_MB` (WhatsApp limit: 100 MB) |
| Channel not found | Run `npm run list-chats <channel-url>` to resolve the JID |
| Messages too fast / rate limited | Increase `SEND_DELAY_MS` in `.env` (default: 1500) |
| Cannot post to channel | Your WhatsApp account must be an admin of the newsletter |
| Media sent as document | Set `NEWSLETTER_MEDIA_MODE=native` in `.env` |
| Captions not showing | For channels, captions are sent as separate messages |
| Translation not working | Ensure LibreTranslate is running on the configured URL |

---

## 10 · Why Baileys instead of whatsapp-web.js?

| | whatsapp-web.js | **Baileys** |
|---|---|---|
| Requires Chrome/Puppeteer | ✅ Yes (~500 MB RAM) | ❌ No — WebSocket only |
| Memory usage | ~600–900 MB | ~50–100 MB |
| Connection speed | Slow (browser boot) | Fast (WebSocket) |
| Auto-reconnect | Manual | Built-in with backoff |
| Newsletter/channel support | Fragile (DOM scraping) | Native API support |
| Media streaming | Base64 in memory | Efficient streams |

---

## 11 · Notes

- **WhatsApp channels** require the linked account to be the channel admin/owner to post messages.
- **WhatsApp groups** work with any member account.
- This project uses the unofficial WhatsApp Web protocol — use at your own risk.
- Telegram API requires a real user account (userbot), not a bot token.
- For best results with channels, use `NEWSLETTER_MEDIA_MODE=native` (default).

---

## License

GPL-3.0 © [abyn365](https://github.com/abyn365)

---

## 12 · Translation (LibreTranslate)

Run LibreTranslate locally:

```bash
python3 -m venv .venv-libretranslate
source .venv-libretranslate/bin/activate
pip install libretranslate
libretranslate --host 0.0.0.0 --port 5000
```

For Ubuntu/Debian with `externally-managed-environment` error, **don't** install globally via `pip install libretranslate`; use virtualenv as above (or let `npm start`/PM2 create it automatically).

If venv fails to be created, install system packages: `apt install python3-venv`.

Quick API check:

```bash
curl -X POST http://localhost:5000/translate \
  -d q="Hello" \
  -d source=en \
  -d target=id
```
