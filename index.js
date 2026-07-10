'use strict';

/**
 * Commission / Request Bot
 * ------------------------
 * - Fully editable user-facing text (stored in DB, live-editable via /settext)
 * - Credit system (1 credit per submission)
 * - Payments: BTC + SOL (manual confirm), Telegram Stars (auto-credit)
 * - Admin receives each submission with Reply / Send Canned buttons
 *
 * Deploy on Render as a Web Service. Env vars required:
 *   BOT_TOKEN     - from @BotFather
 *   DATABASE_URL  - Render Postgres internal/external URL
 *   ADMIN_ID      - your numeric Telegram user id (from @userinfobot)
 *   PORT          - provided automatically by Render
 *
 * Tables are auto-created and default text auto-seeded on first boot.
 */

const http = require('http');
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN env var');
if (!DATABASE_URL) throw new Error('Missing DATABASE_URL env var');
if (!ADMIN_ID) throw new Error('Missing ADMIN_ID env var');

const bot = new Telegraf(BOT_TOKEN);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const isAdmin = (ctx) => ctx.from && ctx.from.id === ADMIN_ID;

// Simple in-memory conversational state (mode per telegram id)
const state = new Map();

// In-memory caches (refreshed from DB)
const textCache = new Map();
const settingCache = new Map();

// ---------------------------------------------------------------------------
// Default editable text. Placeholders in {curly} are filled at send time.
// Re-theme the whole bot by editing these live with /settext <key> <value>.
// ---------------------------------------------------------------------------
const DEFAULT_TEXTS = {
  welcome:
    "👋 Welcome!\n\nSubmit a request below. Each request costs 1 credit.\nYou currently have {credits} credit(s).",
  btn_submit: "📝 Submit a Request",
  btn_balance: "💳 My Credits",
  btn_buy: "⭐ Buy Credits",
  btn_help: "ℹ️ Help",
  ask_submission: "✍️ Send me your request as a single message and I'll pass it along.",
  submission_received:
    "✅ Got it — your request has been submitted (ref #{id}).\nYou have {credits} credit(s) left.",
  no_credits:
    "⚠️ You have 0 credits.\nTap '⭐ Buy Credits' to top up before submitting a request.",
  balance_msg: "💳 You have {credits} credit(s).",
  buy_intro: "Choose a package:",
  buy_method: "Package: {label}\nHow would you like to pay?",
  buy_btc_msg:
    "🟠 BTC Payment — {label}\n\nSend exactly {btc} BTC to:\n{btc_address}\n\nRef code: {code}\n\nAfter sending, wait for manual confirmation. Credits are added once the payment is verified.",
  buy_sol_msg:
    "🟣 SOL Payment — {label}\n\nSend exactly {sol} SOL to:\n{sol_address}\n\nRef code: {code}\n\nAfter sending, wait for manual confirmation. Credits are added once the payment is verified.",
  buy_stars_title: "{label}",
  buy_stars_desc: "Get {credits} credit(s) for your requests.",
  payment_thanks_stars: "⭐ Payment received! {credits} credit(s) added. You now have {balance}.",
  help_msg:
    "This bot lets you submit paid requests.\n\n• 1 credit = 1 request\n• Buy credits with BTC, SOL, or Telegram Stars\n• You'll be messaged here when there's a reply\n\nQuestions? Contact the admin.",
  canned_response:
    "Thanks for your request. Unfortunately we couldn't fulfill this one — your credit has NOT been used and has been returned to your balance.",
  admin_reply_prefix: "💬 Reply to your request #{id}:\n\n",
};

// ---------------------------------------------------------------------------
// Default settings (addresses + packages). Editable via admin commands.
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  btc_address: 'SET_YOUR_BTC_ADDRESS',
  sol_address: 'SET_YOUR_SOL_ADDRESS',
  packages: JSON.stringify([
    { credits: 1, stars: 50, btc: '0.0002', sol: '0.02', label: '1 credit' },
    { credits: 5, stars: 200, btc: '0.0008', sol: '0.08', label: '5 credits' },
    { credits: 10, stars: 350, btc: '0.0014', sol: '0.14', label: '10 credits' },
  ]),
};

