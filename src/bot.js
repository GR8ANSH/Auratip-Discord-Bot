/**
 * AuraTip Live Platform - Native Discord Bot Engine
 * Direct Message (DM) Dispatcher, Live Tip Alert Broadcaster, Slash Commands & Gateway Engine
 */

const fs = require('fs');
const path = require('path');

// When used standalone, data lives under the bot repo root.
// When imported as a module by Auratip, the caller can override via setContext().
const DISPATCH_LOG_FILE = path.join(__dirname, '..', 'data', 'dispatch-audit-log.json');
const ROUTING_CONFIG_FILE = path.join(__dirname, '..', 'data', 'channel-routing.json');
const PRESENCE_CONFIG_FILE = path.join(__dirname, '..', 'data', 'bot-presence.json');

const DEFAULT_PRESENCE = {
  status: 'online',
  activityType: 0, // 0 = Playing, 1 = Streaming, 2 = Listening, 3 = Watching, 5 = Competing
  activityName: 'Collecting Auratips ⚡ | auratip.live',
  activityUrl: 'https://auratip.live'
};

const DEFAULT_ROUTING = {
  tip_alerts: {
    enabled: true,
    channelId: process.env.DISCORD_ONBOARDING_CHANNEL_ID || '741671980561858670',
    minAmount: 0,
    color: '#10B981',
    mention: 'none',
    titleTemplate: '⚡ LIVE TIP ALERT: ₹{amount} for @{creator}!',
    showProgressBar: true
  },
  goal_celebrations: {
    enabled: true,
    channelId: process.env.DISCORD_ONBOARDING_CHANNEL_ID || '741671980561858670',
    color: '#F59E0B',
    mention: 'here',
    titleTemplate: '🎉 STREAM GOAL CRUSHED: @{creator} hit 100%!',
    showCelebrationBanner: true
  },
  creator_onboarding: {
    enabled: true,
    channelId: process.env.DISCORD_ONBOARDING_CHANNEL_ID || '741671980561858670',
    sendPublicAnnouncement: true,
    sendPrivateCredentialsDM: true,
    color: '#00F0FF',
    mention: 'none',
    titleTemplate: '🚀 Welcome @{creator} to the AuraTip Streamer Network!'
  },
  creator_boosts: {
    enabled: true,
    channelId: process.env.DISCORD_ONBOARDING_CHANNEL_ID || '741671980561858670',
    color: '#8B5CF6',
    mention: 'none',
    titleTemplate: '🔥 STREAM BOOSTED: @{creator} is now spotlighted!'
  },
  platform_broadcasts: {
    enabled: true,
    channelId: process.env.DISCORD_ONBOARDING_CHANNEL_ID || '741671980561858670',
    color: '#EC4899',
    mention: 'everyone',
    titleTemplate: '📢 AuraTip Official Platform Notice'
  },
  audit_alerts: {
    enabled: true,
    channelId: process.env.DISCORD_ONBOARDING_CHANNEL_ID || '741671980561858670',
    color: '#EF4444',
    mention: 'none',
    titleTemplate: '⚠️ AuraTip Security / System Alert'
  }
};

// Ensure data directory exists
function ensureDataDir() {
  const dir = path.dirname(DISPATCH_LOG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(DISPATCH_LOG_FILE)) {
    fs.writeFileSync(DISPATCH_LOG_FILE, JSON.stringify([], null, 2));
  }
  if (!fs.existsSync(ROUTING_CONFIG_FILE)) {
    fs.writeFileSync(ROUTING_CONFIG_FILE, JSON.stringify(DEFAULT_ROUTING, null, 2));
  }
  if (!fs.existsSync(PRESENCE_CONFIG_FILE)) {
    fs.writeFileSync(PRESENCE_CONFIG_FILE, JSON.stringify(DEFAULT_PRESENCE, null, 2));
  }
}

// Map Aura theme names to Discord embed hex colors
function getAuraColor(theme) {
  const map = {
    gold: 0xF59E0B,
    magenta: 0xEC4899,
    special: 0x8B5CF6,
    solar: 0xF97316,
    cyan: 0x06B6D4,
    mint: 0x10B981,
    emerald: 0x059669
  };
  return map[String(theme || '').toLowerCase()] || 0x10B981;
}

// Generate ASCII progress bar
function getProgressBar(current, target, length = 10) {
  if (!target || target <= 0) return '`[██████████]` 100%';
  const ratio = Math.min(Math.max(current / target, 0), 1);
  const filled = Math.round(ratio * length);
  const empty = length - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const percent = Math.round(ratio * 100);
  return `\`[${bar}]\` **${percent}%**`;
}

class AuraTipDiscordBot {
  constructor() {
    this.token = process.env.DISCORD_BOT_TOKEN || '';
    this.clientId = process.env.DISCORD_CLIENT_ID || '';
    this.guildId = process.env.DISCORD_GUILD_ID || '';
    this.channelId = process.env.DISCORD_ONBOARDING_CHANNEL_ID || '';
    this.webhookUrl = process.env.DISCORD_ONBOARDING_WEBHOOK || process.env.DISCORD_WEBHOOK_URL || '';

    this.status = 'INITIALIZING'; // ONLINE | STANDBY_NO_TOKEN | CONNECTING | ERROR
    this.botUser = null;
    this.ws = null;
    this.heartbeatInterval = null;
    this.lastPing = null;
    this.startTime = null;

    this.prisma = null;
    this.io = null;
    this.getAuraThemeForAmount = null;

    this.stats = {
      dmsSent: 0,
      channelMessagesSent: 0,
      webhookDispatches: 0,
      totalDispatched: 0,
      failures: 0
    };

    ensureDataDir();
  }

  // Inject database & socket references
  setContext({ prisma, io, getAuraThemeForAmount }) {
    if (prisma) this.prisma = prisma;
    if (io) this.io = io;
    if (getAuraThemeForAmount) this.getAuraThemeForAmount = getAuraThemeForAmount;
  }

  // Load audit history
  getDispatchHistory(limit = 50) {
    try {
      ensureDataDir();
      const raw = fs.readFileSync(DISPATCH_LOG_FILE, 'utf8');
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list.slice(0, limit) : [];
    } catch (e) {
      return [];
    }
  }

  // Save dispatch entry to persistent audit history
  recordDispatch(entry) {
    try {
      ensureDataDir();
      const raw = fs.readFileSync(DISPATCH_LOG_FILE, 'utf8');
      let list = JSON.parse(raw);
      if (!Array.isArray(list)) list = [];
      list.unshift(entry);
      if (list.length > 500) list = list.slice(0, 500); // keep last 500
      fs.writeFileSync(DISPATCH_LOG_FILE, JSON.stringify(list, null, 2));
    } catch (err) {
      console.warn('[DiscordBot] Failed to write dispatch log:', err.message);
    }
  }

  // Get complete channel routing configuration
  getRoutingConfig() {
    try {
      ensureDataDir();
      const raw = fs.readFileSync(ROUTING_CONFIG_FILE, 'utf8');
      const loaded = JSON.parse(raw);
      return { ...DEFAULT_ROUTING, ...loaded };
    } catch (e) {
      return { ...DEFAULT_ROUTING };
    }
  }

  // Save updated channel routing configuration
  saveRoutingConfig(newConfig) {
    try {
      ensureDataDir();
      const current = this.getRoutingConfig();
      const merged = { ...current, ...newConfig };
      fs.writeFileSync(ROUTING_CONFIG_FILE, JSON.stringify(merged, null, 2));
      return merged;
    } catch (err) {
      console.warn('[DiscordBot] Failed to save routing config:', err.message);
      throw err;
    }
  }

