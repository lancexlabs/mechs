/**
 * wa-bridge.js — WhatsApp Bridge for MotoShop
 * ─────────────────────────────────────────────
 * Provides a local HTTP server that sends WhatsApp messages
 * via whatsapp-web.js (no official API needed).
 *
 * INSTALL:
 *   npm install whatsapp-web.js qrcode express cors
 *
 * RUN:
 *   node wa-bridge.js
 *
 * Then go to MotoShop Settings → WhatsApp → Local Bridge
 * Set Bridge URL to: http://localhost:3003/api/send
 * Click "Refresh QR" and scan with your phone.
 *
 * ENVIRONMENT VARIABLES (optional):
 *   PORT=3003            — Bridge port (default 3003)
 *   WA_API_KEY=secret    — Bearer token for API security (optional)
 *   HEADLESS=true        — Run browser headless (default true)
 *   SEND_DELAY_MS=800    — Delay between bulk messages in ms (default 800)
 *   MAX_RETRIES=2        — Retry count on send failure (default 2)
 */

const express    = require('express');
const cors       = require('cors');
const qrcode     = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app          = express();
const PORT         = process.env.PORT         || 3003;
const API_KEY      = process.env.WA_API_KEY   || '';
const SEND_DELAY   = parseInt(process.env.SEND_DELAY_MS) || 800;
const MAX_RETRIES  = parseInt(process.env.MAX_RETRIES)   || 2;

app.use(cors());
app.use(express.json());

// ─── STATE ────────────────────────────────────────────────────────────────────
let client       = null;
let isReady      = false;
let currentQR    = null;
let currentQRImg = null;
let clientStatus = 'initializing'; // initializing | qr | connecting | ready | disconnected

// Simple in-memory send log (last 100 entries)
const sendLog = [];
function logSend(entry) {
  sendLog.unshift({ ...entry, ts: new Date().toISOString() });
  if (sendLog.length > 100) sendLog.pop();
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
function authGuard(req, res, next) {
  if (!API_KEY) return next();
  const provided = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (provided !== API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  next();
}

// ─── SEND HELPER WITH RETRY ───────────────────────────────────────────────────
async function sendWithRetry(chatId, message, retries = MAX_RETRIES) {
  let lastErr;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      await client.sendMessage(chatId, message);
      return { success: true };
    } catch (err) {
      lastErr = err;
      if (attempt <= retries) {
        console.warn(`  ↻ Retry ${attempt}/${retries} for ${chatId}: ${err.message}`);
        await new Promise(r => setTimeout(r, 1000 * attempt)); // back-off
      }
    }
  }
  return { success: false, error: lastErr.message };
}

// ─── WHATSAPP CLIENT ──────────────────────────────────────────────────────────
function initClient() {
  console.log('🔄 Initializing WhatsApp client…');
  clientStatus = 'initializing';

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wa-session' }),
    puppeteer: {
      headless: process.env.HEADLESS !== 'false',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    }
  });

  client.on('qr', async (qr) => {
    currentQR = qr;
    clientStatus = 'qr';
    try {
      currentQRImg = await qrcode.toDataURL(qr, { margin: 2, width: 256 });
    } catch (e) {
      console.warn('QR image gen failed:', e.message);
    }
    console.log('\n📱 QR CODE READY — scan from MotoShop Settings → WhatsApp Bridge\n');
  });

  client.on('loading_screen', (pct, msg) => {
    clientStatus = 'connecting';
    process.stdout.write(`\r⏳ Loading: ${pct}% — ${msg}          `);
  });

  client.on('authenticated', () => {
    clientStatus = 'connecting';
    currentQR = null; currentQRImg = null;
    console.log('\n🔑 Authenticated — loading session…');
  });

  client.on('ready', () => {
    isReady = true;
    clientStatus = 'ready';
    const info = client.info;
    console.log(`\n✅ WhatsApp connected!`);
    console.log(`📞 Logged in as: ${info?.pushname || 'Unknown'} (${info?.wid?.user || ''})`);
    console.log(`🌐 Bridge running at http://localhost:${PORT}\n`);
  });

  client.on('disconnected', (reason) => {
    isReady = false;
    clientStatus = 'disconnected';
    console.warn('⚠️  WhatsApp disconnected:', reason);
    setTimeout(() => {
      console.log('🔄 Reconnecting…');
      initClient();
    }, 5000);
  });

  client.on('auth_failure', (msg) => {
    isReady = false;
    clientStatus = 'disconnected';
    console.error('❌ Auth failure:', msg);
    console.log('   Delete .wa-session folder and restart to re-scan QR');
  });

  client.initialize().catch(err => {
    console.error('❌ Failed to initialize client:', err.message);
    clientStatus = 'disconnected';
  });
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

/**
 * GET /health
 * Returns bridge health — polled by MotoShop "Check Bridge" button.
 */
app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    bridge:    'motoshop-wa-bridge',
    whatsapp:  clientStatus,
    connected: isReady
  });
});

/**
 * GET /api/status
 * Returns connection status — polled by MotoShop Refresh QR button.
 */
app.get('/api/status', authGuard, (req, res) => {
  const info = client?.info;
  res.json({
    connected: isReady,
    status:    clientStatus,
    name:      info?.pushname || null,
    phone:     info?.wid?.user || null
  });
});

/**
 * GET /api/qr
 * Returns the current QR code as a base64 data-URL image.
 */
app.get('/api/qr', authGuard, (req, res) => {
  if (isReady) {
    return res.json({ connected: true, message: 'Already connected — no QR needed' });
  }
  if (!currentQRImg) {
    return res.status(503).json({
      error: clientStatus === 'initializing'
        ? 'Client still starting up, try again in a few seconds'
        : 'No QR available — WhatsApp may be authenticating'
    });
  }
  res.json({ qr: currentQRImg, connected: false });
});