// ---------------------------------------------------------------------------
// DB init
// ---------------------------------------------------------------------------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username    TEXT,
      credits     INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id          SERIAL PRIMARY KEY,
      user_id     BIGINT NOT NULL,
      content     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'open',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id          SERIAL PRIMARY KEY,
      user_id     BIGINT NOT NULL,
      method      TEXT NOT NULL,
      credits     INTEGER NOT NULL,
      code        TEXT,
      status      TEXT NOT NULL DEFAULT 'pending',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_texts (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Seed defaults only if missing (does not overwrite your edits)
  for (const [key, value] of Object.entries(DEFAULT_TEXTS)) {
    await pool.query(
      'INSERT INTO bot_texts(key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [key, value]
    );
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await pool.query(
      'INSERT INTO settings(key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [key, value]
    );
  }

  await refreshCaches();
  console.log('DB initialized and caches loaded.');
}

async function refreshCaches() {
  const t = await pool.query('SELECT key, value FROM bot_texts');
  textCache.clear();
  for (const row of t.rows) textCache.set(row.key, row.value);

  const s = await pool.query('SELECT key, value FROM settings');
  settingCache.clear();
  for (const row of s.rows) settingCache.set(row.key, row.value);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function t(key, params = {}) {
  let str = textCache.get(key);
  if (str === undefined) str = DEFAULT_TEXTS[key] || `[${key}]`;
  for (const [k, v] of Object.entries(params)) {
    str = str.split(`{${k}}`).join(String(v));
  }
  // Allow admins to type literal \n in /settext and have it render as a line break.
  str = str.split('\\n').join('\n');
  return str;
}

function setting(key) {
  return settingCache.get(key) ?? DEFAULT_SETTINGS[key] ?? '';
}

function getPackages() {
  try {
    return JSON.parse(setting('packages'));
  } catch {
    return JSON.parse(DEFAULT_SETTINGS.packages);
  }
}

async function ensureUser(ctx) {
  const id = ctx.from.id;
  const uname = ctx.from.username || null;
  const res = await pool.query(
    `INSERT INTO users(telegram_id, username) VALUES ($1, $2)
     ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username
     RETURNING credits`,
    [id, uname]
  );
  return res.rows[0].credits;
}

async function getCredits(userId) {
  const res = await pool.query('SELECT credits FROM users WHERE telegram_id = $1', [userId]);
  return res.rows[0] ? res.rows[0].credits : 0;
}

async function addCredits(userId, amount) {
  const res = await pool.query(
    'UPDATE users SET credits = credits + $2 WHERE telegram_id = $1 RETURNING credits',
    [userId, amount]
  );
  return res.rows[0] ? res.rows[0].credits : null;
}

function shortCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t('btn_submit'), 'submit')],
    [Markup.button.callback(t('btn_balance'), 'balance'), Markup.button.callback(t('btn_buy'), 'buy')],
    [Markup.button.callback(t('btn_help'), 'help')],
  ]);
}

// ---------------------------------------------------------------------------
// User flows
// ---------------------------------------------------------------------------
bot.start(async (ctx) => {
  const credits = await ensureUser(ctx);
  state.delete(ctx.from.id);
  await ctx.reply(t('welcome', { credits }), mainMenu());
});

bot.action('submit', async (ctx) => {
  await ctx.answerCbQuery();
  await ensureUser(ctx);
  const credits = await getCredits(ctx.from.id);
  if (credits <= 0) {
    return ctx.reply(t('no_credits'), mainMenu());
  }
  state.set(ctx.from.id, { mode: 'awaiting_submission' });
  await ctx.reply(t('ask_submission'));
});

bot.action('balance', async (ctx) => {
  await ctx.answerCbQuery();
  const credits = await getCredits(ctx.from.id);
  await ctx.reply(t('balance_msg', { credits }), mainMenu());
});

bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(t('help_msg'), mainMenu());
});

bot.action('buy', async (ctx) => {
  await ctx.answerCbQuery();
  const packages = getPackages();
  const rows = packages.map((p, i) => [
    Markup.button.callback(`${p.label} — ⭐${p.stars} / ₿${p.btc} / ◎${p.sol}`, `pkg:${i}`),
  ]);
  await ctx.reply(t('buy_intro'), Markup.inlineKeyboard(rows));
});

