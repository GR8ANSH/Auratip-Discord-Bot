# AuraTip Discord Bot

⚡ Official Discord bot for the [AuraTip](https://auratip.live) live streaming tipping platform.

## Features

- **Personal DM Onboarding** — Sends creator credentials via private DM (never to public channels)
- **Username Resolution** — Resolves Discord usernames, nicknames & mentions to Snowflake IDs via guild member search
- **Live Tip Alert Broadcasts** — Posts real-time tip alerts to your server channel
- **Slash Commands** — `/ping` and more
- **Gateway Presence** — Shows "Collecting Auratips for streamers" activity
- **Smart Dispatch** — Intelligent multi-target routing (DM → Channel → Webhook)
- **Audit Logging** — Persistent dispatch history in JSON

## Setup

1. Clone this repo
2. Copy `.env.example` to `.env` and fill in your credentials
3. `npm install`
4. `npm start`

## Environment Variables

| Variable | Description |
|---|---|
| `DISCORD_BOT_TOKEN` | Bot token from Discord Developer Portal |
| `DISCORD_CLIENT_ID` | Application/Bot client ID |
| `DISCORD_GUILD_ID` | Your Discord server ID |
| `DISCORD_ONBOARDING_CHANNEL_ID` | Channel for non-sensitive announcements |
| `DISCORD_WEBHOOK_URL` | Optional webhook fallback |

## Integration with AuraTip

This bot is designed to work standalone **or** as a module imported by the main AuraTip platform server. When used as a module:

```js
const discordBot = require('auratip-discord-bot');

// Inject platform context
discordBot.setContext({ prisma, io, getAuraThemeForAmount });
await discordBot.init();

// Send personal DM (supports usernames, not just IDs)
await discordBot.sendDirectMessage('gr8ansh', payload);

// Broadcast tip alert to server channel
await discordBot.broadcastTipAlert(creator, tip);
```

## License

MIT © [gr8ansh](https://github.com/gr8ansh)
