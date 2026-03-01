# Telegram → WhatsApp Channel Forwarder

A userbot that watches one or more **Telegram channels** and automatically forwards every new message to a **WhatsApp channel (newsletter) or group**.

**Powered by [Baileys](https://github.com/WhiskeySockets/Baileys) — no Chrome or Puppeteer required.** Connects directly to WhatsApp Web via WebSocket, saving ~500 MB of RAM compared to browser-based approaches.

Supports all major Telegram content types:

| Type | Forwarded as |
|---|---|
| Text messages | Text message |
| Photos | Image + caption |
| Videos | Video + caption |
| Audio / Voice | Audio file |
| Documents / Files | File attachment + caption |
| Animated GIFs | Video (gifPlayback) |
| Stickers | WebP sticker |
| Webpage previews | Text with link |
| Polls | Formatted text |
| Locations | Google Maps link |
| Contacts | Formatted text |

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

# Optional
MESSAGE_PREFIX=
MAX_FILE_SIZE_MB=50
SEND_DELAY_MS=1500
LOG_LEVEL=info
# For WhatsApp channels/newsletters: "document" (default) or "native"
NEWSLETTER_MEDIA_MODE=document
# Telegram polling fallback (helps when some channels are missed by event updates)
TELEGRAM_POLLING_ENABLED=true
TELEGRAM_POLL_INTERVAL_MS=15000
```

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

Useful commands:

```bash
pm2 list                          # see all processes
pm2 logs tg-wa-forwarder          # stream live logs
pm2 restart tg-wa-forwarder       # restart
pm2 stop tg-wa-forwarder          # stop
```

Auto-start on reboot:

```bash
pm2 startup        # follow the printed command
pm2 save
```

---

## 6 · Directory Structure

```
.
├── src/
│   ├── index.js            # Entry point
│   ├── telegramClient.js   # GramJS userbot, media download, event listener
│   ├── whatsappClient.js   # Baileys WebSocket client, send helpers
│   ├── forwarder.js        # Message queue + download → format → send pipeline
│   ├── messageFormatter.js # Builds WhatsApp message text/caption
│   ├── logger.js           # Winston logger (console + file)
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

## 7 · Troubleshooting

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

---

## 8 · Why Baileys instead of whatsapp-web.js?

| | whatsapp-web.js | **Baileys** |
|---|---|---|
| Requires Chrome/Puppeteer | ✅ Yes (~500 MB RAM) | ❌ No — WebSocket only |
| Memory usage | ~600–900 MB | ~50–100 MB |
| Connection speed | Slow (browser boot) | Fast (WebSocket) |
| Auto-reconnect | Manual | Built-in with backoff |
| Newsletter/channel support | Fragile (DOM scraping) | Native API support |
| Media streaming | Base64 in memory | Efficient streams |

---

## 9 · Notes

- **WhatsApp channels** require the linked account to be the channel admin/owner to post messages.
- **WhatsApp groups** work with any member account.
- This project uses the unofficial WhatsApp Web protocol — use at your own risk.
- Telegram API requires a real user account (userbot), not a bot token.

---

## License

GPL-3.0 © [abyn365](https://github.com/abyn365)