bot.action(/^pkg:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const i = Number(ctx.match[1]);
  const packages = getPackages();
  const p = packages[i];
  if (!p) return ctx.reply('That package is no longer available.');
  await ctx.reply(
    t('buy_method', { label: p.label }),
    Markup.inlineKeyboard([
      [Markup.button.callback('🟠 BTC', `pay:${i}:btc`)],
      [Markup.button.callback('🟣 SOL', `pay:${i}:sol`)],
      [Markup.button.callback('⭐ Telegram Stars', `pay:${i}:stars`)],
    ])
  );
});

bot.action(/^pay:(\d+):(btc|sol|stars)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const i = Number(ctx.match[1]);
  const method = ctx.match[2];
  const packages = getPackages();
  const p = packages[i];
  if (!p) return ctx.reply('That package is no longer available.');
  await ensureUser(ctx);

  if (method === 'stars') {
    // Telegram Stars: native, auto-credits on success.
    return ctx.replyWithInvoice({
      title: t('buy_stars_title', { label: p.label }),
      description: t('buy_stars_desc', { credits: p.credits }),
      payload: `stars:${p.credits}`,
      provider_token: '', // empty for Stars
      currency: 'XTR',
      prices: [{ label: p.label, amount: p.stars }],
    });
  }

  // BTC / SOL: create a pending payment + show address, admin confirms manually.
  const code = shortCode();
  await pool.query(
    'INSERT INTO payments(user_id, method, credits, code, status) VALUES ($1, $2, $3, $4, $5)',
    [ctx.from.id, method, p.credits, code, 'pending']
  );

  if (method === 'btc') {
    await ctx.reply(
      t('buy_btc_msg', {
        label: p.label,
        btc: p.btc,
        btc_address: setting('btc_address'),
        code,
      })
    );
  } else {
    await ctx.reply(
      t('buy_sol_msg', {
        label: p.label,
        sol: p.sol,
        sol_address: setting('sol_address'),
        code,
      })
    );
  }

  // Notify admin of pending payment
  await bot.telegram
    .sendMessage(
      ADMIN_ID,
      `💰 Pending ${method.toUpperCase()} payment\n` +
        `User: ${ctx.from.id} (@${ctx.from.username || 'none'})\n` +
        `Package: ${p.label} (${p.credits} credits)\n` +
        `Ref code: ${code}\n\n` +
        `Confirm with:\n/addcredits ${ctx.from.id} ${p.credits}`
    )
    .catch(() => {});
});

// Telegram Stars payment plumbing
bot.on('pre_checkout_query', async (ctx) => {
  try {
    await ctx.answerPreCheckoutQuery(true);
  } catch (e) {
    await ctx.answerPreCheckoutQuery(false, 'Something went wrong.');
  }
});

bot.on('successful_payment', async (ctx) => {
  const payload = ctx.message.successful_payment.invoice_payload || '';
  const m = payload.match(/^stars:(\d+)$/);
  const credits = m ? Number(m[1]) : 0;
  if (credits > 0) {
    await ensureUser(ctx);
    const balance = await addCredits(ctx.from.id, credits);
    await pool.query(
      'INSERT INTO payments(user_id, method, credits, status) VALUES ($1, $2, $3, $4)',
      [ctx.from.id, 'stars', credits, 'confirmed']
    );
    await ctx.reply(t('payment_thanks_stars', { credits, balance }));
  }
});

// ---------------------------------------------------------------------------
// Admin commands
// ---------------------------------------------------------------------------
bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.reply(
    'Admin panel:\n\n' +
      '/addcredits <user_id> <amount>\n' +
      '/pending — pending BTC/SOL payments\n' +
      '/users — recent users\n' +
      '/setaddr btc|sol <address>\n' +
      '/setpackages <json>\n' +
      '/settext <key> <value...>\n' +
      '/gettext <key>\n' +
      '/listtexts\n' +
      '/reply <submission_id> <text...>\n' +
      '/canned <submission_id>'
  );
});

