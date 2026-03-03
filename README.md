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

## Required `.env`
```env
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=abcdef1234567890abcdef1234567890
TELEGRAM_PHONE=+1234567890
TELEGRAM_CHANNELS=@channel1,@channel2
WHATSAPP_TARGET_ID=120363xxxxxxxxxx@newsletter
```

### Multiple Telegram Accounts
Use either comma-separated values in `TELEGRAM_API_ID/HASH/PHONE` or:
```env
TELEGRAM_ACCOUNTS_JSON=[{"apiId":12345678,"apiHash":"abcdef1234567890abcdef1234567890","phone":"+1234567890"}]
```

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

## Notes
- WhatsApp channels support images/videos/text best; other types may degrade to text fallback.
- This project uses unofficial WhatsApp Web protocol; use responsibly.

## License
GPL-3.0
