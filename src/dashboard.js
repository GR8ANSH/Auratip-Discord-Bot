/**
 * AuraTip Discord Bot — Dashboard Server
 * Standalone web dashboard for managing the AuraTip Discord Bot.
 * Runs on port 3001 alongside the main AuraTip platform (port 3000).
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
// Also try the Auratip .env if bot-local .env is missing keys
if (!process.env.DISCORD_BOT_TOKEN) {
  require('dotenv').config({ path: require('path').resolve(__dirname, '../../Auratip/.env'), override: false });
}

const express = require('express');
const path = require('path');
const bot = require('./bot');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3001;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || process.env.ADMIN_PASSCODE || 'admin123';

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Simple token-based auth
function generateToken() {
  return 'dash_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}
const activeSessions = new Map();

function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token || !activeSessions.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Auth Routes ──────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (password !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = generateToken();
  activeSessions.set(token, { loginAt: Date.now() });
  // Clean old sessions (>24h)
  for (const [k, v] of activeSessions) {
    if (Date.now() - v.loginAt > 86400000) activeSessions.delete(k);
  }
  res.json({ success: true, token });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  activeSessions.delete(token);
  res.json({ success: true });
});

// ── Bot Status ───────────────────────────────────────────────
app.get('/api/bot/status', requireAuth, (req, res) => {
  const status = bot.getStatus();
  res.json({
    ...status,
    guildId: bot.guildId || null,
    channelId: bot.channelId || null,
    processUptime: Math.floor(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
  });
});

// ── Guild Info (from Discord API) ────────────────────────────
app.get('/api/guild/info', requireAuth, async (req, res) => {
  if (!bot.token || !bot.guildId) {
    return res.json({ error: 'Bot not connected or guild not set', guild: null });
  }
  try {
    const guildRes = await fetch(`https://discord.com/api/v10/guilds/${bot.guildId}?with_counts=true`, {
      headers: { 'Authorization': `Bot ${bot.token}` }
    });
    if (!guildRes.ok) throw new Error(`HTTP ${guildRes.status}`);
    const guild = await guildRes.json();
    res.json({
      id: guild.id,
      name: guild.name,
      icon: guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128` : null,
      memberCount: guild.approximate_member_count || 0,
      onlineCount: guild.approximate_presence_count || 0,
      boostLevel: guild.premium_tier || 0,
      boostCount: guild.premium_subscription_count || 0
    });
  } catch (err) {
    res.json({ error: err.message, guild: null });
  }
});

// ── Guild Channels ───────────────────────────────────────────
app.get('/api/guild/channels', requireAuth, async (req, res) => {
  if (!bot.token || !bot.guildId) return res.json({ channels: [] });
  try {
    const chRes = await fetch(`https://discord.com/api/v10/guilds/${bot.guildId}/channels`, {
      headers: { 'Authorization': `Bot ${bot.token}` }
    });
    if (!chRes.ok) throw new Error(`HTTP ${chRes.status}`);
    const channels = await chRes.json();
    // Only text channels (type 0) and announcement channels (type 5)
    const textChannels = channels
      .filter(c => c.type === 0 || c.type === 5)
      .sort((a, b) => a.position - b.position)
      .map(c => ({ id: c.id, name: c.name, type: c.type, position: c.position, parentId: c.parent_id }));
    res.json({ channels: textChannels });
  } catch (err) {
    res.json({ channels: [], error: err.message });
  }
});

// ── Member Search ────────────────────────────────────────────
app.get('/api/guild/members/search', requireAuth, async (req, res) => {
  const query = req.query.q || '';
  if (!bot.token || !bot.guildId || !query) return res.json({ members: [] });
  try {
    const mRes = await fetch(`https://discord.com/api/v10/guilds/${bot.guildId}/members/search?query=${encodeURIComponent(query)}&limit=25`, {
      headers: { 'Authorization': `Bot ${bot.token}` }
    });
    if (!mRes.ok) throw new Error(`HTTP ${mRes.status}`);
    const members = await mRes.json();
    res.json({
      members: members.map(m => ({
        id: m.user.id,
        username: m.user.username,
        globalName: m.user.global_name,
        nick: m.nick,
        avatar: m.user.avatar ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png?size=64` : null,
        roles: m.roles,
        joinedAt: m.joined_at
      }))
    });
  } catch (err) {
    res.json({ members: [], error: err.message });
  }
});

// ── Send DM ──────────────────────────────────────────────────
app.post('/api/dispatch/dm', requireAuth, async (req, res) => {
  try {
    const { recipient, content, embedTitle, embedDescription, embedColor } = req.body;
    if (!recipient) return res.status(400).json({ error: 'Recipient is required' });

    const payload = {};
    if (content) payload.content = content;
    if (embedTitle || embedDescription) {
      payload.embeds = [{
        title: embedTitle || undefined,
        description: embedDescription || undefined,
        color: embedColor ? parseInt(embedColor.replace('#', ''), 16) : 0x00F0FF,
        footer: { text: 'AuraTip Bot Dashboard' },
        timestamp: new Date().toISOString()
      }];
    }
    if (!payload.content && !payload.embeds) {
      return res.status(400).json({ error: 'Message content or embed is required' });
    }

    const result = await bot.sendDirectMessage(recipient, payload);
    bot.recordDispatch({ type: 'DASHBOARD_DM', ...result, target: recipient });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Send Channel Message ─────────────────────────────────────
app.post('/api/dispatch/channel', requireAuth, async (req, res) => {
  try {
    const { channelId, content, embedTitle, embedDescription, embedColor } = req.body;
    const targetChannel = channelId || bot.channelId;
    if (!targetChannel) return res.status(400).json({ error: 'Channel ID is required' });

    const payload = {};
    if (content) payload.content = content;
    if (embedTitle || embedDescription) {
      payload.embeds = [{
        title: embedTitle || undefined,
        description: embedDescription || undefined,
        color: embedColor ? parseInt(embedColor.replace('#', ''), 16) : 0x00F0FF,
        footer: { text: 'AuraTip Bot Dashboard' },
        timestamp: new Date().toISOString()
      }];
    }

    const result = await bot.sendChannelMessage(targetChannel, payload);
    bot.recordDispatch({ type: 'DASHBOARD_CHANNEL', ...result, target: `#${targetChannel}` });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Smart Dispatch ───────────────────────────────────────────
app.post('/api/dispatch/smart', requireAuth, async (req, res) => {
  try {
    const { target, content, embedTitle, embedDescription, embedColor } = req.body;
    const payload = {};
    if (content) payload.content = content;
    if (embedTitle || embedDescription) {
      payload.embeds = [{
        title: embedTitle || undefined,
        description: embedDescription || undefined,
        color: embedColor ? parseInt(embedColor.replace('#', ''), 16) : 0x00F0FF,
        footer: { text: 'AuraTip Bot Dashboard' },
        timestamp: new Date().toISOString()
      }];
    }
    const result = await bot.smartDispatch({ target, payload });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Resolve User ─────────────────────────────────────────────
app.get('/api/resolve/user', requireAuth, async (req, res) => {
  const input = req.query.q || '';
  if (!input) return res.json({ userId: null });
  try {
    const userId = await bot.resolveDiscordUserId(input);
    res.json({ userId, input });
  } catch (err) {
    res.json({ userId: null, error: err.message });
  }
});

// ── Dispatch History ─────────────────────────────────────────
app.get('/api/dispatches', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const dispatches = bot.getDispatchHistory(limit);
  res.json({ dispatches, total: dispatches.length });
});

// ── Bot Config Update ────────────────────────────────────────
app.post('/api/bot/config', requireAuth, async (req, res) => {
  try {
    const { channelId, guildId } = req.body;
    // Only allow channel/guild changes (token changes need .env restart for security)
    if (channelId !== undefined) bot.channelId = channelId.trim();
    if (guildId !== undefined) bot.guildId = guildId.trim();
    res.json({ success: true, channelId: bot.channelId, guildId: bot.guildId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Channel Routing Matrix ──────────────────────────────────
app.get('/api/routing', requireAuth, (req, res) => {
  try {
    const routing = bot.getRoutingConfig();
    res.json({ routing });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/routing', requireAuth, (req, res) => {
  try {
    const { routing } = req.body;
    if (!routing || typeof routing !== 'object') {
      return res.status(400).json({ error: 'Invalid routing configuration' });
    }
    const updated = bot.saveRoutingConfig(routing);
    res.json({ success: true, routing: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/routing/test/:category', requireAuth, async (req, res) => {
  try {
    const category = req.params.category;
    const result = await bot.testChannelRouting(category);
    res.json({ success: true, category, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Advanced Embed Studio Dispatcher ─────────────────────────
app.post('/api/embeds/dispatch-custom', requireAuth, async (req, res) => {
  try {
    const {
      targetType, // 'channel' or 'dm'
      targetId,   // channel ID or user ID / mention
      content,
      embed
    } = req.body;

    if (!targetId) {
      return res.status(400).json({ error: 'Target Channel or User ID is required' });
    }

    const payload = {};
    if (content) payload.content = content;
    if (embed && (embed.title || embed.description || (embed.fields && embed.fields.length))) {
      payload.embeds = [{
        title: embed.title || undefined,
        description: embed.description || undefined,
        url: embed.url || undefined,
        color: embed.color ? parseInt(String(embed.color).replace('#', ''), 16) : 0x00F0FF,
        fields: Array.isArray(embed.fields) ? embed.fields.filter(f => f.name && f.value) : undefined,
        author: embed.authorName ? {
          name: embed.authorName,
          icon_url: embed.authorIcon || undefined,
          url: embed.authorUrl || undefined
        } : undefined,
        thumbnail: embed.thumbnailUrl ? { url: embed.thumbnailUrl } : undefined,
        image: embed.imageUrl ? { url: embed.imageUrl } : undefined,
        footer: embed.footerText ? {
          text: embed.footerText,
          icon_url: embed.footerIcon || undefined
        } : undefined,
        timestamp: embed.timestamp ? new Date().toISOString() : undefined
      }];
    }

    if (!payload.content && (!payload.embeds || !payload.embeds.length)) {
      return res.status(400).json({ error: 'Message content or embed is required' });
    }

    let result;
    if (targetType === 'dm') {
      result = await bot.sendDirectMessage(targetId, payload);
      bot.recordDispatch({ type: 'STUDIO_DM', ...result, target: `DM: ${targetId}` });
    } else {
      result = await bot.sendChannelMessage(targetId, payload);
      bot.recordDispatch({ type: 'STUDIO_CHANNEL', ...result, target: `#${targetId}` });
    }

    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Webhook Gateway for Auratip Events ───────────────────────
app.post('/api/webhook/auratip-event', async (req, res) => {
  try {
    const authHeader = req.headers['x-auratip-secret'] || req.headers.authorization;
    const expectedSecret = process.env.AURATIP_WEBHOOK_SECRET || process.env.ADMIN_PASSCODE || 'admin123';
    
    // Validate secret if provided
    if (authHeader && authHeader !== expectedSecret && authHeader !== `Bearer ${expectedSecret}`) {
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }

    const { event, data } = req.body;
    if (!event) return res.status(400).json({ error: 'Event name is required' });

    let dispatchResult = null;
    switch (event) {
      case 'tip_alert':
        if (data?.creator && data?.tip) {
          await bot.broadcastTipAlert(data.creator, data.tip);
          dispatchResult = { status: 'DISPATCHED_TIP' };
        }
        break;
      case 'goal_celebration':
        if (data?.creator) {
          await bot.broadcastGoalCelebration(data.creator, data.goal);
          dispatchResult = { status: 'DISPATCHED_GOAL' };
        }
        break;
      case 'stream_boost':
        if (data?.creator) {
          await bot.broadcastStreamBoost(data.creator);
          dispatchResult = { status: 'DISPATCHED_BOOST' };
        }
        break;
      case 'platform_broadcast':
        await bot.broadcastPlatformNotice(data?.title, data?.message, data?.options);
        dispatchResult = { status: 'DISPATCHED_BROADCAST' };
        break;
      case 'audit_alert':
        await bot.broadcastAuditAlert(data?.event || 'ADMIN_ACTION', data?.details);
        dispatchResult = { status: 'DISPATCHED_AUDIT' };
        break;
      default:
        return res.status(400).json({ error: `Unsupported event: ${event}` });
    }

    res.json({ success: true, event, dispatchResult });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Reconnect Bot ────────────────────────────────────────────
app.post('/api/bot/reconnect', requireAuth, async (req, res) => {
  try {
    await bot.init();
    res.json({ success: true, status: bot.getStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Fallback: serve dashboard ────────────────────────────────
app.use((req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Boot ─────────────────────────────────────────────────────
(async () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ⚡ AuraTip Bot Dashboard');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await bot.init();

  app.listen(PORT, () => {
    const st = bot.getStatus();
    console.log(`  ✓ Dashboard:  http://localhost:${PORT}`);
    console.log(`  ✓ Bot:        ${st.isOnline ? `Online as ${st.botUser?.tag}` : st.status}`);
    console.log(`  ✓ Guild:      ${bot.guildId || '—'}`);
    console.log(`  ✓ Channel:    ${bot.channelId || '—'}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  });
})();