bot.command('addcredits', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.trim().split(/\s+/);
  const userId = Number(parts[1]);
  const amount = Number(parts[2]);
  if (!userId || !amount) return ctx.reply('Usage: /addcredits <user_id> <amount>');
  const balance = await addCredits(userId, amount);
  if (balance === null) return ctx.reply('User not found (they must /start the bot first).');
  await ctx.reply(`✅ Added ${amount} credits to ${userId}. New balance: ${balance}.`);
  await bot.telegram
    .sendMessage(userId, `✅ ${amount} credit(s) added. You now have ${balance}.`)
    .catch(() => {});
});

bot.command('pending', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const res = await pool.query(
    "SELECT * FROM payments WHERE status = 'pending' ORDER BY created_at DESC LIMIT 20"
  );
  if (!res.rows.length) return ctx.reply('No pending payments.');
  const lines = res.rows.map(
    (p) =>
      `#${p.id} ${p.method.toUpperCase()} ${p.credits}cr — user ${p.user_id} — code ${p.code}\n` +
      `  → /addcredits ${p.user_id} ${p.credits}`
  );
  await ctx.reply(lines.join('\n'));
});

bot.command('users', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const res = await pool.query(
    'SELECT telegram_id, username, credits FROM users ORDER BY created_at DESC LIMIT 20'
  );
  if (!res.rows.length) return ctx.reply('No users yet.');
  const lines = res.rows.map(
    (u) => `${u.telegram_id} (@${u.username || 'none'}) — ${u.credits} credits`
  );
  await ctx.reply(lines.join('\n'));
});

bot.command('setaddr', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.trim().split(/\s+/);
  const kind = (parts[1] || '').toLowerCase();
  const addr = parts[2];
  if (!['btc', 'sol'].includes(kind) || !addr)
    return ctx.reply('Usage: /setaddr btc|sol <address>');
  const key = kind === 'btc' ? 'btc_address' : 'sol_address';
  await pool.query(
    'INSERT INTO settings(key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, addr]
  );
  await refreshCaches();
  await ctx.reply(`✅ ${kind.toUpperCase()} address updated.`);
});

bot.command('setpackages', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const json = ctx.message.text.replace(/^\/setpackages\s+/, '').trim();
  if (!json) return ctx.reply('Usage: /setpackages <json array>');
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    await pool.query(
      'INSERT INTO settings(key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      ['packages', JSON.stringify(parsed)]
    );
    await refreshCaches();
    await ctx.reply(`✅ Packages updated (${parsed.length} packages).`);
  } catch (e) {
    await ctx.reply('Invalid JSON. Example:\n' + DEFAULT_SETTINGS.packages);
  }
});

bot.command('settext', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const raw = ctx.message.text.replace(/^\/settext\s+/, '');
  const spaceIdx = raw.indexOf(' ');
  if (spaceIdx === -1) return ctx.reply('Usage: /settext <key> <value...>');
  const key = raw.slice(0, spaceIdx).trim();
  const value = raw.slice(spaceIdx + 1);
  if (!key || !value) return ctx.reply('Usage: /settext <key> <value...>');
  await pool.query(
    'INSERT INTO bot_texts(key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value]
  );
  await refreshCaches();
  await ctx.reply(`✅ Updated text "${key}".`);
});

bot.command('gettext', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const key = ctx.message.text.replace(/^\/gettext\s+/, '').trim();
  if (!key) return ctx.reply('Usage: /gettext <key>');
  await ctx.reply(`"${key}":\n\n${t(key)}`);
});

bot.command('listtexts', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const keys = Object.keys(DEFAULT_TEXTS);
  await ctx.reply('Editable text keys:\n\n' + keys.join('\n') + '\n\nEdit with /settext <key> <value>');
});

bot.command('reply', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const raw = ctx.message.text.replace(/^\/reply\s+/, '');
  const spaceIdx = raw.indexOf(' ');
  if (spaceIdx === -1) return ctx.reply('Usage: /reply <submission_id> <text...>');
  const subId = Number(raw.slice(0, spaceIdx));
  const text = raw.slice(spaceIdx + 1);
  await deliverReply(ctx, subId, text);
});

bot.command('canned', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const subId = Number(ctx.message.text.replace(/^\/canned\s+/, '').trim());
  if (!subId) return ctx.reply('Usage: /canned <submission_id>');
  await sendCanned(ctx, subId);
});