/**
 * GET /api/log
 * Returns the last 100 sent message records (for debugging).
 */
app.get('/api/log', authGuard, (req, res) => {
  res.json({ count: sendLog.length, log: sendLog });
});

/**
 * POST /api/send
 * Send a single WhatsApp message.
 * Body: { phone: "919876543210", message: "Hi!" }
 */
app.post('/api/send', authGuard, async (req, res) => {
  if (!isReady) {
    return res.status(503).json({
      error: `WhatsApp is not connected (status: ${clientStatus}). Scan QR first.`
    });
  }

  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: 'phone and message are required' });
  }

  const cleanPhone = String(phone).replace(/\D/g, '');
  if (cleanPhone.length < 7) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }

  const chatId = `${cleanPhone}@c.us`;

  // Check if number is on WhatsApp
  const isRegistered = await client.isRegisteredUser(chatId).catch(() => true);
  if (!isRegistered) {
    return res.status(422).json({
      error: `Phone ${cleanPhone} is not registered on WhatsApp`
    });
  }

  const result = await sendWithRetry(chatId, message);
  if (result.success) {
    logSend({ to: cleanPhone, message, status: 'sent' });
    console.log(`✅ Sent → ${cleanPhone}`);
    res.json({ success: true, to: cleanPhone, timestamp: new Date().toISOString() });
  } else {
    logSend({ to: cleanPhone, message, status: 'failed', error: result.error });
    console.error(`❌ Failed → ${cleanPhone}: ${result.error}`);
    res.status(500).json({ error: result.error });
  }
});

/**
 * POST /api/send-bulk
 * Send messages to multiple recipients in one request.
 * Called automatically by MotoShop after every job save/status update.
 *
 * Body: { messages: [ { phone, message }, ... ] }
 *
 * Returns: {
 *   sent:    N,
 *   failed:  N,
 *   results: [ { phone, success, error? }, ... ]  ← same order as input
 * }
 */
app.post('/api/send-bulk', authGuard, async (req, res) => {
  if (!isReady) {
    return res.status(503).json({
      error: `WhatsApp not connected (${clientStatus}). Scan QR first.`
    });
  }

  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  console.log(`📨 Bulk send: ${messages.length} recipient(s)`);
  const results = [];

  for (let i = 0; i < messages.length; i++) {
    const { phone, message } = messages[i];
    const cleanPhone = String(phone || '').replace(/\D/g, '');

    // Validate
    if (!cleanPhone || cleanPhone.length < 7) {
      results.push({ phone: cleanPhone || phone, success: false, error: 'Invalid or missing phone number' });
      continue;
    }
    if (!message) {
      results.push({ phone: cleanPhone, success: false, error: 'Missing message' });
      continue;
    }

    const chatId = `${cleanPhone}@c.us`;

    // WhatsApp registration check
    const isRegistered = await client.isRegisteredUser(chatId).catch(() => true);
    if (!isRegistered) {
      const err = `Not registered on WhatsApp`;
      results.push({ phone: cleanPhone, success: false, error: err });
      logSend({ to: cleanPhone, message, status: 'failed', error: err });
      console.warn(`  ⚠ ${cleanPhone}: ${err}`);
      continue;
    }

    // Send with retry
    const result = await sendWithRetry(chatId, message);
    results.push({ phone: cleanPhone, success: result.success, error: result.error });

    if (result.success) {
      logSend({ to: cleanPhone, message, status: 'sent' });
      console.log(`  ✅ [${i + 1}/${messages.length}] Sent → ${cleanPhone}`);
    } else {
      logSend({ to: cleanPhone, message, status: 'failed', error: result.error });
      console.error(`  ❌ [${i + 1}/${messages.length}] Failed → ${cleanPhone}: ${result.error}`);
    }

    // Delay between messages to avoid WhatsApp rate limits
    if (i < messages.length - 1) {
      await new Promise(r => setTimeout(r, SEND_DELAY));
    }
  }

  const sent   = results.filter(r => r.success).length;
  const failed = results.length - sent;
  console.log(`📊 Bulk done: ${sent} sent, ${failed} failed\n`);
  res.json({ sent, failed, results });
});

/**
 * POST /api/disconnect
 * Gracefully log out from WhatsApp.
 */
app.post('/api/disconnect', authGuard, async (req, res) => {
  try {
    await client?.logout();
    isReady = false;
    clientStatus = 'disconnected';
    res.json({ success: true, message: 'Logged out. Restart bridge and scan QR again.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n' + '='.repeat(52));
  console.log('📱 MOTOSHOP WHATSAPP BRIDGE');
  console.log('='.repeat(52));
  console.log(`🌐 URL:         http://localhost:${PORT}`);
  console.log(`🔒 Auth key:    ${API_KEY ? 'Enabled' : 'Disabled (no WA_API_KEY set)'}`);
  console.log(`⏱  Send delay:  ${SEND_DELAY}ms between bulk messages`);
  console.log(`🔁 Max retries: ${MAX_RETRIES} per message`);
  console.log('='.repeat(52));
  console.log('\nEndpoints:');
  console.log(`  GET  /health            — health check`);
  console.log(`  GET  /api/status        — connection status`);
  console.log(`  GET  /api/qr            — get QR code image`);
  console.log(`  GET  /api/log           — last 100 sent messages`);
  console.log(`  POST /api/send          — send a single message`);
  console.log(`  POST /api/send-bulk     — send to multiple recipients`);
  console.log(`  POST /api/disconnect    — log out`);
  console.log('\nStarting WhatsApp client…\n');

  initClient();
});

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\n\n🛑 Shutting down bridge…');
  try { await client?.destroy(); } catch {}
  process.exit(0);
});