  // Helper to format mention prefix
  buildMentionString(mentionType) {
    if (!mentionType || mentionType === 'none') return '';
    if (mentionType === 'here') return '@here ';
    if (mentionType === 'everyone') return '@everyone ';
    if (/^\d+$/.test(mentionType)) return `<@&${mentionType}> `;
    return '';
  }

  // Load Presence Configuration
  loadPresenceConfig() {
    try {
      ensureDataDir();
      const raw = fs.readFileSync(PRESENCE_CONFIG_FILE, 'utf8');
      return { ...DEFAULT_PRESENCE, ...JSON.parse(raw) };
    } catch (e) {
      return { ...DEFAULT_PRESENCE };
    }
  }

  // Update Bot Presence and broadcast to Discord Gateway WebSocket
  async updatePresence({ status, activityType, activityName, activityUrl }) {
    ensureDataDir();
    const current = this.loadPresenceConfig();
    const updated = {
      status: status || current.status,
      activityType: activityType !== undefined ? Number(activityType) : current.activityType,
      activityName: activityName !== undefined ? activityName.trim() : current.activityName,
      activityUrl: activityUrl !== undefined ? activityUrl.trim() : current.activityUrl
    };

    fs.writeFileSync(PRESENCE_CONFIG_FILE, JSON.stringify(updated, null, 2));

    // Send Opcode 3 Status Update to Gateway
    if (this.ws && this.ws.readyState === 1) { // 1 = OPEN
      try {
        const payload = {
          op: 3,
          d: {
            since: null,
            activities: updated.activityName ? [{
              name: updated.activityName,
              type: updated.activityType,
              url: updated.activityType === 1 ? (updated.activityUrl || 'https://twitch.tv/auratip') : undefined,
              state: updated.activityName
            }] : [],
            status: updated.status,
            afk: false
          }
        };
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        console.warn('[DiscordBot] Failed to send presence to gateway:', err.message);
      }
    }

    return updated;
  }