// Admin taps the "Reply" button on a submission notification
bot.action(/^areply:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  const subId = Number(ctx.match[1]);
  state.set(ctx.from.id, { mode: 'admin_reply', submissionId: subId });
  await ctx.reply(`✍️ Type your reply for submission #${subId}. Next message you send goes to that user.`);
});

// Admin taps the "Send Canned" button
bot.action(/^acanned:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  const subId = Number(ctx.match[1]);
  await sendCanned(ctx, subId);
});

async function getSubmission(subId) {
  const res = await pool.query('SELECT * FROM submissions WHERE id = $1', [subId]);
  return res.rows[0] || null;
}

async function deliverReply(ctx, subId, text) {
  const sub = await getSubmission(subId);
  if (!sub) return ctx.reply(`Submission #${subId} not found.`);
  await bot.telegram
    .sendMessage(sub.user_id, t('admin_reply_prefix', { id: subId }) + text)
    .catch((e) => ctx.reply(`Could not message user: ${e.message}`));
  await pool.query("UPDATE submissions SET status = 'replied' WHERE id = $1", [subId]);
  await ctx.reply(`✅ Reply sent for #${subId}.`);
}

async function sendCanned(ctx, subId) {
  const sub = await getSubmission(subId);
  if (!sub) return ctx.reply(`Submission #${subId} not found.`);
  // Refund the credit (the canned message says the credit wasn't used)
  const balance = await addCredits(sub.user_id, 1);
  await bot.telegram.sendMessage(sub.user_id, t('canned_response')).catch(() => {});
  await pool.query("UPDATE submissions SET status = 'canned' WHERE id = $1", [subId]);
  await ctx.reply(`✅ Canned response sent for #${subId}. Credit refunded (user now ${balance}).`);
}

// ---------------------------------------------------------------------------
// Text handler (must be registered AFTER commands). Handles conversational
// state for both users (submission) and admin (reply).
// ---------------------------------------------------------------------------
bot.on('text', async (ctx) => {
  const st = state.get(ctx.from.id);

  // Admin is composing a free-text reply
  if (st && st.mode === 'admin_reply' && isAdmin(ctx)) {
    state.delete(ctx.from.id);
    return deliverReply(ctx, st.submissionId, ctx.message.text);
  }

  // User is submitting a request
  if (st && st.mode === 'awaiting_submission') {
    state.delete(ctx.from.id);
    const credits = await getCredits(ctx.from.id);
    if (credits <= 0) {
      return ctx.reply(t('no_credits'), mainMenu());
    }
    // Deduct 1 credit and store submission
    const dec = await pool.query(
      'UPDATE users SET credits = credits - 1 WHERE telegram_id = $1 AND credits > 0 RETURNING credits',
      [ctx.from.id]
    );
    if (!dec.rows.length) {
      return ctx.reply(t('no_credits'), mainMenu());
    }
    const remaining = dec.rows[0].credits;
    const ins = await pool.query(
      'INSERT INTO submissions(user_id, content) VALUES ($1, $2) RETURNING id',
      [ctx.from.id, ctx.message.text]
    );
    const subId = ins.rows[0].id;

    await ctx.reply(t('submission_received', { id: subId, credits: remaining }), mainMenu());

    // Notify admin with action buttons
    await bot.telegram
      .sendMessage(
        ADMIN_ID,
        `📬 New submission #${subId}\n` +
          `From: ${ctx.from.id} (@${ctx.from.username || 'none'})\n\n` +
          `${ctx.message.text}`,
        Markup.inlineKeyboard([
          [Markup.button.callback('💬 Reply', `areply:${subId}`)],
          [Markup.button.callback('📋 Send Canned', `acanned:${subId}`)],
        ])
      )
      .catch(() => {});
    return;
  }

  // Fallback: show the menu
  await ensureUser(ctx);
  await ctx.reply('Use the menu below:', mainMenu());
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main() {
  await initDb();

  // Tiny HTTP server so Render Web Service keeps the process alive.
  http
    .createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Bot is running.');
    })
    .listen(PORT, () => console.log(`HTTP keepalive on port ${PORT}`));

  await bot.launch();
  console.log('Bot launched.');
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
