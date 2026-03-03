# Telegram → WhatsApp Forwarder + Next.js Dashboard

Forwards messages from one or more Telegram channels to a WhatsApp channel/group, and exposes a live web dashboard + admin panel.

## Features
- Telegram → WhatsApp forwarding (text, images, videos, links, polls, etc.)
- Deduplication, retries, queue/rate control, health logging
- Optional translation via LibreTranslate
- Next.js dashboard with live feed + Telegram embeds
- Admin panel (JWT auth, salted password hashing)
- Upstash Redis REST storage for settings, channels, and previews
- Multiple Telegram account support

## Quick Start
```bash
git clone https://github.com/abyn365/telegram-channel-to-whatsapp-channel.git
cd telegram-channel-to-whatsapp-channel
npm install
cp .env.example .env
# edit .env
npm start
```

`npm start` defaults `NODE_ENV=production` for stable runtime (avoids Next dev CSP/eval issues). Use `npm run dashboard:dev` for dashboard development mode.

## Required `.env`
```env
# Default Telegram config (JSON)
TELEGRAM_ACCOUNTS_JSON=[{"apiId":12345678,"apiHash":"abcdef1234567890abcdef1234567890","phone":"+1234567890"}]

TELEGRAM_CHANNELS=@channel1,@channel2
WHATSAPP_TARGET_ID=120363xxxxxxxxxx@newsletter
```

### Multiple Telegram Accounts (JSON example)
```env
TELEGRAM_ACCOUNTS_JSON=[{"apiId":12345678,"apiHash":"abcdef1234567890abcdef1234567890","phone":"+1234567890"},{"apiId":87654321,"apiHash":"1234567890abcdef1234567890abcdef","phone":"+19876543210"}]
```

### Legacy fallback (optional)
If needed, you can still use comma-separated values:
```env
TELEGRAM_API_ID=12345678,87654321
TELEGRAM_API_HASH=abcdef1234567890abcdef1234567890,1234567890abcdef1234567890abcdef
TELEGRAM_PHONE=+1234567890,+19876543210
```


**TELEGRAM_ACCOUNTS_JSON parsing note**
- Must be valid JSON on a single line.
- Do not append inline comments at the end of the same line.
- If JSON is invalid and legacy vars are present, the app falls back to `TELEGRAM_API_ID/HASH/PHONE`.

## Dashboard / Admin
Set:
```env
DASHBOARD_PORT=8787
JWT_SECRET=replace-with-long-random-secret
ADMIN_USERNAME=admin
ADMIN_PASSWORD=ChangeThisNow123!
UPSTASH_REDIS_REST_URL=https://<your-instance>.upstash.io
UPSTASH_REDIS_REST_TOKEN=<your-token>
NEXT_TELEMETRY_DISABLED=1
```

### Dashboard Commands
```bash
npm run dashboard:dev
npm run dashboard:build
npm run dashboard:start
```

`npm start` and PM2 forwarder startup now automatically try to start the dashboard. In production, if `.next` build is missing, it auto-runs `npm run dashboard:build`. If Next.js cannot start, it falls back to the static `web/` dashboard.

## WhatsApp ID Helpers
```bash
npm run list-chats
npm run list-chats https://whatsapp.com/channel/<invite>
npm run follow-channel https://whatsapp.com/channel/<invite>
```

## PM2 (Production)
```bash
npm run start:pm2
npm run logs:pm2
npm run restart:pm2
npm run stop:pm2
```

## Security Notes
- Admin APIs require Bearer JWT.
- Passwords are stored as salted hashes.
- Security headers are applied (CSP, frame/type/referrer protections).
- Change default admin credentials and use a strong `JWT_SECRET`.

## Cloudflare Deployment (A Record + TLS)
1. Point domain/subdomain A record to your server IP (proxied).
2. Use Cloudflare SSL mode **Full (strict)**.
3. Install Cloudflare Origin Certificate on your reverse proxy.
4. Proxy `https://your-domain` → `http://127.0.0.1:DASHBOARD_PORT`.

## Common Warnings
- `TypeError: Cannot destructure property 'subtle' of globalThis.crypto` was fixed by a webcrypto polyfill at startup (`src/webcryptoPolyfill.js`).
- `OSError: [Errno 98] Address already in use` for LibreTranslate means port `LIBRETRANSLATE_PORT` is already occupied. This is usually not critical if translation service is already running on that port.
- `RequestsDependencyWarning` from Python packages is non-fatal; forwarding can still run.
- If translation shows HTTP 400, verify LibreTranslate endpoint/health (`/languages`) and language params.

## Notes
- WhatsApp channels support images/videos/text best; other types may degrade to text fallback.
- This project uses unofficial WhatsApp Web protocol; use responsibly.

## License
GPL-3.0