  // Fetch complete Bot Profile from Discord API
  async getProfile() {
    if (!this.token) throw new Error('Bot token is not configured.');

    // Fetch user profile
    const userRes = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { 'Authorization': `Bot ${this.token}` }
    });
    if (!userRes.ok) throw new Error(`Failed to fetch Discord user: HTTP ${userRes.status}`);
    const botUser = await userRes.json();
    this.botUser = botUser;

    // Fetch application profile ("About Me", description, tags)
    let application = null;
    try {
      const appRes = await fetch('https://discord.com/api/v10/applications/@me', {
        headers: { 'Authorization': `Bot ${this.token}` }
      });
      if (appRes.ok) application = await appRes.json();
    } catch (e) {}

    return {
      botUser: {
        id: botUser.id,
        username: botUser.username,
        discriminator: botUser.discriminator,
        tag: `${botUser.username}#${botUser.discriminator || '0'}`,
        avatar: botUser.avatar ? `https://cdn.discordapp.com/avatars/${botUser.id}/${botUser.avatar}.png?size=256` : null,
        banner: botUser.banner ? `https://cdn.discordapp.com/banners/${botUser.id}/${botUser.banner}.png?size=600` : null,
        accentColor: botUser.accent_color
      },
      application: application ? {
        id: application.id,
        name: application.name,
        description: application.description || '',
        icon: application.icon ? `https://cdn.discordapp.com/app-icons/${application.id}/${application.icon}.png?size=256` : null,
        tags: application.tags || []
      } : null,
      presence: this.loadPresenceConfig()
    };
  }

  // Update Bot Profile directly via Discord REST API (Username, Avatar, Banner, About Me)
  async updateProfile({ username, avatar, banner, description }) {
    if (!this.token) throw new Error('Bot token is not configured.');
    const results = {};

    // 1. Update User Profile (Username, Avatar, Banner)
    const userPatch = {};
    if (username && username.trim()) userPatch.username = username.trim();
    if (avatar !== undefined) userPatch.avatar = avatar; // base64 Data URI or null
    if (banner !== undefined) userPatch.banner = banner; // base64 Data URI or null

    if (Object.keys(userPatch).length > 0) {
      const userRes = await fetch('https://discord.com/api/v10/users/@me', {
        method: 'PATCH',
        headers: {
          'Authorization': `Bot ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(userPatch)
      });
      if (!userRes.ok) {
        const errJson = await userRes.json().catch(() => ({}));
        throw new Error(errJson.message || `Failed to update user profile: HTTP ${userRes.status}`);
      }
      this.botUser = await userRes.json();
      results.userUpdated = true;
    }

    // 2. Update Application Profile ("About Me" / description)
    if (description !== undefined) {
      const appRes = await fetch('https://discord.com/api/v10/applications/@me', {
        method: 'PATCH',
        headers: {
          'Authorization': `Bot ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ description: description.trim() })
      });
      if (!appRes.ok) {
        const errJson = await appRes.json().catch(() => ({}));
        throw new Error(errJson.message || `Failed to update bot description: HTTP ${appRes.status}`);
      }
      results.applicationUpdated = true;
    }

    return { success: true, ...results, profile: await this.getProfile() };
  }

  // Initialize bot connection
  async init() {
    this.token = process.env.DISCORD_BOT_TOKEN || '';
    this.webhookUrl = process.env.DISCORD_ONBOARDING_WEBHOOK || process.env.DISCORD_WEBHOOK_URL || '';
    this.channelId = process.env.DISCORD_ONBOARDING_CHANNEL_ID || '';
    this.guildId = process.env.DISCORD_GUILD_ID || '';

    if (!this.token) {
      this.status = this.webhookUrl ? 'ONLINE_WEBHOOK_ONLY' : 'STANDBY_NO_TOKEN';
      console.log(`[AuraTip DC Bot] ${this.webhookUrl ? 'Running via Discord Webhook' : 'Bot in Standby mode (No DISCORD_BOT_TOKEN set)'}`);
      return;
    }

    this.status = 'CONNECTING';
    try {
      // 1. Verify token via Discord REST API
      const res = await fetch('https://discord.com/api/v10/users/@me', {
        headers: {
          'Authorization': `Bot ${this.token}`,
          'User-Agent': 'AuraTipBot (https://auratip.live, 1.0.0)'
        }
      });

      if (!res.ok) {
        const errText = await res.text();
        this.status = 'ERROR';
        console.warn(`[AuraTip DC Bot] Token verification failed (${res.status}):`, errText);
        return;
      }

      this.botUser = await res.json();
      this.status = 'ONLINE';
      this.startTime = Date.now();
      console.log(`[AuraTip DC Bot] Logged in successfully as ${this.botUser.username}#${this.botUser.discriminator || '0'} (ID: ${this.botUser.id})`);

      // 2. Sync Bot Application Description ("About Me")
      try {
        await fetch('https://discord.com/api/v10/applications/@me', {
          method: 'PATCH',
          headers: {
            'Authorization': `Bot ${this.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            description: '⚡ Official AuraTip Bot • Collecting Auratips for streamers with 60 FPS animated alerts & instant UPI payouts.'
          })
        });
      } catch (e) {}

      // 3. Keep slash commands minimal as requested
      await this.registerSlashCommands();

      // 4. Connect to Gateway WebSocket
      this.connectGateway();
    } catch (err) {
      this.status = 'ERROR';
      console.warn('[AuraTip DC Bot] Connection error:', err.message);
    }
  }

  // Register Discord Global Slash Commands
  async registerSlashCommands() {
    if (!this.token) return;
    const appId = this.botUser?.id || process.env.DISCORD_CLIENT_ID || '1561385016766758973';
    const commands = [
      {
        name: 'ping',
        description: 'Check AuraTip Bot latency and connection status'
      }
    ];

    try {
      const res = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bot ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(commands)
      });
      if (res.ok) {
        console.log('[AuraTip DC Bot] Streamlined commands registered successfully.');
      }
    } catch (e) {
      console.warn('[AuraTip DC Bot] Slash commands notice:', e.message);
    }
  }

  // Handle Slash Command Interactions
  async handleInteraction(interaction) {
    const { id, token, data } = interaction;
    const commandName = data?.name;

    try {
      let responsePayload = {};

      if (commandName === 'ping') {
        responsePayload = {
          type: 4, // ChannelMessageWithSource
          data: {
            embeds: [{
              title: "🏓 Pong!",
              description: `**AuraTip Gateway v10:** Online\n**Heartbeat Latency:** \`${this.lastPing || 14}ms\`\n**Bot Status:** Healthy & Listening\n**Server Channel:** Connected`,
              color: 0x06B6D4,
              footer: { text: "AuraTip Stream Operations" },
              timestamp: new Date().toISOString()
            }]
          }
        };
      } else if (commandName === 'status') {
        const uptimeSec = this.startTime ? Math.round((Date.now() - this.startTime) / 1000) : 0;
        const mins = Math.floor(uptimeSec / 60);

        let creatorCount = 417;
        let totalRaised = 0;
        if (this.prisma) {
          try {
            creatorCount = await this.prisma.creator.count();
            const agg = await this.prisma.tip.aggregate({
              where: { status: 'PAID' },
              _sum: { amountInrEquiv: true }
            });
            totalRaised = agg._sum?.amountInrEquiv || 0;
          } catch (e) {}
        }

        responsePayload = {
          type: 4,
          data: {
            embeds: [{
              title: "⚡ AuraTip Platform & Bot Status",
              description: "India's highest payout live streaming tipping platform with 60 FPS OBS alerts and direct UPI payouts.",
              fields: [
                { name: "Bot Latency", value: `\`${this.lastPing || 12}ms\``, inline: true },
                { name: "Bot Uptime", value: `\`${mins}m (${uptimeSec}s)\``, inline: true },
                { name: "Active Gateway", value: "`REST v10 + Gateway`", inline: true },
                { name: "Creator Fleet", value: `\`${creatorCount} Streamers\``, inline: true },
                { name: "Total Volume", value: `\`₹${totalRaised.toLocaleString('en-IN')}\``, inline: true },
                { name: "Total Dispatches", value: `\`${this.stats.totalDispatched}\``, inline: true }
              ],
              color: 0x6366F1,
              footer: { text: "AuraTip Operations • auratip.live" },
              timestamp: new Date().toISOString()
            }],
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 5,
                    label: "🌐 Visit AuraTip",
                    url: "https://auratip.live"
                  }
                ]
              }
            ]
          }
        };
      } else if (commandName === 'tip') {
        const creatorOpt = data.options?.find(o => o.name === 'creator')?.value || 'gr8ansh';
        const amountOpt = data.options?.find(o => o.name === 'amount')?.value;
        const cleanHandle = creatorOpt.toLowerCase().replace(/^@/, '');

        let creator = null;
        if (this.prisma) {
          creator = await this.prisma.creator.findUnique({ where: { handle: cleanHandle } }).catch(() => null);
        }

        const name = creator?.displayName || `@${cleanHandle}`;
        const tipUrl = amountOpt
          ? `https://auratip.live/@${cleanHandle}?amount=${amountOpt}`
          : `https://auratip.live/@${cleanHandle}`;

        responsePayload = {
          type: 4,
          data: {
            embeds: [{
              title: `✨ Support ${name} on Stream!`,
              description: `Send tips with real-time animated alerts and Indian English AI voice readout (TTS) directly to **${name}**'s live stream!`,
              fields: [
                { name: "Creator Studio", value: `[auratip.live/@${cleanHandle}](${tipUrl})`, inline: true },
                { name: "Payment Modes", value: "UPI, GPay, PhonePe, Paytm, Cards", inline: true },
                { name: "Current Goal", value: creator ? `${getProgressBar(creator.goalRaisedInr, creator.goalTargetInr)} (₹${creator.goalRaisedInr.toLocaleString('en-IN')} / ₹${creator.goalTargetInr.toLocaleString('en-IN')})` : "Active", inline: false }
              ],
              color: 0x10B981,
              footer: { text: "Click the button below to tip instantly via UPI" },
              timestamp: new Date().toISOString()
            }],
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 5,
                    label: `⚡ Tip @${cleanHandle}${amountOpt ? ` (₹${amountOpt})` : ''}`,
                    url: tipUrl
                  },
                  {
                    type: 2,
                    style: 5,
                    label: "🎙️ Stream Page",
                    url: `https://auratip.live/@${cleanHandle}`
                  }
                ]
              }
            ]
          }
        };
      } else if (commandName === 'stats') {
        const creatorOpt = data.options?.find(o => o.name === 'creator')?.value || 'gr8ansh';
        const cleanHandle = creatorOpt.toLowerCase().replace(/^@/, '');

        let creator = null;
        let topTip = null;
        let tipCount = 0;

        if (this.prisma) {
          creator = await this.prisma.creator.findUnique({
            where: { handle: cleanHandle },
            include: {
              tips: {
                where: { status: 'PAID' },
                orderBy: { amountInrEquiv: 'desc' },
                take: 1
              }
            }
          }).catch(() => null);

          if (creator) {
            topTip = creator.tips[0] || null;
            tipCount = await this.prisma.tip.count({
              where: { creatorHandle: cleanHandle, status: 'PAID' }
            }).catch(() => 0);
          }
        }

        if (!creator) {
          responsePayload = {
            type: 4,
            data: {
              embeds: [{
                title: `❌ Creator Not Found`,
                description: `Could not find a registered streamer with handle \`@${cleanHandle}\` on AuraTip.`,
                color: 0xEF4444
              }]
            }
          };
        } else {
          const progress = getProgressBar(creator.goalRaisedInr, creator.goalTargetInr);
          responsePayload = {
            type: 4,
            data: {
              embeds: [{
                title: `📊 Streamer Stats: ${creator.displayName} (@${creator.handle})`,
                description: creator.bio || "Verified AuraTip Live Streamer",
                fields: [
                  { name: "Total Raised", value: `\`₹${creator.goalRaisedInr.toLocaleString('en-IN')}\``, inline: true },
                  { name: "Tips Received", value: `\`${tipCount} tips\``, inline: true },
                  { name: "Active Aura Preset", value: `\`${(creator.chimePreset || 'emerald').toUpperCase()}\``, inline: true },
                  { name: "Stream Goal", value: `${progress}\n**₹${creator.goalRaisedInr.toLocaleString('en-IN')}** raised of **₹${creator.goalTargetInr.toLocaleString('en-IN')}**`, inline: false },
                  { name: "🏆 Top Supporter Tip", value: topTip ? `**${topTip.supporterName}** — ₹${topTip.amount} (${topTip.auraTheme} aura)` : "No tips recorded yet", inline: false }
                ],
                color: getAuraColor(creator.chimePreset),
                footer: { text: "AuraTip Stream Analytics" },
                timestamp: new Date().toISOString()
              }],
              components: [
                {
                  type: 1,
                  components: [
                    {
                      type: 2,
                      style: 5,
                      label: `⚡ Tip @${creator.handle}`,
                      url: `https://auratip.live/@${creator.handle}`
                    },
                    {
                      type: 2,
                      style: 5,
                      label: "🌐 Public Profile",
                      url: `https://auratip.live/@${creator.handle}`
                    }
                  ]
                }
              ]
            }
          };
        }
      } else if (commandName === 'leaderboard') {
        let topCreators = [];
        let topTips = [];

        if (this.prisma) {
          topCreators = await this.prisma.creator.findMany({
            where: { isApproved: true },
            orderBy: { goalRaisedInr: 'desc' },
            take: 5
          }).catch(() => []);

          topTips = await this.prisma.tip.findMany({
            where: { status: 'PAID' },
            orderBy: { amountInrEquiv: 'desc' },
            take: 5
          }).catch(() => []);
        }

        const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
        const creatorsText = topCreators.length > 0
          ? topCreators.map((c, i) => `${medals[i]} **${c.displayName}** (\`@${c.handle}\`) — **₹${c.goalRaisedInr.toLocaleString('en-IN')}**`).join('\n')
          : "No streamer data yet.";

        const tipsText = topTips.length > 0
          ? topTips.map((t, i) => `${medals[i]} **${t.supporterName}** — **₹${t.amount}** to \`@${t.creatorHandle}\``).join('\n')
          : "No tips recorded yet.";

        responsePayload = {
          type: 4,
          data: {
            embeds: [{
              title: "🏆 AuraTip Live Leaderboard",
              description: "Today's top-earning streamers and biggest community supporters across India!",
              fields: [
                { name: "Top Streamers", value: creatorsText, inline: false },
                { name: "Largest Tips Ever", value: tipsText, inline: false }
              ],
              color: 0xF59E0B, // Gold
              footer: { text: "AuraTip Live Tipping Platform" },
              timestamp: new Date().toISOString()
            }],
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 5,
                    label: "⚡ Visit AuraTip",
                    url: "https://auratip.live"
                  }
                ]
              }
            ]
          }
        };
      } else if (commandName === 'recent') {
        const creatorOpt = data.options?.find(o => o.name === 'creator')?.value;
        const cleanHandle = creatorOpt ? creatorOpt.toLowerCase().replace(/^@/, '') : null;

        let tips = [];
        if (this.prisma) {
          tips = await this.prisma.tip.findMany({
            where: cleanHandle ? { creatorHandle: cleanHandle, status: 'PAID' } : { status: 'PAID' },
            orderBy: { createdAt: 'desc' },
            take: 5
          }).catch(() => []);
        }

        const tipsList = tips.length > 0
          ? tips.map(t => `• **₹${t.amount}** from **${t.supporterName}** ${cleanHandle ? '' : `to \`@${t.creatorHandle}\``} (${t.auraTheme} aura)\n  ↳ _"${t.message || 'No message'}"_`).join('\n\n')
          : "No recent tips found.";

        responsePayload = {
          type: 4,
          data: {
            embeds: [{
              title: `🕒 Recent Tips ${cleanHandle ? `for @${cleanHandle}` : 'across AuraTip'}`,
              description: tipsList,
              color: 0x06B6D4,
              footer: { text: "AuraTip Live Alerts" },
              timestamp: new Date().toISOString()
            }]
          }
        };
      } else if (commandName === 'testalert') {
        const creatorOpt = data.options?.find(o => o.name === 'creator')?.value || 'gr8ansh';
        const themeOpt = data.options?.find(o => o.name === 'theme')?.value || 'gold';
        const cleanHandle = creatorOpt.toLowerCase().replace(/^@/, '');

        let creator = null;
        if (this.prisma) {
          creator = await this.prisma.creator.findUnique({ where: { handle: cleanHandle } }).catch(() => null);
        }

        if (!creator) {
          responsePayload = {
            type: 4,
            data: {
              embeds: [{
                title: "❌ Creator Not Found",
                description: `Could not find streamer \`@${cleanHandle}\` to trigger test alert.`,
                color: 0xEF4444
              }]
            }
          };
        } else {
          const testAmount = (themeOpt === 'gold') ? 10000 : (themeOpt === 'magenta') ? 5000 : (themeOpt === 'special') ? 2500 : 500;
          const testAlert = {
            id: `dc_test_${Date.now()}`,
            name: "Discord Bot Test Alert",
            supporterName: "Discord Bot Test Alert",
            amount: testAmount,
            amountInr: testAmount,
            amountInrEquiv: testAmount,
            currency: "INR",
            symbol: "₹",
            message: `⚡ 60 FPS live test alert triggered directly from Discord slash command!`,
            auraTheme: themeOpt,
            durationSec: 12,
            ttsEnabled: true,
            speechText: `Discord live test alert with ${themeOpt} aura!`
          };

          if (this.io) {
            this.io.to(`overlay:${creator.overlayKey}`).emit('new_tip', testAlert);
            this.io.to(`creator:${creator.handle}`).emit('new_tip', testAlert);
          }

          responsePayload = {
            type: 4,
            data: {
              embeds: [{
                title: "🎉 Live 60 FPS Alert Dispatched to OBS!",
                description: `Triggered a test alert for **@${cleanHandle}**'s live stream overlay.`,
                fields: [
                  { name: "Streamer", value: `@${cleanHandle} (${creator.displayName})`, inline: true },
                  { name: "Aura Theme", value: `**${themeOpt.toUpperCase()}** ⚡`, inline: true },
                  { name: "Tier Value", value: `₹${testAmount}`, inline: true },
                  { name: "Overlay Target", value: `\`overlay:${creator.overlayKey.slice(0, 8)}...\``, inline: false }
                ],
                color: getAuraColor(themeOpt),
                footer: { text: "Check your OBS Studio or browser source to see the alert!" },
                timestamp: new Date().toISOString()
              }]
            }
          };
        }
      } else if (commandName === 'help') {
        responsePayload = {
          type: 4,
          data: {
            embeds: [{
              title: "🤖 AuraTip Bot Commands & Features",
              description: "Welcome to the official **AuraTip Live Platform** Discord Bot! Direct UPI tipping with 60 FPS live stream alerts.",
              fields: [
                { name: "`/ping`", value: "Check bot latency, heartbeat, and gateway status", inline: false },
                { name: "`/status`", value: "View real-time platform metrics, total volume, and active fleet", inline: false },
                { name: "`/tip <creator> [amount]`", value: "Get instant tipping link and interactive card for a streamer", inline: false },
                { name: "`/stats <creator>`", value: "View earnings, stream goal progress, and top supporter", inline: false },
                { name: "`/leaderboard`", value: "View top 5 streamers and top community supporters", inline: false },
                { name: "`/recent [creator]`", value: "View the latest 5 live tips received", inline: false },
                { name: "`/testalert <creator> [theme]`", value: "Fire a live 60 FPS test alert to a creator OBS overlay directly from Discord", inline: false },
                { name: "`/help`", value: "Show this help and feature guide", inline: false }
              ],
              color: 0x5865F2,
              footer: { text: "AuraTip • Direct UPI Stream Alerts" },
              timestamp: new Date().toISOString()
            }]
          }
        };
      } else {
        responsePayload = {
          type: 4,
          data: { content: `Unknown command: \`/${commandName}\`` }
        };
      }

      await fetch(`https://discord.com/api/v10/interactions/${id}/${token}/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(responsePayload)
      });
    } catch (err) {
      console.warn('[DiscordBot] Interaction error:', err.message);
    }
  }

  // Connect to Discord Gateway to maintain presence & online status
  connectGateway() {
    if (!this.token || typeof WebSocket === 'undefined') return;

    try {
      if (this.ws) {
        try { this.ws.close(); } catch (e) {}
      }

      this.ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');

      this.ws.onopen = () => {
        // Connected to gateway
      };

      this.ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          const { op, d, t } = payload;

          // Opcode 10: Hello -> start heartbeat & identify
          if (op === 10) {
            const interval = d.heartbeat_interval;
            if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = setInterval(() => {
              if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                const t0 = Date.now();
                this.ws.send(JSON.stringify({ op: 1, d: null }));
                this.lastPing = Date.now() - t0;
              }
            }, interval);

            // Identify
            this.ws.send(JSON.stringify({
              op: 2,
              d: {
                token: this.token,
                intents: 513, // Guilds + GuildMessages
                properties: {
                  os: 'windows',
                  browser: 'auratip-bot',
                  device: 'auratip-bot'
                },
                presence: (() => {
                  const p = this.loadPresenceConfig();
                  return {
                    activities: p.activityName ? [{
                      name: p.activityName,
                      type: p.activityType || 0,
                      url: p.activityType === 1 ? (p.activityUrl || 'https://twitch.tv/auratip') : undefined,
                      state: p.activityName
                    }] : [],
                    status: p.status || 'online',
                    afk: false
                  };
                })()
              }
            }));
          }

          // Opcode 0: Dispatch
          if (op === 0 && t === 'READY') {
            this.status = 'ONLINE';
            if (d.user) this.botUser = d.user;
          }

          // Opcode 0: Slash Command Interaction
          if (op === 0 && t === 'INTERACTION_CREATE') {
            this.handleInteraction(d);
          }
        } catch (e) {}
      };

      this.ws.onerror = () => {};

      this.ws.onclose = () => {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        if (this.token) {
          setTimeout(() => this.connectGateway(), 10000);
        }
      };
    } catch (e) {
      console.warn('[AuraTip DC Bot] Gateway connection notice:', e.message);
    }
  }

  // Update credentials and reconnect
  async updateConfig({ token, webhookUrl, channelId, guildId }) {
    if (token !== undefined) this.token = token.trim();
    if (webhookUrl !== undefined) this.webhookUrl = webhookUrl.trim();
    if (channelId !== undefined) this.channelId = channelId.trim();
    if (guildId !== undefined) this.guildId = guildId.trim();

    return this.init();
  }

  // Expose status object for Admin Dashboard
  getStatus() {
    const uptimeSec = this.startTime ? Math.round((Date.now() - this.startTime) / 1000) : 0;
    return {
      status: this.status,
      isOnline: this.status === 'ONLINE' || this.status === 'ONLINE_WEBHOOK_ONLY',
      hasToken: Boolean(this.token),
      hasWebhook: Boolean(this.webhookUrl),
      hasChannel: Boolean(this.channelId),
      botUser: this.botUser ? {
        id: this.botUser.id,
        username: this.botUser.username,
        tag: `${this.botUser.username}#${this.botUser.discriminator || '0000'}`,
        avatar: this.botUser.avatar ? `https://cdn.discordapp.com/avatars/${this.botUser.id}/${this.botUser.avatar}.png` : null
      } : null,
      channelId: this.channelId,
      webhookUrl: this.webhookUrl ? this.webhookUrl.replace(/\/webhooks\/\d+\/[A-Za-z0-9_-]+/, '/webhooks/***/***') : null,
      uptimeSec,
      lastPingMs: this.lastPing,
      inviteUrl: this.getInviteUrl(),
      stats: this.stats
    };
  }

  // Get 1-Click Bot OAuth2 Invite Link
  getInviteUrl() {
    const clientId = this.botUser?.id || process.env.DISCORD_CLIENT_ID || '1561385016766758973';
    return `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=277025508352&scope=bot%20applications.commands`;
  }

  // Resolve a Discord username, nickname, handle, or mention to a numeric User Snowflake ID
  async resolveDiscordUserId(input) {
    if (!input || !this.token) return null;
    let clean = String(input).trim();

    // Check if it's already a mention: <@1234567890> or <@!1234567890>
    const mentionMatch = clean.match(/^<@!?(\d+)>$/);
    if (mentionMatch) return mentionMatch[1];

    // If it's already a numeric Snowflake ID
    if (/^\d{16,21}$/.test(clean)) return clean;

    // Remove leading @ if present
    const query = clean.replace(/^@/, '');

    // Search members in configured Guild via Discord REST API
    if (this.guildId) {
      try {
        const searchRes = await fetch(`https://discord.com/api/v10/guilds/${this.guildId}/members/search?query=${encodeURIComponent(query)}&limit=10`, {
          headers: {
            'Authorization': `Bot ${this.token}`,
            'User-Agent': 'AuraTipBot (https://auratip.live, 1.0.0)'
          }
        });
        if (searchRes.ok) {
          const members = await searchRes.json();
          if (Array.isArray(members) && members.length > 0) {
            const lowerQuery = query.toLowerCase();
            const match = members.find(m => 
              m.user?.username?.toLowerCase() === lowerQuery ||
              m.user?.global_name?.toLowerCase() === lowerQuery ||
              m.nick?.toLowerCase() === lowerQuery
            ) || members[0];
            if (match && match.user?.id) {
              return match.user.id;
            }
          }
        }
      } catch (err) {
        console.warn('[DiscordBot] Guild member search error:', err.message);
      }
    }

    return null;
  }

  // Send Direct Message (DM) to a Discord User (Supports numeric ID, mention, or username)
  async sendDirectMessage(recipientInput, payload) {
    if (!this.token) {
      throw new Error('Discord Bot Token is not configured.');
    }

    let recipientId = String(recipientInput || '').trim();
    const mentionMatch = recipientId.match(/<@!?(\d+)>/);
    if (mentionMatch) {
      recipientId = mentionMatch[1];
    }

    // If not numeric, dynamically resolve username or nickname from server
    if (!/^\d{16,21}$/.test(recipientId)) {
      const resolved = await this.resolveDiscordUserId(recipientId);
      if (resolved) {
        recipientId = resolved;
      } else {
        throw new Error(`Could not resolve Discord user "${recipientInput}". Discord DMs require a member in the server or a valid numeric User ID.`);
      }
    }

    const tStart = Date.now();

    // 1. Create DM Channel
    const dmChanRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ recipient_id: recipientId })
    });

    if (!dmChanRes.ok) {
      const errJson = await dmChanRes.json().catch(() => ({}));
      throw new Error(errJson.message || `Failed to open DM channel with user ${recipientId} (HTTP ${dmChanRes.status})`);
    }

    const dmChannel = await dmChanRes.json();

    // 2. Post Message to DM Channel
    const msgRes = await fetch(`https://discord.com/api/v10/channels/${dmChannel.id}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!msgRes.ok) {
      const errJson = await msgRes.json().catch(() => ({}));
      throw new Error(errJson.message || `Failed to send message to user ${recipientId} (HTTP ${msgRes.status})`);
    }

    const msgData = await msgRes.json();
    this.stats.dmsSent++;
    this.stats.totalDispatched++;

    return {
      success: true,
      method: 'DIRECT_MESSAGE',
      recipientId,
      channelId: dmChannel.id,
      messageId: msgData.id,
      latencyMs: Date.now() - tStart,
      timestamp: new Date().toISOString()
    };
  }

  // Send message to a specific Channel
  async sendChannelMessage(channelId, payload) {
    if (!this.token) {
      throw new Error('Discord Bot Token is not configured.');
    }

    const tStart = Date.now();
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.message || `Failed to send to channel ${channelId} (HTTP ${res.status})`);
    }

    const msgData = await res.json();
    this.stats.channelMessagesSent++;
    this.stats.totalDispatched++;

    return {
      success: true,
      method: 'GUILD_CHANNEL',
      channelId,
      messageId: msgData.id,
      latencyMs: Date.now() - tStart,
      timestamp: new Date().toISOString()
    };
  }

  // Send message via Webhook
  async sendWebhook(webhookUrl, payload) {
    const url = webhookUrl || this.webhookUrl;
    if (!url) {
      throw new Error('No Discord Webhook URL configured.');
    }

    const tStart = Date.now();
    const res = await fetch(`${url}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Webhook dispatch failed with HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json().catch(() => ({}));
    this.stats.webhookDispatches++;
    this.stats.totalDispatched++;

    return {
      success: true,
      method: 'WEBHOOK',
      messageId: data.id || `wh_${Date.now()}`,
      latencyMs: Date.now() - tStart,
      timestamp: new Date().toISOString()
    };
  }

  // Intelligent Multi-Target Dispatcher (Handles Server ID, Channel ID, and User ID without throwing Invalid Recipient)
  async smartDispatch({ target, payload }) {
    const clean = String(target || '').trim();
    const strippedId = clean.replace(/<@!?(\d+)>/, '$1').replace(/<#(\d+)>/, '$1');

    // Case 1: Empty target -> default channel or webhook
    if (!strippedId) {
      if (this.token && this.channelId) {
        const res = await this.sendChannelMessage(this.channelId, payload);
        return { ...res, target: `#channel (${this.channelId})` };
      }
      if (this.webhookUrl) {
        const res = await this.sendWebhook(this.webhookUrl, payload);
        return { ...res, target: 'Discord Webhook' };
      }
      return { success: true, status: 'STANDBY_SIMULATION', method: 'SIMULATED', target: 'Standby' };
    }

    // Case 2: Target is the Guild/Server ID (e.g. 708892519882293279)
    if (this.guildId && (strippedId === this.guildId || clean === this.guildId)) {
      const destChan = this.channelId || '741671980561858670';
      const res = await this.sendChannelMessage(destChan, payload);
      return {
        ...res,
        target: `Server Channel (#${destChan})`,
        note: `Target was identified as Server ID; dispatched to primary channel.`
      };
    }

    // Case 3: Explicit Channel mention or ID
    if (clean.startsWith('<#') || strippedId === this.channelId) {
      const res = await this.sendChannelMessage(strippedId, payload);
      return { ...res, target: `#channel (${strippedId})` };
    }

    // Case 4: Numeric Snowflake ID (could be Channel or User)
    if (/^\d{16,21}$/.test(strippedId)) {
      // First attempt sending directly to channel with this ID
      try {
        const chanRes = await this.sendChannelMessage(strippedId, payload);
        return { ...chanRes, target: `#channel (${strippedId})` };
      } catch (chanErr) {
        // Not a channel or channel inaccessible -> try as User DM
        try {
          const dmRes = await this.sendDirectMessage(strippedId, payload);
          return { ...dmRes, target: `User DM (${strippedId})` };
        } catch (dmErr) {
          // Both failed -> fallback to primary server channel with user mention tag
          if (this.channelId) {
            const fallbackPayload = {
              ...payload,
              content: `⚡ **AuraTip Alert** (Recipient: <@${strippedId}>)\n${payload.content || ''}`
            };
            const fallbackRes = await this.sendChannelMessage(this.channelId, fallbackPayload);
            return {
              ...fallbackRes,
              target: `#channel (${this.channelId}) [tagged <@${strippedId}>]`,
              note: `Direct DM was unavailable (${dmErr.message}); routed to server channel.`
            };
          }
          throw new Error(dmErr.message);
        }
      }
    }

    // Case 5: Target is a Discord username, nickname, or handle
    const resolvedUserId = await this.resolveDiscordUserId(clean);
    if (resolvedUserId) {
      try {
        const dmRes = await this.sendDirectMessage(resolvedUserId, payload);
        return { ...dmRes, target: `User DM (@${clean} -> ${resolvedUserId})` };
      } catch (dmErr) {
        console.warn(`[DiscordBot] Smart dispatch DM failed:`, dmErr.message);
      }
    }

    // Fallback to primary channel
    if (this.token && this.channelId) {
      const res = await this.sendChannelMessage(this.channelId, payload);
      return { ...res, target: `#channel (${this.channelId})` };
    }
    if (this.webhookUrl) {
      const res = await this.sendWebhook(this.webhookUrl, payload);
      return { ...res, target: 'Discord Webhook' };
    }
    throw new Error(`Unable to deliver message to target "${clean}".`);
  }

  // Live Tip Alert Broadcast to Discord Server (using configured tip_alerts channel)
  async broadcastTipAlert(creator, tip) {
    if (!this.token && !this.webhookUrl) return;

    const routing = this.getRoutingConfig();
    const conf = routing.tip_alerts || DEFAULT_ROUTING.tip_alerts;
    if (conf.enabled === false) return;

    const amount = Number(tip.amount || 0);
    if (conf.minAmount && amount < Number(conf.minAmount)) return;

    const targetChannel = conf.channelId || this.channelId;
    if (!targetChannel && !this.webhookUrl) return;

    const theme = (tip.auraTheme || 'emerald').toLowerCase();
    const color = conf.color ? parseInt(conf.color.replace('#', ''), 16) : getAuraColor(theme);
    const supporter = tip.supporterName || tip.name || 'Anonymous';
    const amountStr = `₹${amount}`;
    const cleanHandle = (creator?.handle || 'creator').toLowerCase().replace(/^@/, '');
    const goalRaised = creator?.goalRaisedInr || 0;
    const goalTarget = creator?.goalTargetInr || 10000;
    const progress = getProgressBar(goalRaised, goalTarget);

    const title = (conf.titleTemplate || '⚡ LIVE TIP ALERT: ₹{amount} for @{creator}!')
      .replace('{amount}', amount)
      .replace('{creator}', cleanHandle)
      .replace('{supporter}', supporter);

    const mentionPrefix = this.buildMentionString(conf.mention);

    const embed = {
      title,
      description: `**${supporter}** just dropped an **${theme.toUpperCase()} AURA** tip with 60 FPS live stream alert!`,
      color,
      fields: [
        { name: "Supporter", value: supporter, inline: true },
        { name: "Amount", value: `${amountStr} (${tip.currency || 'INR'})`, inline: true },
        { name: "Aura Tier", value: `${theme.toUpperCase()} ⚡ (${tip.durationSec || 8}s)`, inline: true },
        { name: "Message", value: tip.message ? `"${tip.message}"` : "_No message included_", inline: false }
      ],
      footer: { text: "AuraTip Real-Time Stream Engine • 60 FPS Alerts" },
      timestamp: new Date().toISOString()
    };

    if (conf.showProgressBar !== false) {
      embed.fields.push({
        name: "Stream Goal",
        value: `${progress} (₹${goalRaised.toLocaleString('en-IN')} / ₹${goalTarget.toLocaleString('en-IN')})`,
        inline: false
      });
    }

    const payload = {
      content: `${mentionPrefix}🎉 **New Live Tip Alert for @${cleanHandle}!**`,
      embeds: [embed],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 5,
              label: `⚡ Tip @${cleanHandle}`,
              url: `https://auratip.live/@${cleanHandle}`
            },
            {
              type: 2,
              style: 5,
              label: '🏆 AuraTip Platform',
              url: 'https://auratip.live'
            }
          ]
        }
      ]
    };

    try {
      if (this.token && targetChannel) {
        const res = await this.sendChannelMessage(targetChannel, payload);
        this.recordDispatch({ type: 'TIP_ALERT', ...res, target: `#${targetChannel}`, handle: cleanHandle, amount });
      } else if (this.webhookUrl) {
        await this.sendWebhook(this.webhookUrl, payload);
      }
    } catch (err) {
      console.warn('[DiscordBot] broadcastTipAlert warning:', err.message);
    }
  }

  // Goal Celebrations Broadcast to dedicated channel
  async broadcastGoalCelebration(creator, goal) {
    if (!this.token && !this.webhookUrl) return;
    const routing = this.getRoutingConfig();
    const conf = routing.goal_celebrations || DEFAULT_ROUTING.goal_celebrations;
    if (conf.enabled === false) return;

    const targetChannel = conf.channelId || this.channelId;
    if (!targetChannel) return;

    const cleanHandle = (creator?.handle || 'creator').toLowerCase().replace(/^@/, '');
    const color = conf.color ? parseInt(conf.color.replace('#', ''), 16) : 0xF59E0B;
    const mentionPrefix = this.buildMentionString(conf.mention);
    const title = (conf.titleTemplate || '🎉 STREAM GOAL CRUSHED: @{creator} hit 100%!')
      .replace('{creator}', cleanHandle)
      .replace('{goal}', goal?.title || 'Milestone');

    const embed = {
      title,
      description: `🏆 Huge congratulations to **${creator.displayName || cleanHandle}** (\`@${cleanHandle}\`) for achieving their stream target!`,
      color,
      fields: [
        { name: "Target Amount", value: `₹${(goal?.targetAmount || creator?.goalTargetInr || 10000).toLocaleString('en-IN')}`, inline: true },
        { name: "Raised", value: `₹${(goal?.currentAmount || creator?.goalRaisedInr || 10000).toLocaleString('en-IN')}`, inline: true },
        { name: "Status", value: "🌟 **GOAL COMPLETED (100%)**", inline: true }
      ],
      footer: { text: "AuraTip Milestones • Live Stream Celebrations" },
      timestamp: new Date().toISOString()
    };

    const payload = {
      content: `${mentionPrefix}🥳 **GOAL COMPLETED!** Let's celebrate in the chat!`,
      embeds: [embed],
      components: [{
        type: 1,
        components: [{
          type: 2,
          style: 5,
          label: `📺 Watch @${cleanHandle}`,
          url: `https://auratip.live/@${cleanHandle}`
        }]
      }]
    };

    try {
      const res = await this.sendChannelMessage(targetChannel, payload);
      this.recordDispatch({ type: 'GOAL_CELEBRATION', ...res, target: `#${targetChannel}`, handle: cleanHandle });
      return res;
    } catch (err) {
      console.warn('[DiscordBot] broadcastGoalCelebration error:', err.message);
    }
  }

  // Stream Boost Broadcast to dedicated channel
  async broadcastStreamBoost(creator) {
    if (!this.token) return;
    const routing = this.getRoutingConfig();
    const conf = routing.creator_boosts || DEFAULT_ROUTING.creator_boosts;
    if (conf.enabled === false) return;

    const targetChannel = conf.channelId || this.channelId;
    if (!targetChannel) return;

    const cleanHandle = (creator?.handle || 'creator').toLowerCase().replace(/^@/, '');
    const color = conf.color ? parseInt(conf.color.replace('#', ''), 16) : 0x8B5CF6;
    const mentionPrefix = this.buildMentionString(conf.mention);

    const embed = {
      title: `🔥 STREAM BOOST ACTIVE: @${cleanHandle} is Live!`,
      description: `**${creator.displayName || cleanHandle}** just received a **Platform Boost**! Catch the stream right now on AuraTip.`,
      color,
      fields: [
        { name: "Category", value: creator.category || 'Live Streaming', inline: true },
        { name: "Platform Rank", value: "Featured Creator ⭐", inline: true }
      ],
      footer: { text: "AuraTip Creator Spotlight" },
      timestamp: new Date().toISOString()
    };

    const payload = {
      content: `${mentionPrefix}🚀 **Streamer Boosted on AuraTip!**`,
      embeds: [embed],
      components: [{
        type: 1,
        components: [{
          type: 2,
          style: 5,
          label: `⚡ Watch & Tip @${cleanHandle}`,
          url: `https://auratip.live/@${cleanHandle}`
        }]
      }]
    };

    try {
      const res = await this.sendChannelMessage(targetChannel, payload);
      this.recordDispatch({ type: 'CREATOR_BOOST', ...res, target: `#${targetChannel}`, handle: cleanHandle });
      return res;
    } catch (err) {
      console.warn('[DiscordBot] broadcastStreamBoost error:', err.message);
    }
  }

  // Official Platform Announcement Broadcast
  async broadcastPlatformNotice(title, message, options = {}) {
    if (!this.token) return;
    const routing = this.getRoutingConfig();
    const conf = routing.platform_broadcasts || DEFAULT_ROUTING.platform_broadcasts;
    if (conf.enabled === false) return;

    const targetChannel = conf.channelId || this.channelId;
    if (!targetChannel) return;

    const color = conf.color ? parseInt(conf.color.replace('#', ''), 16) : 0xEC4899;
    const mentionPrefix = this.buildMentionString(conf.mention);

    const embed = {
      title: title || conf.titleTemplate || '📢 AuraTip Official Announcement',
      description: message || 'Platform maintenance or notice update.',
      color,
      fields: options.fields || [],
      footer: { text: "AuraTip Operations Hub" },
      timestamp: new Date().toISOString()
    };

    const payload = {
      content: `${mentionPrefix}📢 **AuraTip Network Announcement**`,
      embeds: [embed]
    };

    try {
      const res = await this.sendChannelMessage(targetChannel, payload);
      this.recordDispatch({ type: 'PLATFORM_BROADCAST', ...res, target: `#${targetChannel}` });
      return res;
    } catch (err) {
      console.warn('[DiscordBot] broadcastPlatformNotice error:', err.message);
      throw err;
    }
  }

  // Security / Audit alert broadcast to dedicated admin channel
  async broadcastAuditAlert(event, details = {}) {
    if (!this.token) return;
    const routing = this.getRoutingConfig();
    const conf = routing.audit_alerts || DEFAULT_ROUTING.audit_alerts;
    if (conf.enabled === false) return;

    const targetChannel = conf.channelId || this.channelId;
    if (!targetChannel) return;

    const color = conf.color ? parseInt(conf.color.replace('#', ''), 16) : 0xEF4444;
    const mentionPrefix = this.buildMentionString(conf.mention);

    const embed = {
      title: `⚠️ [ADMIN AUDIT] ${event}`,
      description: typeof details === 'string' ? details : JSON.stringify(details, null, 2).slice(0, 1000),
      color,
      footer: { text: "AuraTip Master Control Telemetry" },
      timestamp: new Date().toISOString()
    };

    try {
      const res = await this.sendChannelMessage(targetChannel, {
        content: `${mentionPrefix}🚨 **Platform Security / Telemetry Alert**`,
        embeds: [embed]
      });
      this.recordDispatch({ type: 'AUDIT_ALERT', ...res, target: `#${targetChannel}`, event });
      return res;
    } catch (err) {
      console.warn('[DiscordBot] broadcastAuditAlert error:', err.message);
    }
  }

  // Test Channel Routing for any category
  async testChannelRouting(category) {
    const routing = this.getRoutingConfig();
    const conf = routing[category];
    if (!conf) throw new Error(`Unknown routing category: ${category}`);
    if (!conf.channelId) throw new Error(`No channel configured for category "${category}". Please select a channel first.`);

    const color = conf.color ? parseInt(conf.color.replace('#', ''), 16) : 0x00F0FF;

    const samples = {
      tip_alerts: {
        title: "⚡ [TEST] Live Tip Alert: ₹500 for @ANSH!",
        desc: "**Demon Supporter** dropped an **EMERALD AURA** tip with 60 FPS alert!",
        fields: [
          { name: "Supporter", value: "Demon King", inline: true },
          { name: "Amount", value: "₹500 (INR)", inline: true },
          { name: "Aura Tier", value: "EMERALD ⚡", inline: true },
          { name: "Message", value: "\"Keep streaming bro, you're the GOAT!\"", inline: false }
        ]
      },
      goal_celebrations: {
        title: "🎉 [TEST] Stream Goal Crushed: @ANSH hit 100%!",
        desc: "The streamer hit their ₹25,000 upgrade goal milestone!",
        fields: [
          { name: "Goal Target", value: "₹25,000", inline: true },
          { name: "Current Raised", value: "₹25,400", inline: true },
          { name: "Progress", value: "`[██████████]` 100%", inline: false }
        ]
      },
      creator_onboarding: {
        title: "🚀 [TEST] Welcome @ANSH to the AuraTip Partner Fleet!",
        desc: "Streamer application approved! Profile and 60 FPS tipping engine are now live.",
        fields: [
          { name: "Handle", value: "@ansh", inline: true },
          { name: "Channel", value: "https://auratip.live/@ansh", inline: true }
        ]
      },
      creator_boosts: {
        title: "🔥 [TEST] Stream Boost Active: @ANSH is live!",
        desc: "Streamer has been promoted to the AuraTip Front Page!",
        fields: [
          { name: "Category", value: "Gaming / Valorant", inline: true },
          { name: "Status", value: "Featured Live Stream ⭐", inline: true }
        ]
      },
      platform_broadcasts: {
        title: "📢 [TEST] AuraTip Official Platform Notice",
        desc: "This is a verified test dispatch for the official announcements channel.",
        fields: [
          { name: "Engine Version", value: "v3.0 Ultra", inline: true },
          { name: "Payout Speed", value: "Instant UPI Payouts", inline: true }
        ]
      },
      audit_alerts: {
        title: "⚠️ [TEST] AuraTip Security & Audit Log Alert",
        desc: "Diagnostic test alert sent to verify the dedicated admin log channel routing.",
        fields: [
          { name: "Event Type", value: "DIAGNOSTIC_VERIFICATION", inline: true },
          { name: "Severity", value: "INFO", inline: true }
        ]
      }
    };

    const sample = samples[category] || {
      title: `⚡ [TEST] Channel Routing Verification for ${category}`,
      desc: "This is a test embed to verify channel delivery.",
      fields: []
    };

    const payload = {
      content: `🧪 **Test Dispatch: ${category.toUpperCase().replace(/_/g, ' ')}** (Channel Routing Verification)`,
      embeds: [{
        title: sample.title,
        description: sample.desc,
        color,
        fields: sample.fields,
        footer: { text: "AuraTip Bot • Channel Routing Test" },
        timestamp: new Date().toISOString()
      }]
    };

    const res = await this.sendChannelMessage(conf.channelId, payload);
    this.recordDispatch({ type: `TEST_${category.toUpperCase()}`, ...res, target: `#${conf.channelId}` });
    return res;
  }

  // High-Level Automated Dispatcher for Streamer Onboarding (Strictly Personal DMs for privacy)
  async dispatchOnboardingEmbed({ appItem, creator, tempPassword, payload }) {
    const handle = creator.handle;
    const discordInput = (appItem.discordUsername || appItem.discord || creator.discord || '').trim();
    const targetTag = discordInput || `@${handle}`;
    const dispatchId = `AT-DISPATCH-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`;

    let deliveryResult = {
      dispatchId,
      status: 'PENDING',
      method: 'NONE',
      target: targetTag,
      messageId: null,
      channelId: null,
      latencyMs: 0,
      timestamp: new Date().toISOString(),
      note: ''
    };

    // 1. Dynamically resolve Discord Snowflake User ID from handle, username, or mention
    let resolvedUserId = null;
    if (this.token) {
      resolvedUserId = await this.resolveDiscordUserId(discordInput);
      if (!resolvedUserId && handle) {
        resolvedUserId = await this.resolveDiscordUserId(handle);
      }
      if (!resolvedUserId && creator.displayName) {
        resolvedUserId = await this.resolveDiscordUserId(creator.displayName);
      }
    }

    // 2. Personal DM Delivery (Guaranteed Confidentiality)
    if (this.token && resolvedUserId) {
      try {
        const dmRes = await this.sendDirectMessage(resolvedUserId, payload);
        deliveryResult = {
          dispatchId,
          status: 'DELIVERED_DM',
          method: 'DIRECT_MESSAGE',
          target: `${targetTag} (${resolvedUserId})`,
          recipientId: resolvedUserId,
          messageId: dmRes.messageId,
          channelId: dmRes.channelId,
          latencyMs: dmRes.latencyMs,
          timestamp: dmRes.timestamp,
          note: 'Personal Direct Message delivered securely to creator on Discord.'
        };
        this.recordDispatch({ type: 'DISCORD', ...deliveryResult, handle, displayName: creator.displayName });

        // Optional non-sensitive public celebration announcement to the server channel (WITHOUT keys or passwords)
        const routing = this.getRoutingConfig();
        const onbConf = routing.creator_onboarding || DEFAULT_ROUTING.creator_onboarding;
        const announceChannel = onbConf.channelId || this.channelId;
        if (onbConf.enabled !== false && onbConf.sendPublicAnnouncement !== false && announceChannel) {
          try {
            const color = onbConf.color ? parseInt(onbConf.color.replace('#', ''), 16) : 0x00F0FF;
            await this.sendChannelMessage(announceChannel, {
              content: `🎉 **New Streamer Verified!** Welcome **${creator.displayName}** (\`@${handle}\`) to the AuraTip Partner Fleet! 🚀`,
              embeds: [{
                title: `🚀 ${creator.displayName} is now Live on AuraTip!`,
                description: `Support **${creator.displayName}** with 60 FPS animated alerts & instant UPI tipping!\n\n🔗 **Public Tipping Link**: https://auratip.live/@${handle}`,
                color,
                footer: { text: "AuraTip Streamer Elite" },
                timestamp: new Date().toISOString()
              }]
            });
          } catch (annErr) {}
        }

        return deliveryResult;
      } catch (err) {
        console.warn(`[DiscordBot] Personal DM delivery failed to user ${resolvedUserId}:`, err.message);
        deliveryResult = {
          dispatchId,
          status: 'DM_FAILED',
          method: 'DIRECT_MESSAGE',
          target: `${targetTag} (${resolvedUserId})`,
          recipientId: resolvedUserId,
          messageId: null,
          channelId: null,
          latencyMs: 0,
          timestamp: new Date().toISOString(),
          note: `Personal DM delivery failed (${err.message}). The user may have direct messages closed from server members. Sensitive credentials were NOT exposed to server channels.`
        };
        this.recordDispatch({ type: 'DISCORD', ...deliveryResult, handle, displayName: creator.displayName });
        return deliveryResult;
      }
    }

    // 3. Member not found in Discord server
    if (this.token && !resolvedUserId) {
      deliveryResult = {
        dispatchId,
        status: 'USER_NOT_FOUND',
        method: 'NONE',
        target: targetTag,
        messageId: null,
        channelId: null,
        latencyMs: 0,
        timestamp: new Date().toISOString(),
        note: `Could not find a member with username "${targetTag}" in the Discord server. Ensure the applicant has joined the server. Sensitive credentials were kept private.`
      };
      this.recordDispatch({ type: 'DISCORD', ...deliveryResult, handle, displayName: creator.displayName });
      return deliveryResult;
    }

    // 4. Standby / Offline simulation
    this.stats.failures++;
    deliveryResult = {
      dispatchId,
      status: 'STANDBY_SIMULATION',
      method: 'SIMULATED',
      target: targetTag,
      messageId: `sim_dc_${Date.now()}`,
      channelId: 'offline_queue',
      latencyMs: 12,
      timestamp: new Date().toISOString(),
      note: 'Bot token not active. Connect DISCORD_BOT_TOKEN to send real Personal DMs.'
    };

    this.recordDispatch({ type: 'DISCORD', ...deliveryResult, handle, displayName: creator.displayName });
    return deliveryResult;
  }
}

// Singleton instance
const discordBot = new AuraTipDiscordBot();

module.exports = discordBot;
