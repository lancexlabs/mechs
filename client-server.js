/**
 * ============================================================
 * VELO SHOP SERVER - Client Server (Port 3002)
 * ============================================================
 * Per-shop instance server. All data is persisted to the
 * shop's own Supabase instance using credentials fetched from
 * the central license server at activation time.
 *
 * HOW TO RUN:
 *   npm install express cors jsonwebtoken bcrypt cookie-parser @supabase/supabase-js
 *   node client-server.js
 *
 * Depends on central-server.js running on port 3001.
 * ============================================================
 */

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = 3002;
const CENTRAL_SERVER = 'http://localhost:3001';
const JWT_SECRET = 'velo-shop-jwt-secret-2024-change-in-prod';
const SALT_ROUNDS = 10;

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(cookieParser());

// ─────────────────────────────────────────────
// SHOP STATE (in-memory, populated at activation / boot)
// Only metadata — all real data lives in Supabase
// ─────────────────────────────────────────────
let shopState = null;       // { id, license_key, name, phone, email, address, plan, ... }
let supabase = null;        // Supabase client, created after activation

// Cached license state (refreshed periodically)
let licenseCache = null;
let licenseCacheTime = 0;
const LICENSE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ─────────────────────────────────────────────
// HELPERS: SUPABASE CLIENT
// ─────────────────────────────────────────────
function getSupabase() {
  if (!supabase) throw new Error('Supabase not initialised. Shop not activated.');
  return supabase;
}

function initSupabase(url, anonKey) {
  supabase = createClient(url, anonKey, { auth: { persistSession: false } });
  console.log('[Supabase] Client initialised for', url.replace(/^(https?:\/\/[^.]+).*/, '$1…'));
}

// ─────────────────────────────────────────────
// PERSISTENCE: shop_state.json survives restarts
// ─────────────────────────────────────────────
const fs = require('fs');
const STATE_FILE = './shop_state.json';

function persistShopState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      id: state.id,
      license_key: state.license_key,
      supabase_url: state.supabase_url,
      supabase_anon_key: state.supabase_anon_key
    }));
    console.log('[BOOT] Shop state persisted to', STATE_FILE);
  } catch (e) {
    console.error('[BOOT] Could not write state file:', e.message);
  }
}

async function bootRehydrate() {
  if (!fs.existsSync(STATE_FILE)) {
    console.log('[BOOT] No saved shop state. Waiting for activation via /api/setup.');
    return;
  }
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!saved.supabase_url || !saved.supabase_anon_key || !saved.id) {
      console.warn('[BOOT] State file incomplete — waiting for re-activation.');
      return;
    }
    initSupabase(saved.supabase_url, saved.supabase_anon_key);
    const sb = getSupabase();
    const { data: shopRow, error } = await sb.from('shops').select('*').eq('id', saved.id).maybeSingle();
    if (!error && shopRow) {
      shopState = shopRow;
      console.log(`[BOOT] Re-hydrated shop "${shopState.name}" (${shopState.id}) from Supabase.`);
    } else {
      console.warn('[BOOT] Shop row not found in Supabase — may need re-activation.', error?.message || '');
      supabase = null; // don't leave a broken client
    }
  } catch (e) {
    console.error('[BOOT] Failed to rehydrate:', e.message);
  }
}

// ─────────────────────────────────────────────
// HELPERS: HTTP REQUEST TO CENTRAL SERVER
// ─────────────────────────────────────────────
function centralPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'localhost', port: 3001, path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 8000
    };
    const req = http.request(options, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ statusCode: res.statusCode, body: { error: 'Invalid JSON' } }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Central server timed out')); });
    req.write(data);
    req.end();
  });
}

function generateShopId() {
  return 'SHOP-' + crypto.randomBytes(6).toString('hex').toUpperCase();
}

function getShop() { return shopState; }
function isActivated() { return !!shopState; }

// ─────────────────────────────────────────────
// VALIDATE LICENSE (with cache)
// ─────────────────────────────────────────────
async function validateLicense(forceRefresh = false) {
  const shop = getShop();
  if (!shop) return { valid: false, error: 'Shop not activated' };

  const now = Date.now();
  if (!forceRefresh && licenseCache && (now - licenseCacheTime) < LICENSE_CACHE_TTL) {
    return licenseCache;
  }

  try {
    const result = await centralPost('/api/validate-license', {
      license_key: shop.license_key,
      shop_id: shop.id,
      action: 'heartbeat'
    });
    if (result.statusCode === 200 && result.body.valid) {
      licenseCache = { valid: true, license: result.body.license };
    } else {
      licenseCache = { valid: false, error: result.body.error || 'License invalid' };
    }
    licenseCacheTime = now;
    return licenseCache;
  } catch (err) {
    console.error('[validateLicense] Central server unreachable:', err.message);
    if (licenseCache && (now - licenseCacheTime) < 30 * 60 * 1000) {
      return { ...licenseCache, warning: 'Using cached license data (central server unreachable)' };
    }
    return { valid: false, error: 'Cannot reach license server.' };
  }
}

