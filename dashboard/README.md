# Dashboard (Vercel)

Standalone Next.js dashboard for Telegram→WhatsApp forwarder data.

## Run locally
```bash
npm install
npm run dev
```

## Required env
```env
UPSTASH_REDIS_REST_URL=https://<your-instance>.upstash.io
UPSTASH_REDIS_REST_TOKEN=<your-token>
JWT_SECRET=replace-with-long-random-secret
ADMIN_USERNAME=admin
ADMIN_PASSWORD=ChangeThisNow123!
NEXT_TELEMETRY_DISABLED=1
```

## Deploy
- Deploy this folder to Vercel.
- Ensure env vars are set.


## Embed styling note
- Telegram embeds are rendered from Telegram domain (`t.me`) and cannot be deeply restyled from your CSS due cross-origin isolation.
- Recommended approach: use your own styled preview cards (text + metadata + source link) and provide an "Open embed" action for full details.
- If you want fully custom media cards, expand the bot storage schema to save richer media metadata (e.g., thumbnail URL, media type, dimensions) in Upstash and render that in your own UI/API.
