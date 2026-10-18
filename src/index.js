/**
 * AuraTip Discord Bot — Standalone Entry Point
 * Run this directly: node src/index.js
 * Or import bot.js as a module from the main AuraTip platform.
 */

require('dotenv').config();
const bot = require('./bot');

(async () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ⚡ AuraTip Discord Bot — Standalone Mode');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await bot.init();

  const status = bot.getStatus();
  if (status.isOnline) {
    console.log(`  ✓ Bot online as ${status.botUser?.tag || 'AuraTip Bot'}`);
    console.log(`  ✓ Guild: ${bot.guildId || 'Not set'}`);
    console.log(`  ✓ Channel: ${bot.channelId || 'Not set'}`);
    console.log(`  ✓ Invite: ${status.inviteUrl}`);
  } else {
    console.log(`  ⚠ Bot status: ${status.status}`);
    console.log('  Set DISCORD_BOT_TOKEN in .env to go online.');
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Bot is running. Press Ctrl+C to stop.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
})();