// ─────────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────────
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : req.cookies?.shop_token;
  if (!token) return res.status(401).json({ success: false, error: 'Unauthorized: No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid or expired token' });
  }
}

function requireActivation(req, res, next) {
  if (!isActivated()) {
    return res.status(403).json({ success: false, error: 'Shop not activated.', needs_activation: true });
  }
  next();
}

// ─────────────────────────────────────────────
// ROUTE: HEALTH CHECK
// ─────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const shop = getShop();
  let counts = { users: 0, jobs: 0, mechanics: 0, customers: 0 };
  if (shop && supabase) {
    const sb = getSupabase();
    const [j, m, c] = await Promise.all([
      sb.from('jobs').select('*', { count: 'exact', head: true }).eq('shop_id', shop.id),
      sb.from('mechanics').select('*', { count: 'exact', head: true }).eq('shop_id', shop.id),
      sb.from('customers').select('*', { count: 'exact', head: true }).eq('shop_id', shop.id)
    ]);
    counts = { jobs: j.count || 0, mechanics: m.count || 0, customers: c.count || 0 };
  }
  res.json({
    status: 'ok', server: 'VELO Shop Server', port: PORT,
    activated: isActivated(), shop_name: shop?.name || null,
    uptime: process.uptime(), timestamp: new Date().toISOString(),
    storage: 'supabase', stats: counts
  });
});

// ─────────────────────────────────────────────
// ROUTE: SETUP / ACTIVATE LICENSE
// ─────────────────────────────────────────────
app.post('/api/setup', async (req, res) => {
  try {
    if (isActivated()) {
      return res.status(400).json({ success: false, error: 'This shop instance is already activated.' });
    }

    const { licenseKey, shopName, shopPhone, shopEmail, shopAddress, adminPin } = req.body;
    if (!licenseKey || !adminPin) {
      return res.status(400).json({ success: false, error: 'licenseKey and adminPin are required' });
    }

    const pinStr = String(adminPin).trim();
    if (!/^\d{4,8}$/.test(pinStr)) {
      return res.status(400).json({ success: false, error: 'Admin PIN must be 4-8 digits' });
    }

    // Step 1: Fetch credentials from central server
    let credResult;
    try {
      credResult = await centralPost('/api/license-credentials', {
        license_key: licenseKey.trim().toUpperCase(),
        admin_password: pinStr
      });
    } catch (err) {
      return res.status(503).json({ success: false, error: 'Cannot reach central license server.' });
    }

    if (credResult.statusCode !== 200 || !credResult.body.success) {
      return res.status(credResult.statusCode || 400).json({
        success: false, error: credResult.body.error || 'License validation failed'
      });
    }

    const creds = credResult.body.credentials;

    if (!creds.supabase_url || !creds.supabase_anon_key) {
      return res.status(400).json({ success: false, error: 'License has no Supabase credentials configured. Contact your license admin.' });
    }

    // Step 2: Initialise Supabase with the license credentials
    initSupabase(creds.supabase_url, creds.supabase_anon_key);
    const sb = getSupabase();

    const shopId = generateShopId();

    // Step 3: Register activation with central server
    let activateResult;
    try {
      activateResult = await centralPost('/api/validate-license', {
        license_key: creds.license_key,
        shop_id: shopId,
        action: 'activate'
      });
    } catch {
      return res.status(503).json({ success: false, error: 'Cannot activate license: central server unreachable' });
    }

    if (activateResult.statusCode !== 200 || !activateResult.body.valid) {
      return res.status(403).json({ success: false, error: activateResult.body.error || 'Activation failed' });
    }

    // Step 4: Upsert shop row into Supabase
    const shopRecord = {
      id: shopId,
      license_key: creds.license_key,
      name: (shopName || creds.shop_name || 'My Bike Shop').trim(),
      phone: (shopPhone || '').trim(),
      email: (shopEmail || '').trim(),
      address: (shopAddress || creds.shop_address || '').trim(),
      plan: creds.plan,
      max_seats: creds.max_seats,
      features: creds.features,
      expires_at: creds.expires_at,
      supabase_url: creds.supabase_url,
      supabase_anon_key: creds.supabase_anon_key,
      currency: 'INR',
      wa_url: '',
      silent_whatsapp: false
    };

    const { error: shopErr } = await sb.from('shops').upsert(shopRecord);
    if (shopErr) throw new Error('Failed to save shop: ' + shopErr.message);

    // Step 5: Create admin user in Supabase
    const { data: existingUser } = await sb.from('users')
      .select('id').eq('shop_id', shopId).eq('username', creds.admin_username).maybeSingle();

    if (!existingUser) {
      const { error: userErr } = await sb.from('users').insert({
        shop_id: shopId,
        username: creds.admin_username,
        password_hash: creds.admin_password_hash,
        full_name: creds.admin_full_name || creds.client_name,
        email: creds.client_email || '',
        phone: creds.client_phone || '',
        role: 'admin'
      });
      if (userErr) throw new Error('Failed to create admin user: ' + userErr.message);
    }

    // Step 6: Seed demo data if shop is brand new
    await seedDemoData(sb, shopId);

    // Step 7: Load into memory and persist to disk for restarts
    shopState = shopRecord;
    persistShopState(shopRecord);

    console.log(`[SETUP] Shop activated: ${shopRecord.name} (${shopId}) → Supabase`);

    res.json({
      success: true,
      message: 'Shop activated successfully!',
      shop: { id: shopId, name: shopRecord.name, plan: creds.plan, expires_at: creds.expires_at }
    });
  } catch (err) {
    console.error('[POST /api/setup]', err);
    // Reset supabase client if activation failed
    supabase = null;
    res.status(500).json({ success: false, error: 'Server error during setup: ' + err.message });
  }
});

