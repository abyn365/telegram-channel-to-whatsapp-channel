# Telegram → WhatsApp Channel Forwarder

A userbot that watches one or more **Telegram channels** and automatically forwards every new message to a **WhatsApp channel or group**.

Supports all major Telegram content types:

| Type | Forwarded as |
|---|---|
| Text messages | Text message |
| Photos | Image + caption |
| Videos | Video + caption |
| Audio / Voice | Audio file + caption |
| Documents / Files | File attachment + caption |
| Animated GIFs | GIF/video + caption |
| Stickers | Image/webp |
| Webpage previews | Text with link |
| Polls | Formatted text |
| Locations | Google Maps link |
| Contacts | Formatted text |

---

## Prerequisites

- **Ubuntu VPS** (20.04 / 22.04 / 24.04 recommended)
- **Node.js 18+** — install via [nvm](https://github.com/nvm-sh/nvm) or NodeSource
- **PM2** — `npm install -g pm2`
- **Google Chrome / Chromium** — required by WhatsApp Web
- **Telegram API credentials** — get from [my.telegram.org](https://my.telegram.org)

---

## 1 · Install Chrome on Ubuntu

```bash
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt update && sudo apt install -y google-chrome-stable
```

Or Chromium:

```bash
sudo apt update && sudo apt install -y chromium-browser
```

---

## 2 · Clone & Install

```bash
git clone https://github.com/abyn365/telegram-channel-to-whatsapp-channel.git
cd telegram-channel-to-whatsapp-channel
npm install
```

---

## 3 · Configure

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

# Comma-separated channels to watch (username or numeric ID)
TELEGRAM_CHANNELS=@mychannel,@anotherchannel

# WhatsApp target (channel or group ID — see Step 4)
WHATSAPP_TARGET_ID=120363xxxxxxxxxx@newsletter

# Optional
MESSAGE_PREFIX=
MAX_FILE_SIZE_MB=50
LOG_LEVEL=info
```

---

## 4 · First Run — Authenticate Both Accounts

### 4a · Authenticate Telegram

Run the app once in interactive mode:

```bash
npm start
```

It will ask for:
1. Your **verification code** (sent via SMS / Telegram app)
2. Your **2FA password** (if enabled)

The session is saved to `sessions/telegram.session` — you won't need to log in again.

### 4b · Authenticate WhatsApp

During the same first run, a **QR code** will be printed in the terminal.  
Open WhatsApp on your phone → **Linked Devices** → **Link a Device** → scan the QR.

The session is saved to `sessions/whatsapp/` — persistent across restarts.

### 4c · Find Your WhatsApp Channel / Group ID

After WhatsApp is connected, **Ctrl+C** to stop, then run:

```bash
npm run list-chats
```

This prints all available chats with their IDs. Copy the correct ID into `WHATSAPP_TARGET_ID` in `.env`.

---

## 5 · Run in the Background with PM2

Install PM2 globally if you haven't:

```bash
npm install -g pm2
```

Start the forwarder:

```bash
npm run start:pm2
# or directly:
pm2 start ecosystem.config.js
```

Useful PM2 commands:

```bash
pm2 list                          # see all processes
pm2 logs tg-wa-forwarder          # stream live logs
pm2 restart tg-wa-forwarder       # restart the process
pm2 stop tg-wa-forwarder          # stop the process
pm2 delete tg-wa-forwarder        # remove from PM2
```

### Auto-start on system reboot

```bash
pm2 startup        # follow the printed command
pm2 save           # save current process list
```

---

## 6 · Directory Structure

```
.
├── src/
│   ├── index.js            # Entry point — wires everything together
│   ├── telegramClient.js   # GramJS userbot, media download, event listener
│   ├── whatsappClient.js   # whatsapp-web.js client, QR login, send helpers
│   ├── forwarder.js        # Orchestrates download → format → send pipeline
│   ├── messageFormatter.js # Builds WhatsApp message text/caption
│   ├── logger.js           # Winston logger (console + file)
│   └── listChats.js        # Utility script to list WhatsApp chats
├── sessions/               # Persisted auth sessions (gitignored)
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
| WhatsApp QR not showing | Run `npm start` in an interactive terminal first |
| `CHROME_PATH` errors | Install Chrome/Chromium (see Step 1) |
| Telegram flood/ban errors | Use your own API credentials, avoid mass testing |
| Large files not forwarded | Increase `MAX_FILE_SIZE_MB` or WhatsApp's 100 MB limit applies |
| Session expired (WhatsApp) | Delete `sessions/whatsapp/` and re-scan QR |
| Session expired (Telegram) | Delete `sessions/telegram.session` and re-login |

---

## Notes

- **WhatsApp channels** require the account linked to be the channel admin.  
- **WhatsApp groups** work with any member account.  
- This project uses the unofficial WhatsApp Web protocol — use at your own risk.  
- Telegram API requires a real user account (userbot), not a bot token.

---

## License

GPL-3.0 © [abyn365](https://github.com/abyn365)
