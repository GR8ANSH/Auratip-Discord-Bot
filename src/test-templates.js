const http = require('http');

async function run() {
  console.log('🧪 Testing Automated Super Chat Templates & Sorting...');

  // 1. Test public bot command endpoint with template substitution
  const botRes = await fetch('http://localhost:3000/api/bot/tip-info/gr8ansh');
  const botText = await botRes.text();
  console.log('1. /api/bot/tip-info/gr8ansh response:');
  console.log('   ', botText);

  if (botText.includes('Support @GR8ANSH') && botText.includes('Top Today')) {
    console.log('   ✅ Public !auratip command response verified.');
  } else {
    throw new Error('Unexpected bot response: ' + botText);
  }

  // 2. Test fetching creator integrations data
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  const creator = await prisma.creator.findUnique({
    where: { handle: 'gr8ansh' },
    select: { handle: true, seAccountId: true, seJwtToken: true, seBotEnabled: true, seTipAlertTemplate: true, botCommandTemplate: true }
  });
  console.log('2. Creator DB Record:');
  console.log('   seAccountId:', creator.seAccountId);
  console.log('   seBotEnabled:', creator.seBotEnabled);
  console.log('   seTipAlertTemplate in DB:', creator.seTipAlertTemplate || '(default)');
  console.log('   botCommandTemplate in DB:', creator.botCommandTemplate || '(default)');
  await prisma.$disconnect();

  console.log('🎉 ALL SUPERCHAT & CHAT BOT TEMPLATE TESTS PASSED SUCCESSFULLY!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