// ─────────────────────────────────────────────
// SEED DEMO DATA
// ─────────────────────────────────────────────
async function seedDemoData(sb, shopId) {
  // Only seed if no mechanics exist yet for this shop
  const { count } = await sb.from('mechanics')
    .select('*', { count: 'exact', head: true }).eq('shop_id', shopId);
  if (count > 0) return;

  const now = new Date().toISOString();
  await sb.from('mechanics').insert([
    { shop_id: shopId, name: 'Ravi Kumar', phone: '9876543210', speciality: 'Engine & Transmission', is_active: true, jobs_completed: 0, created_at: now },
    { shop_id: shopId, name: 'Suresh Nair', phone: '9876543211', speciality: 'Electrical & Wiring', is_active: true, jobs_completed: 0, created_at: now }
  ]);
  await sb.from('customers').insert([
    { shop_id: shopId, name: 'Demo Customer', phone: '9000000000', email: 'demo@example.com', address: 'Chennai', total_jobs: 0, total_spent: 0, created_at: now }
  ]);
}

// ─────────────────────────────────────────────
// ROUTE: AUTH
// ─────────────────────────────────────────────
app.post('/api/auth/login', requireActivation, async (req, res) => {
  try {
    const { username, pin } = req.body;
    if (!username || !pin) {
      return res.status(400).json({ success: false, error: 'Username and PIN are required' });
    }

    const shop = getShop();
    const sb = getSupabase();

    const { data: user, error } = await sb.from('users')
      .select('*')
      .eq('shop_id', shop.id)
      .ilike('username', username.trim())
      .maybeSingle();

    if (error || !user) {
      return res.status(401).json({ success: false, error: 'Invalid username or PIN' });
    }

    const isValid = await bcrypt.compare(String(pin).trim(), user.password_hash);
    if (!isValid) {
      return res.status(401).json({ success: false, error: 'Invalid username or PIN' });
    }

    const licenseCheck = await validateLicense(false);
    if (!licenseCheck.valid) {
      return res.status(403).json({ success: false, error: `License error: ${licenseCheck.error}` });
    }

    const token = jwt.sign(
      { id: user.id, shop_id: shop.id, username: user.username, role: user.role },
      JWT_SECRET, { expiresIn: '12h' }
    );

    res.json({
      success: true, token,
      user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role },
      shop: { id: shop.id, name: shop.name, plan: shop.plan }
    });
  } catch (err) {
    console.error('[POST /api/auth/login]', err);
    res.status(500).json({ success: false, error: 'Server error during login' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('shop_token');
  res.json({ success: true, message: 'Logged out' });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const sb = getSupabase();
    const { data: user } = await sb.from('users').select('id,username,full_name,email,phone,role').eq('id', req.user.id).maybeSingle();
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    const shop = getShop();
    res.json({ success: true, user, shop: shop ? { id: shop.id, name: shop.name, plan: shop.plan, expires_at: shop.expires_at } : null });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error fetching user' });
  }
});

// ─────────────────────────────────────────────
// ROUTE: SHOP CONFIG
// ─────────────────────────────────────────────
app.get('/api/shop/config', requireActivation, requireAuth, async (req, res) => {
  try {
    const shop = getShop();
    const sb = getSupabase();
    const { data: row } = await sb.from('shops').select('*').eq('id', shop.id).maybeSingle();
    if (!row) return res.status(404).json({ success: false, error: 'Shop config not found' });
    res.json({
      success: true,
      config: {
        shop_name: row.name, shop_phone: row.phone, shop_email: row.email,
        currency: row.currency || 'INR', wa_url: row.wa_url || '', silent_whatsapp: !!row.silent_whatsapp
      },
      shop: { name: row.name, plan: row.plan, expires_at: row.expires_at }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error fetching config' });
  }
});

app.put('/api/shop/config', requireActivation, requireAuth, async (req, res) => {
  try {
    const shop = getShop();
    const sb = getSupabase();
    const { shop_name, shop_phone, shop_email, currency, wa_url, silent_whatsapp } = req.body;

    const updates = {};
    if (shop_name !== undefined) updates.name = shop_name;
    if (shop_phone !== undefined) updates.phone = shop_phone;
    if (shop_email !== undefined) updates.email = shop_email;
    if (currency !== undefined) updates.currency = currency;
    if (wa_url !== undefined) updates.wa_url = wa_url;
    if (silent_whatsapp !== undefined) updates.silent_whatsapp = Boolean(silent_whatsapp);

    const { data: updated, error } = await sb.from('shops').update(updates).eq('id', shop.id).select().maybeSingle();
    if (error) throw error;

    // Keep in-memory state in sync
    Object.assign(shopState, updates);
    if (shop_name) shopState.name = shop_name;

    res.json({ success: true, message: 'Settings saved', config: { shop_name: updated.name, shop_phone: updated.phone, shop_email: updated.email, currency: updated.currency, wa_url: updated.wa_url, silent_whatsapp: updated.silent_whatsapp } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error saving config' });
  }
});

// ─────────────────────────────────────────────
// ROUTE: DASHBOARD STATS
// ─────────────────────────────────────────────
app.get('/api/dashboard/stats', requireActivation, requireAuth, async (req, res) => {
  try {
    const shop = getShop();
    const sb = getSupabase();

    const { data: allJobs } = await sb.from('jobs').select('*').eq('shop_id', shop.id);
    const jobs = allJobs || [];

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const openJobs = jobs.filter(j => j.status !== 'DELIVERED').length;
    const doneToday = jobs.filter(j => j.status === 'DELIVERED' && j.completed_at && new Date(j.completed_at) >= today).length;
    const overdueJobs = jobs.filter(j => {
      if (j.status === 'DELIVERED' || !j.sla_hours) return false;
      return new Date() > new Date(new Date(j.created_at).getTime() + j.sla_hours * 3600000);
    }).length;
    const revenueToday = jobs
      .filter(j => j.status === 'DELIVERED' && j.completed_at && new Date(j.completed_at) >= today)
      .reduce((s, j) => s + (parseFloat(j.actual_cost) || 0), 0);

    // Recent 5 jobs enriched with customer/mechanic names
    const recentJobIds = [...jobs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 5);
    const custIds = [...new Set(recentJobIds.map(j => j.cust_id).filter(Boolean))];
    const mechIds = [...new Set(recentJobIds.map(j => j.mech_id).filter(Boolean))];

    const [custsRes, mechsRes] = await Promise.all([
      custIds.length ? sb.from('customers').select('id,name,phone').in('id', custIds) : { data: [] },
      mechIds.length ? sb.from('mechanics').select('id,name').in('id', mechIds) : { data: [] }
    ]);
    const custMap = Object.fromEntries((custsRes.data || []).map(c => [c.id, c]));
    const mechMap = Object.fromEntries((mechsRes.data || []).map(m => [m.id, m]));

    const recentJobs = recentJobIds.map(j => ({
      ...j,
      customer_name: custMap[j.cust_id]?.name || 'Unknown',
      customer_phone: custMap[j.cust_id]?.phone || '',
      mechanic_name: mechMap[j.mech_id]?.name || 'Unassigned'
    }));

    // Mechanic load
    const { data: activeMechs } = await sb.from('mechanics').select('id,name,speciality').eq('shop_id', shop.id).eq('is_active', true);
    const mechanicLoad = (activeMechs || []).map(m => ({
      ...m,
      active_jobs: jobs.filter(j => j.mech_id === m.id && j.status !== 'DELIVERED').length
    }));

    res.json({
      success: true,
      stats: { open_jobs: openJobs, overdue: overdueJobs, done_today: doneToday, revenue_today: revenueToday },
      recent_jobs: recentJobs,
      mechanic_load: mechanicLoad
    });
  } catch (err) {
    console.error('[GET /api/dashboard/stats]', err);
    res.status(500).json({ success: false, error: 'Error fetching stats' });
  }
});

// ─────────────────────────────────────────────
// ROUTE: JOBS CRUD
// ─────────────────────────────────────────────
app.get('/api/jobs', requireActivation, requireAuth, async (req, res) => {
  try {
    const shop = getShop();
    const sb = getSupabase();
    const { status, cust_id, mech_id } = req.query;

    let query = sb.from('jobs').select('*').eq('shop_id', shop.id).order('created_at', { ascending: false });
    if (status) query = query.eq('status', status.toUpperCase());
    if (cust_id) query = query.eq('cust_id', parseInt(cust_id));
    if (mech_id) query = query.eq('mech_id', parseInt(mech_id));

    const { data: jobs, error } = await query;
    if (error) throw error;

    const custIds = [...new Set((jobs || []).map(j => j.cust_id).filter(Boolean))];
    const mechIds = [...new Set((jobs || []).map(j => j.mech_id).filter(Boolean))];
    const [custsRes, mechsRes] = await Promise.all([
      custIds.length ? sb.from('customers').select('id,name,phone').in('id', custIds) : { data: [] },
      mechIds.length ? sb.from('mechanics').select('id,name').in('id', mechIds) : { data: [] }
    ]);
    const custMap = Object.fromEntries((custsRes.data || []).map(c => [c.id, c]));
    const mechMap = Object.fromEntries((mechsRes.data || []).map(m => [m.id, m]));

    const enriched = (jobs || []).map(j => ({
      ...j,
      customer_name: custMap[j.cust_id]?.name || 'Unknown',
      customer_phone: custMap[j.cust_id]?.phone || '',
      mechanic_name: mechMap[j.mech_id]?.name || 'Unassigned'
    }));

    res.json({ success: true, jobs: enriched, total: enriched.length });
  } catch (err) {
    console.error('[GET /api/jobs]', err);
    res.status(500).json({ success: false, error: 'Error fetching jobs' });
  }
});

app.post('/api/jobs', requireActivation, requireAuth, async (req, res) => {
  try {
    const shop = getShop();
    const sb = getSupabase();
    const { bike, cust_id, mech_id, type, status, sla_hours, issue, actual_cost } = req.body;

    if (!bike || !cust_id) {
      return res.status(400).json({ success: false, error: 'bike and cust_id are required' });
    }

    const { data: customer, error: custErr } = await sb.from('customers')
      .select('id,name').eq('id', parseInt(cust_id)).eq('shop_id', shop.id).maybeSingle();
    if (custErr || !customer) return res.status(400).json({ success: false, error: 'Customer not found' });

    if (mech_id) {
      const { data: mech } = await sb.from('mechanics').select('id').eq('id', parseInt(mech_id)).eq('shop_id', shop.id).maybeSingle();
      if (!mech) return res.status(400).json({ success: false, error: 'Mechanic not found' });
    }

    const validStatuses = ['PENDING', 'IN_PROGRESS', 'READY', 'DELIVERED'];
    const jobStatus = validStatuses.includes((status || '').toUpperCase()) ? status.toUpperCase() : 'PENDING';

    const { data: newJob, error } = await sb.from('jobs').insert({
      shop_id: shop.id,
      bike: bike.trim(),
      cust_id: parseInt(cust_id),
      mech_id: mech_id ? parseInt(mech_id) : null,
      type: (type || 'general').trim(),
      status: jobStatus,
      sla_hours: parseInt(sla_hours) || 24,
      issue: (issue || '').trim(),
      actual_cost: parseFloat(actual_cost) || 0,
      completed_at: jobStatus === 'DELIVERED' ? new Date().toISOString() : null
    }).select().single();
    if (error) throw error;

    // Update customer total_jobs
    await sb.from('customers').update({ total_jobs: customer.total_jobs + 1 }).eq('id', customer.id);

    const mechName = mech_id
      ? (await sb.from('mechanics').select('name').eq('id', parseInt(mech_id)).maybeSingle()).data?.name || 'Unassigned'
      : 'Unassigned';

    res.status(201).json({ success: true, message: 'Job created', job: { ...newJob, customer_name: customer.name, mechanic_name: mechName } });
  } catch (err) {
    console.error('[POST /api/jobs]', err);
    res.status(500).json({ success: false, error: 'Error creating job' });
  }
});

app.put('/api/jobs/:id', requireActivation, requireAuth, async (req, res) => {
  try {
    const shop = getShop();
    const sb = getSupabase();
    const jobId = parseInt(req.params.id);

    const { data: existingJob } = await sb.from('jobs').select('*').eq('id', jobId).eq('shop_id', shop.id).maybeSingle();
    if (!existingJob) return res.status(404).json({ success: false, error: 'Job not found' });

    const { bike, cust_id, mech_id, type, status, sla_hours, issue, actual_cost } = req.body;
    const validStatuses = ['PENDING', 'IN_PROGRESS', 'READY', 'DELIVERED'];
    const updates = { updated_at: new Date().toISOString() };

    if (bike !== undefined) updates.bike = bike.trim();
    if (cust_id !== undefined) updates.cust_id = parseInt(cust_id);
    if (mech_id !== undefined) updates.mech_id = mech_id ? parseInt(mech_id) : null;
    if (type !== undefined) updates.type = type.trim();
    if (status !== undefined && validStatuses.includes(status.toUpperCase())) updates.status = status.toUpperCase();
    if (sla_hours !== undefined) updates.sla_hours = parseInt(sla_hours);
    if (issue !== undefined) updates.issue = issue.trim();
    if (actual_cost !== undefined) updates.actual_cost = parseFloat(actual_cost) || 0;

    const wasDelivered = existingJob.status === 'DELIVERED';
    const nowDelivered = updates.status === 'DELIVERED';

    if (nowDelivered && !wasDelivered) {
      updates.completed_at = new Date().toISOString();
      // Update mechanic jobs_completed
      const mechIdToUse = updates.mech_id ?? existingJob.mech_id;
      if (mechIdToUse) {
        const { data: mech } = await sb.from('mechanics').select('jobs_completed').eq('id', mechIdToUse).maybeSingle();
        if (mech) await sb.from('mechanics').update({ jobs_completed: (mech.jobs_completed || 0) + 1 }).eq('id', mechIdToUse);
      }
      // Update customer total_spent
      const custIdToUse = updates.cust_id ?? existingJob.cust_id;
      const { data: cust } = await sb.from('customers').select('total_spent').eq('id', custIdToUse).maybeSingle();
      if (cust) await sb.from('customers').update({ total_spent: (cust.total_spent || 0) + (updates.actual_cost ?? existingJob.actual_cost) }).eq('id', custIdToUse);
    }

    const { data: updatedJob, error } = await sb.from('jobs').update(updates).eq('id', jobId).select().single();
    if (error) throw error;

    const custId = updatedJob.cust_id;
    const mechId = updatedJob.mech_id;
    const [custRes, mechRes] = await Promise.all([
      sb.from('customers').select('name').eq('id', custId).maybeSingle(),
      mechId ? sb.from('mechanics').select('name').eq('id', mechId).maybeSingle() : { data: null }
    ]);

    res.json({
      success: true, message: 'Job updated',
      job: { ...updatedJob, customer_name: custRes.data?.name || 'Unknown', mechanic_name: mechRes.data?.name || 'Unassigned' }
    });
  } catch (err) {
    console.error('[PUT /api/jobs/:id]', err);
    res.status(500).json({ success: false, error: 'Error updating job' });
  }
});

app.delete('/api/jobs/:id', requireActivation, requireAuth, async (req, res) => {
  try {
    const shop = getShop();
    const sb = getSupabase();
    const { error } = await sb.from('jobs').delete().eq('id', parseInt(req.params.id)).eq('shop_id', shop.id);
    if (error) throw error;
    res.json({ success: true, message: 'Job deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error deleting job' });
  }
});

// ─────────────────────────────────────────────
// ROUTE: MECHANICS CRUD
// ─────────────────────────────────────────────
app.get('/api/mechanics', requireActivation, requireAuth, async (req, res) => {
  try {
    const shop = getShop();
    const sb = getSupabase();
    const { data: mechanics, error } = await sb.from('mechanics').select('*').eq('shop_id', shop.id).order('created_at');
    if (error) throw error;

    const { data: jobs } = await sb.from('jobs').select('mech_id,status').eq('shop_id', shop.id).neq('status', 'DELIVERED');
    const enriched = (mechanics || []).map(m => ({
      ...m,
      active_jobs: (jobs || []).filter(j => j.mech_id === m.id).length
    }));

    res.json({ success: true, mechanics: enriched, total: enriched.length });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error fetching mechanics' });
  }
});

app.post('/api/mechanics', requireActivation, requireAuth, async (req, res) => {
  try {
    const shop = getShop();
    const sb = getSupabase();
    const { name, phone, speciality } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'name is required' });

    const { data, error } = await sb.from('mechanics').insert({
      shop_id: shop.id, name: name.trim(),
      phone: (phone || '').trim(), speciality: (speciality || 'General').trim(),
      is_active: true, jobs_completed: 0
    }).select().single();
    if (error) throw error;

    res.status(201).json({ success: true, message: 'Mechanic added', mechanic: data });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error adding mechanic' });
  }
});

app.put('/api/mechanics/:id', requireActivation, requireAuth, async (req, res) => {
  try {
    const shop = getShop();
    const sb = getSupabase();
    const { name, phone, speciality, is_active } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name.trim();
    if (phone !== undefined) updates.phone = phone.trim();
    if (speciality !== undefined) updates.speciality = speciality.trim();
    if (is_active !== undefined) updates.is_active = Boolean(is_active);

    const { data, error } = await sb.from('mechanics').update(updates)
      .eq('id', parseInt(req.params.id)).eq('shop_id', shop.id).select().single();
    if (error) throw error;
    res.json({ success: true, message: 'Mechanic updated', mechanic: data });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error updating mechanic' });
  }
});

app.delete('/api/mechanics/:id', requireActivation, requireAuth, async (req, res) => {
  try {
    const shop = getShop();
    const sb = getSupabase();
    const mechId = parseInt(req.params.id);

    const { count } = await sb.from('jobs').select('*', { count: 'exact', head: true })
      .eq('mech_id', mechId).eq('shop_id', shop.id).neq('status', 'DELIVERED');
    if (count > 0) return res.status(400).json({ success: false, error: `Cannot delete mechanic with ${count} active job(s). Reassign jobs first.` });

    const { error } = await sb.from('mechanics').delete().eq('id', mechId).eq('shop_id', shop.id);
    if (error) throw error;
    res.json({ success: true, message: 'Mechanic deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error deleting mechanic' });
  }
});

// ─────────────────────────────────────────────
// ROUTE: CUSTOMERS CRUD
// ─────────────────────────────────────────────
app.get('/api/customers', requireActivation, requireAuth, async (req, res) => {
  try {
    const shop = getShop();
    const sb = getSupabase();
    const { search } = req.query;

    let query = sb.from('customers').select('*').eq('shop_id', shop.id).order('created_at', { ascending: false });
    if (search) {
      const q = search.trim();
      query = query.or(`name.ilike.%${q}%,phone.ilike.%${q}%,email.ilike.%${q}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, customers: data || [], total: (data || []).length });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error fetching customers' });
  }
});

app.post('/api/customers', requireActivation, requireAuth, async (req, res) => {
  try {
    const shop = getShop();
    const sb = getSupabase();
    const { name, phone, email, address } = req.body;
    if (!name || !phone) return res.status(400).json({ success: false, error: 'name and phone are required' });

    // Phone uniqueness per shop
    const { data: existing } = await sb.from('customers').select('id').eq('shop_id', shop.id).eq('phone', phone.trim()).maybeSingle();
    if (existing) return res.status(409).json({ success: false, error: `Customer with phone ${phone} already exists` });

    const { data, error } = await sb.from('customers').insert({
      shop_id: shop.id, name: name.trim(), phone: phone.trim(),
      email: (email || '').trim(), address: (address || '').trim(),
      total_jobs: 0, total_spent: 0
    }).select().single();
    if (error) throw error;

    res.status(201).json({ success: true, message: 'Customer added', customer: data });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error adding customer' });
  }
});

app.put('/api/customers/:id', requireActivation, requireAuth, async (req, res) => {
  try {
    const shop = getShop();
    const sb = getSupabase();
    const { name, phone, email, address } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name.trim();
    if (phone !== undefined) updates.phone = phone.trim();
    if (email !== undefined) updates.email = email.trim();
    if (address !== undefined) updates.address = address.trim();

    const { data, error } = await sb.from('customers').update(updates)
      .eq('id', parseInt(req.params.id)).eq('shop_id', shop.id).select().single();
    if (error) throw error;
    res.json({ success: true, message: 'Customer updated', customer: data });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error updating customer' });
  }
});

app.delete('/api/customers/:id', requireActivation, requireAuth, async (req, res) => {
  try {
    const shop = getShop();
    const sb = getSupabase();
    const custId = parseInt(req.params.id);

    const { count } = await sb.from('jobs').select('*', { count: 'exact', head: true })
      .eq('cust_id', custId).eq('shop_id', shop.id).neq('status', 'DELIVERED');
    if (count > 0) return res.status(400).json({ success: false, error: `Cannot delete customer with ${count} active job(s)` });

    const { error } = await sb.from('customers').delete().eq('id', custId).eq('shop_id', shop.id);
    if (error) throw error;
    res.json({ success: true, message: 'Customer deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error deleting customer' });
  }
});

// ─────────────────────────────────────────────
// ROUTE: LICENSE INFO
// ─────────────────────────────────────────────
app.get('/api/license/info', requireActivation, requireAuth, async (req, res) => {
  try {
    const shop = getShop();
    const licenseCheck = await validateLicense(true);
    res.json({
      success: true,
      shop: { id: shop.id, name: shop.name, plan: shop.plan },
      license: licenseCheck.valid ? licenseCheck.license : null,
      license_key: shop.license_key,
      valid: licenseCheck.valid,
      error: licenseCheck.error || null,
      warning: licenseCheck.warning || null
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error fetching license info' });
  }
});

app.get('/api/license/status', (req, res) => {
  const shop = getShop();
  res.json({ success: true, activated: isActivated(), shop_name: shop?.name || null });
});

// ─────────────────────────────────────────────
// ROUTE: WHATSAPP STATUS
// ─────────────────────────────────────────────
app.get('/api/whatsapp/status', requireActivation, requireAuth, async (req, res) => {
  try {
    const shop = getShop();
    const licenseCheck = await validateLicense(false);
    const waEnabled = licenseCheck.valid && licenseCheck.license?.whatsapp_enabled;
    res.json({
      success: true,
      whatsapp_enabled: Boolean(waEnabled),
      wa_url: shop.wa_url || '',
      message: waEnabled ? 'WhatsApp is enabled via Twilio' : 'WhatsApp is not enabled for this license plan'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error checking WhatsApp status' });
  }
});

// ─────────────────────────────────────────────
// ROUTE: SUPABASE STATUS / CONNECTION CHECK
// ─────────────────────────────────────────────
app.get('/api/status', requireActivation, requireAuth, async (req, res) => {
  const shop = getShop();
  const supabaseUrl = shop?.supabase_url;
  const supabaseKey = shop?.supabase_anon_key;

  if (!supabaseUrl || !supabaseKey) {
    return res.json({ status: 'ok', supabase: 'not_configured', message: 'Supabase credentials not found in shop license.' });
  }

  const t0 = Date.now();
  try {
    const https = require('https');
    const httpM = require('http');
    const urlObj = new URL(supabaseUrl.replace(/\/$/, '') + '/rest/v1/');
    const transport = urlObj.protocol === 'https:' ? https : httpM;

    const pingResult = await new Promise((resolve, reject) => {
      const pingReq = transport.request({
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname, method: 'GET',
        headers: { 'apikey': supabaseKey, 'Authorization': 'Bearer ' + supabaseKey },
        timeout: 6000
      }, (pingRes) => {
        let body = '';
        pingRes.on('data', c => { body += c; });
        pingRes.on('end', () => resolve({ statusCode: pingRes.statusCode, body }));
      });
      pingReq.on('error', reject);
      pingReq.on('timeout', () => { pingReq.destroy(); reject(new Error('Supabase connection timed out')); });
      pingReq.end();
    });

    const latencyMs = Date.now() - t0;
    const connected = pingResult.statusCode < 500;
    return res.json({
      status: 'ok', supabase: connected ? 'connected' : 'error',
      supabase_url: supabaseUrl.replace(/^(https?:\/\/[^.]+).*/, '$1…'),
      latency_ms: latencyMs, http_status: pingResult.statusCode,
      message: connected ? `Supabase reachable (${latencyMs}ms)` : `Supabase returned HTTP ${pingResult.statusCode}`
    });
  } catch (err) {
    return res.json({ status: 'ok', supabase: 'disconnected', latency_ms: Date.now() - t0, message: err.message || 'Cannot reach Supabase' });
  }
});

app.get('/api/license-db/status', requireActivation, requireAuth, async (req, res) => {
  // Ping the central server's public health endpoint — no auth token needed
  const t0 = Date.now();
  try {
    const result = await new Promise((resolve, reject) => {
      const req2 = http.request(
        { hostname: 'localhost', port: 3001, path: '/health', method: 'GET', timeout: 5000 },
        (res2) => {
          let b = '';
          res2.on('data', c => { b += c; });
          res2.on('end', () => {
            try { resolve({ statusCode: res2.statusCode, body: JSON.parse(b) }); }
            catch { resolve({ statusCode: res2.statusCode, body: {} }); }
          });
        }
      );
      req2.on('error', reject);
      req2.on('timeout', () => { req2.destroy(); reject(new Error('Central server timed out')); });
      req2.end();
    });

    const latencyMs = Date.now() - t0;
    const connected = result.statusCode === 200;
    res.json({
      status: 'ok',
      supabase: connected ? 'connected' : 'error',
      supabase_url: 'Central License Server (localhost:3001)',
      latency_ms: latencyMs,
      message: connected
        ? `Central server reachable (${latencyMs}ms) · ${result.body.stats?.total_licenses ?? '?'} licenses`
        : 'Central server returned HTTP ' + result.statusCode
    });
  } catch (err) {
    res.json({
      status: 'ok',
      supabase: 'disconnected',
      latency_ms: Date.now() - t0,
      message: err.message || 'Cannot reach central license server'
    });
  }
});

// ─────────────────────────────────────────────
// 404 HANDLER
// ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.path}` });
});

// ─────────────────────────────────────────────
// START SERVER — rehydrate first, then listen
// ─────────────────────────────────────────────
bootRehydrate().then(() => {
  app.listen(PORT, () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════╗');
    console.log('║   VELO Shop Server                        ║');
    console.log(`║   Running on http://localhost:${PORT}         ║`);
    console.log('║   Storage: Supabase (from license DB)     ║');
    console.log('║   Requires central-server on port 3001    ║');
    console.log('╚═══════════════════════════════════════════╝');
    console.log('');
  });
}).catch(err => {
  console.error('[BOOT] Fatal error during rehydration:', err.message);
  process.exit(1);
});

module.exports = app;