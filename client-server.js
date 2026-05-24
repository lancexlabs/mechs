require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const jwt          = require('jsonwebtoken');
const bcrypt       = require('bcrypt');
const cookieParser = require('cookie-parser');

const app        = express();
const PORT       = process.env.CLIENT_PORT || 3002;
const JWT_SECRET = process.env.CLIENT_JWT_SECRET || 'client-secret-key-2024';
const IS_PROD    = process.env.NODE_ENV === 'production';

// Allow cookies to be sent from the frontend (same-origin and cross-origin)
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// =====================================================
// SERVER CONFIG
// Priority: env vars (.env file) → in-memory fallback
// =====================================================
let serverConfig = {
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_KEY || ''
};

// =====================================================
// SUPABASE CLIENT (initialized from serverConfig)
// =====================================================
let supabaseClient = null;

function getSupabase() {
  if (supabaseClient) return supabaseClient;
  const url = serverConfig.supabaseUrl;
  const key = serverConfig.supabaseKey;
  if (!url || !key) return null;
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabaseClient = createClient(url, key);
    console.log('✅ Supabase connected');
    return supabaseClient;
  } catch (e) {
    console.warn('⚠️ Supabase init failed:', e.message);
    return null;
  }
}

// =====================================================
// IN-MEMORY FALLBACK (used when Supabase is not configured)
// =====================================================
let shops = [];
let users = [];
let jobs = [];
let mechanics = [];
let customers = [];
let nextId = 1;

function uid()     { return 'J' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 4).toUpperCase(); }
function mechUid() { return 'M' + Date.now().toString(36).toUpperCase(); }
function custUid() { return 'C' + Date.now().toString(36).toUpperCase(); }

// =====================================================
// DB ABSTRACTION — Supabase or in-memory fallback
// =====================================================
const DB = {
  // --- SHOPS ---
  async findShopByLicense(licenseKey) {
    const sb = getSupabase();
    if (sb) {
      const { data } = await sb.from('shops').select('*').eq('license_key', licenseKey).single();
      return data;
    }
    return shops.find(s => s.license_key === licenseKey) || null;
  },
  async createShop(shop) {
    const sb = getSupabase();
    if (sb) {
      const { data, error } = await sb.from('shops').insert(shop).select().single();
      if (error) throw new Error(error.message);
      return data;
    }
    shops.push(shop); return shop;
  },
  async findShopById(id) {
    const sb = getSupabase();
    if (sb) {
      const { data } = await sb.from('shops').select('*').eq('id', id).single();
      return data;
    }
    return shops.find(s => s.id === id) || null;
  },
  async updateShopConfig(shopId, config) {
    const sb = getSupabase();
    if (sb) {
      const { data, error } = await sb.from('shops')
        .update({ config, updated_at: new Date().toISOString() })
        .eq('id', shopId)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data;
    }
    // In-memory fallback
    const index = shops.findIndex(s => s.id === shopId);
    if (index !== -1) {
      shops[index].config = config;
      shops[index].updated_at = new Date().toISOString();
      return shops[index];
    }
    return null;
  },
  async getShopConfig(shopId) {
    const sb = getSupabase();
    if (sb) {
      const { data } = await sb.from('shops').select('config').eq('id', shopId).single();
      return data?.config || {};
    }
    const shop = shops.find(s => s.id === shopId);
    return shop?.config || {};
  },

  // --- USERS ---
  async findUserByUsername(username) {
    const sb = getSupabase();
    if (sb) {
      const { data } = await sb.from('users').select('*').eq('username', username).single();
      return data;
    }
    return users.find(u => u.username === username) || null;
  },
  async createUser(user) {
    const sb = getSupabase();
    if (sb) {
      const { data, error } = await sb.from('users').insert(user).select().single();
      if (error) throw new Error(error.message);
      return data;
    }
    users.push(user); return user;
  },

  // --- JOBS ---
  async getJobs(shopId) {
    const sb = getSupabase();
    if (sb) {
      const { data, error } = await sb.from('jobs').select('*').eq('shop_id', shopId).order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return data || [];
    }
    return jobs.filter(j => j.shop_id === shopId);
  },
  async getJobById(id, shopId) {
    const sb = getSupabase();
    if (sb) {
      const { data } = await sb.from('jobs').select('*').eq('id', id).eq('shop_id', shopId).single();
      return data;
    }
    return jobs.find(j => j.id === id && j.shop_id === shopId) || null;
  },
  async createJob(job) {
    const sb = getSupabase();
    if (sb) {
      const { data, error } = await sb.from('jobs').insert(job).select().single();
      if (error) throw new Error(error.message);
      return data;
    }
    jobs.push(job); return job;
  },
  async updateJob(id, shopId, updates) {
    const sb = getSupabase();
    if (sb) {
      const { data, error } = await sb.from('jobs').update(updates).eq('id', id).eq('shop_id', shopId).select().single();
      if (error) throw new Error(error.message);
      return data;
    }
    const i = jobs.findIndex(j => j.id === id && j.shop_id === shopId);
    if (i === -1) return null;
    jobs[i] = { ...jobs[i], ...updates };
    return jobs[i];
  },
  async deleteJob(id, shopId) {
    const sb = getSupabase();
    if (sb) {
      const { error } = await sb.from('jobs').delete().eq('id', id).eq('shop_id', shopId);
      if (error) throw new Error(error.message);
      return true;
    }
    const i = jobs.findIndex(j => j.id === id && j.shop_id === shopId);
    if (i === -1) return false;
    jobs.splice(i, 1); return true;
  },

  // --- MECHANICS ---
  async getMechanics(shopId) {
    const sb = getSupabase();
    if (sb) {
      const { data, error } = await sb.from('mechanics').select('*').eq('shop_id', shopId);
      if (error) throw new Error(error.message);
      return data || [];
    }
    return mechanics.filter(m => m.shop_id === shopId);
  },
  async createMechanic(mech) {
    const sb = getSupabase();
    if (sb) {
      const { data, error } = await sb.from('mechanics').insert(mech).select().single();
      if (error) throw new Error(error.message);
      return data;
    }
    mechanics.push(mech); return mech;
  },
  async updateMechanic(id, shopId, updates) {
    const sb = getSupabase();
    if (sb) {
      const { data, error } = await sb.from('mechanics').update(updates).eq('id', id).eq('shop_id', shopId).select().single();
      if (error) throw new Error(error.message);
      return data;
    }
    const i = mechanics.findIndex(m => m.id === id && m.shop_id === shopId);
    if (i === -1) return null;
    mechanics[i] = { ...mechanics[i], ...updates };
    return mechanics[i];
  },
  async deleteMechanic(id, shopId) {
    const sb = getSupabase();
    if (sb) {
      const { error } = await sb.from('mechanics').delete().eq('id', id).eq('shop_id', shopId);
      if (error) throw new Error(error.message);
      return true;
    }
    const i = mechanics.findIndex(m => m.id === id && m.shop_id === shopId);
    if (i === -1) return false;
    mechanics.splice(i, 1); return true;
  },

  // --- CUSTOMERS ---
  async getCustomers(shopId) {
    const sb = getSupabase();
    if (sb) {
      const { data, error } = await sb.from('customers').select('*').eq('shop_id', shopId);
      if (error) throw new Error(error.message);
      return data || [];
    }
    return customers.filter(c => c.shop_id === shopId);
  },
  async createCustomer(cust) {
    const sb = getSupabase();
    if (sb) {
      const { data, error } = await sb.from('customers').insert(cust).select().single();
      if (error) throw new Error(error.message);
      return data;
    }
    customers.push(cust); return cust;
  },
  async updateCustomer(id, shopId, updates) {
    const sb = getSupabase();
    if (sb) {
      const { data, error } = await sb.from('customers').update(updates).eq('id', id).eq('shop_id', shopId).select().single();
      if (error) throw new Error(error.message);
      return data;
    }
    const i = customers.findIndex(c => c.id === id && c.shop_id === shopId);
    if (i === -1) return null;
    customers[i] = { ...customers[i], ...updates };
    return customers[i];
  },
  async deleteCustomer(id, shopId) {
    const sb = getSupabase();
    if (sb) {
      const { error } = await sb.from('customers').delete().eq('id', id).eq('shop_id', shopId);
      if (error) throw new Error(error.message);
      return true;
    }
    const i = customers.findIndex(c => c.id === id && c.shop_id === shopId);
    if (i === -1) return false;
    customers.splice(i, 1); return true;
  }
};

// =====================================================
// CONFIG ENDPOINT (update Supabase credentials at runtime)
// =====================================================
app.post('/api/config', authenticate, async (req, res) => {
  const { supabaseUrl, supabaseKey } = req.body;
  if (supabaseUrl !== undefined) serverConfig.supabaseUrl = supabaseUrl;
  if (supabaseKey !== undefined) serverConfig.supabaseKey = supabaseKey;
  supabaseClient = null; // force reconnect with new creds
  const sb = getSupabase();
  console.log('🔧 Config updated — DB mode:', sb ? 'supabase' : 'memory');

  // Persist creds to disk so they survive server restarts
  if (sb && supabaseUrl && supabaseKey) {
    try {
      const fs = require('fs');
      const path = require('path');
      fs.writeFileSync(
        path.join(__dirname, '.supabase-creds.json'),
        JSON.stringify({ supabaseUrl, supabaseKey }, null, 2)
      );
      console.log('💾 Supabase credentials saved to disk (auto-loads on restart)');
    } catch (e) {
      console.warn('⚠️ Could not persist creds to disk:', e.message);
    }
  }

  res.json({ success: true, hasSupabase: !!sb, mode: sb ? 'supabase' : 'memory' });
});

app.get('/api/config', (req, res) => {
  const sb = getSupabase();
  res.json({ hasSupabase: !!sb, mode: sb ? 'supabase' : 'memory' });
});

// =====================================================
// SHOP SETUP
// =====================================================
app.post('/api/setup', async (req, res) => {
  const { licenseKey, shopName, shopPhone, shopEmail, adminName, adminUsername, adminPassword, centralServerUrl } = req.body;
  console.log('🏪 Setting up shop:', shopName);
  try {
    // ── Check local DB: is this license already used here? ──────────────────
    const existingShop = await DB.findShopByLicense(licenseKey);
    if (existingShop) {
      return res.status(400).json({
        error: 'This license key is already activated on this server. Log in instead, or contact support if you need to reset it.'
      });
    }

    // ── Generate stable shop ID (used as activation lock on central server) ─
    const shopId = `shop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    // ── Validate with central server (if URL provided) ──────────────────────
    if (centralServerUrl) {
      try {
        const centralRes = await fetch(`${centralServerUrl.replace(/\/$/, '')}/api/validate-license`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ licenseKey, shopId })
        });
        const centralData = await centralRes.json();
        if (!centralData.valid) {
          return res.status(403).json({ error: `License validation failed: ${centralData.error}` });
        }
        console.log(`✅ License validated via central server (plan: ${centralData.license?.plan})`);
      } catch (centralErr) {
        console.warn('⚠️ Central server unreachable, proceeding with local validation only:', centralErr.message);
        // Don't block setup if central is unreachable — admin can configure this requirement
      }
    }

    const shop = {
      id: shopId,
      name: shopName,
      phone: shopPhone,
      email: shopEmail,
      license_key: licenseKey,
      config: {}, // Initialize empty config
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await DB.createShop(shop);

    const passwordHash = await bcrypt.hash(adminPassword, 10);
    await DB.createUser({
      id: `user_${nextId++}`,
      shop_id: shop.id,
      username: adminUsername.toLowerCase(),
      password_hash: passwordHash,
      full_name: adminName,
      email: shopEmail,
      phone: shopPhone,
      role: 'admin',
      is_active: true,
      created_at: new Date().toISOString()
    });

    // Default mechanics (motorcycle specializations)
    const defaultMechanics = [
      { id: mechUid(), shop_id: shop.id, name: 'Arjun Mehta',   phone: '+91 99001 12345', spec: 'Engine Overhaul',      color: 0, is_active: true, jobs_completed: 0, created_at: new Date().toISOString() },
      { id: mechUid(), shop_id: shop.id, name: 'Priya Sharma',  phone: '+91 98001 23456', spec: 'Suspension & Brakes',  color: 1, is_active: true, jobs_completed: 0, created_at: new Date().toISOString() },
      { id: mechUid(), shop_id: shop.id, name: 'Vikram Das',    phone: '+91 97001 34567', spec: 'General Repairs',      color: 2, is_active: true, jobs_completed: 0, created_at: new Date().toISOString() }
    ];
    for (const m of defaultMechanics) await DB.createMechanic(m);

    // Default customers
    const defaultCustomers = [
      { id: custUid(), shop_id: shop.id, name: 'Rahul Singh',   phone: '+91 80001 11111', since: new Date().toISOString(), total_jobs: 0, total_spent: 0 },
      { id: custUid(), shop_id: shop.id, name: 'Anjali Nair',   phone: '+91 80001 22222', since: new Date().toISOString(), total_jobs: 0, total_spent: 0 },
      { id: custUid(), shop_id: shop.id, name: 'Suresh Kumar',  phone: '+91 80001 33333', since: new Date().toISOString(), total_jobs: 0, total_spent: 0 }
    ];
    for (const c of defaultCustomers) await DB.createCustomer(c);

    console.log(`✅ Shop created: ${shopName} (id: ${shop.id})`);
    res.json({ success: true, shop: { id: shop.id, name: shop.name } });
  } catch (error) {
    console.error('Setup error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// LOGIN  — sets an HTTP-only cookie, returns user info only
// =====================================================
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await DB.findUserByUsername(username.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const shop  = await DB.findShopById(user.shop_id);
    const token = jwt.sign(
      { userId: user.id, shopId: user.shop_id, role: user.role, username: user.username },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Set token as HTTP-only cookie (works when same-origin / production)
    res.cookie('moto_token', token, {
      httpOnly: true,
      secure:   IS_PROD,
      sameSite: IS_PROD ? 'none' : 'lax',
      maxAge:   30 * 24 * 60 * 60 * 1000 // 30 days
    });

    // Also return the token in the body so cross-origin frontends (dev) can store
    // it in sessionStorage and send it as a Bearer header. The cookie is the
    // primary auth in production; the Bearer header is the fallback for dev.
    res.json({ token, user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role, shop } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// LOGOUT — clears the cookie
// =====================================================
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('moto_token', { httpOnly: true, secure: IS_PROD, sameSite: IS_PROD ? 'none' : 'lax' });
  res.json({ success: true });
});

// =====================================================
// SESSION CHECK — lets the frontend restore state after refresh
// =====================================================
app.get('/api/auth/me', async (req, res) => {
  const token = req.cookies?.moto_token;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user    = await DB.findUserByUsername(decoded.username);
    if (!user) return res.status(401).json({ error: 'User not found' });
    const shop    = await DB.findShopById(decoded.shopId);
    res.json({ user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role, shop } });
  } catch {
    res.clearCookie('moto_token');
    res.status(401).json({ error: 'Session expired' });
  }
});

// =====================================================
// AUTH MIDDLEWARE — reads token from cookie (or Bearer header as fallback)
// =====================================================
const authenticate = (req, res, next) => {
  // Cookie takes priority; fall back to Authorization header for API clients
  const token = req.cookies?.moto_token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    req.shopId = decoded.shopId;
    next();
  } catch {
    res.clearCookie('moto_token');
    res.status(401).json({ error: 'Session expired' });
  }
};

// =====================================================
// SHOP CONFIGURATION (Persistent per shop)
// GET  /api/shop/config - Load shop configuration
// PUT  /api/shop/config - Save shop configuration
// =====================================================

/**
 * GET /api/shop/config
 * Returns the shop's configuration (WhatsApp bridge, display settings, etc.)
 * Config is stored in the shops table's config JSONB column.
 */
app.get('/api/shop/config', authenticate, async (req, res) => {
  try {
    const config = await DB.getShopConfig(req.shopId);
    res.json(config);
  } catch (error) {
    console.error('Error loading shop config:', error);
    res.status(500).json({ error: 'Failed to load configuration' });
  }
});

/**
 * PUT /api/shop/config
 * Saves the shop's configuration.
 * Expects a JSON object in the request body.
 */
app.put('/api/shop/config', authenticate, async (req, res) => {
  try {
    const newConfig = req.body || {};
    
    // Validate config structure (optional but good practice)
    if (typeof newConfig !== 'object') {
      return res.status(400).json({ error: 'Config must be an object' });
    }
    
    const updatedShop = await DB.updateShopConfig(req.shopId, newConfig);
    
    if (!updatedShop) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    
    console.log(`✅ Shop config saved for ${req.shopId}`);
    res.json({ success: true, config: newConfig });
  } catch (error) {
    console.error('Error saving shop config:', error);
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

// =====================================================
// DASHBOARD STATS
// =====================================================
app.get('/api/dashboard/stats', authenticate, async (req, res) => {
  try {
    const shopJobs = await DB.getJobs(req.shopId);
    const shopMechanics = await DB.getMechanics(req.shopId);
    const today = new Date(); today.setHours(0, 0, 0, 0);

    const open = shopJobs.filter(j => j.status !== 'DELIVERED').length;
    const overdue = shopJobs.filter(j => {
      if (j.status === 'DELIVERED') return false;
      return Date.now() > new Date(j.created_at).getTime() + j.sla_hours * 3600000;
    }).length;
    const doneToday = shopJobs.filter(j => j.completed_at && new Date(j.completed_at) >= today).length;
    const revenue = shopJobs.filter(j => j.status === 'DELIVERED').length * 850;

    res.json({ openJobs: open, overdueJobs: overdue, completedToday: doneToday, revenue, activeMechanics: shopMechanics.filter(m => m.is_active).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =====================================================
// JOBS CRUD
// =====================================================
app.get('/api/jobs', authenticate, async (req, res) => {
  try { res.json(await DB.getJobs(req.shopId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/jobs/:id', authenticate, async (req, res) => {
  try {
    const job = await DB.getJobById(req.params.id, req.shopId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/jobs', authenticate, async (req, res) => {
  try {
    const { bike, cust_id, mech_id, type, issue, sla_hours, status } = req.body;
    const job = {
      id: uid(), shop_id: req.shopId,
      bike, cust_id, mech_id: mech_id || null,
      type: type || 'Repair', status: status || 'PENDING',
      sla_hours: sla_hours || 24, issue: issue || '',
      created_at: new Date().toISOString(), completed_at: null
    };
    res.json(await DB.createJob(job));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/jobs/:id', authenticate, async (req, res) => {
  try {
    const existing = await DB.getJobById(req.params.id, req.shopId);
    if (!existing) return res.status(404).json({ error: 'Job not found' });
    const updates = { ...req.body, updated_at: new Date().toISOString() };
    if (req.body.status === 'DELIVERED' && !existing.completed_at) {
      updates.completed_at = new Date().toISOString();
    }
    res.json(await DB.updateJob(req.params.id, req.shopId, updates));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/jobs/:id', authenticate, async (req, res) => {
  try {
    const ok = await DB.deleteJob(req.params.id, req.shopId);
    if (!ok) return res.status(404).json({ error: 'Job not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =====================================================
// MECHANICS CRUD
// =====================================================
app.get('/api/mechanics', authenticate, async (req, res) => {
  try { res.json(await DB.getMechanics(req.shopId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mechanics', authenticate, async (req, res) => {
  try {
    const { name, phone, spec } = req.body;
    const allMechs = await DB.getMechanics(req.shopId);
    const mechanic = {
      id: mechUid(), shop_id: req.shopId, name, phone: phone || '', spec: spec || 'General Repairs',
      color: allMechs.length % 5, is_active: true, jobs_completed: 0, created_at: new Date().toISOString()
    };
    res.json(await DB.createMechanic(mechanic));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/mechanics/:id', authenticate, async (req, res) => {
  try {
    const mech = await DB.updateMechanic(req.params.id, req.shopId, req.body);
    if (!mech) return res.status(404).json({ error: 'Mechanic not found' });
    res.json(mech);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/mechanics/:id', authenticate, async (req, res) => {
  try {
    const ok = await DB.deleteMechanic(req.params.id, req.shopId);
    if (!ok) return res.status(404).json({ error: 'Mechanic not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =====================================================
// CUSTOMERS CRUD
// =====================================================
app.get('/api/customers', authenticate, async (req, res) => {
  try { res.json(await DB.getCustomers(req.shopId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/customers', authenticate, async (req, res) => {
  try {
    const { name, phone } = req.body;
    const customer = {
      id: custUid(), shop_id: req.shopId, name, phone: phone || '',
      since: new Date().toISOString(), total_jobs: 0, total_spent: 0
    };
    res.json(await DB.createCustomer(customer));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/customers/:id', authenticate, async (req, res) => {
  try {
    const cust = await DB.updateCustomer(req.params.id, req.shopId, req.body);
    if (!cust) return res.status(404).json({ error: 'Customer not found' });
    res.json(cust);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/customers/:id', authenticate, async (req, res) => {
  try {
    const ok = await DB.deleteCustomer(req.params.id, req.shopId);
    if (!ok) return res.status(404).json({ error: 'Customer not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =====================================================
// SHOP SETTINGS (legacy - use config endpoints instead)
// =====================================================
app.get('/api/shop/settings', authenticate, async (req, res) => {
  try {
    const shop = await DB.findShopById(req.shopId);
    res.json(shop || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =====================================================
// HEALTH CHECK
// =====================================================
app.get('/health', (req, res) => {
  const sb = getSupabase();
  res.json({
    status: 'ok',
    service: 'motoshop-server',
    mode: sb ? 'supabase' : 'memory',
    shops: shops.length,
    jobs: jobs.length
  });
});

// =====================================================
// SUPABASE SCHEMA HELPER (prints SQL to create tables)
// =====================================================
app.get('/api/schema', (req, res) => {
  res.type('text/plain').send(`
-- Run this SQL in your Supabase SQL Editor to create the required tables:

CREATE TABLE IF NOT EXISTS shops (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  license_key TEXT UNIQUE,
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  shop_id TEXT REFERENCES shops(id),
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  email TEXT,
  phone TEXT,
  role TEXT DEFAULT 'staff',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  shop_id TEXT REFERENCES shops(id),
  bike TEXT NOT NULL,
  cust_id TEXT,
  mech_id TEXT,
  type TEXT DEFAULT 'Repair',
  status TEXT DEFAULT 'PENDING',
  sla_hours INTEGER DEFAULT 24,
  issue TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS mechanics (
  id TEXT PRIMARY KEY,
  shop_id TEXT REFERENCES shops(id),
  name TEXT NOT NULL,
  phone TEXT,
  spec TEXT DEFAULT 'General Repairs',
  color INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  jobs_completed INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  shop_id TEXT REFERENCES shops(id),
  name TEXT NOT NULL,
  phone TEXT,
  since TIMESTAMPTZ DEFAULT NOW(),
  total_jobs INTEGER DEFAULT 0,
  total_spent NUMERIC DEFAULT 0
);

-- Enable Row Level Security (optional but recommended)
ALTER TABLE shops    ENABLE ROW LEVEL SECURITY;
ALTER TABLE users    ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE mechanics ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

-- If upgrading an existing installation, add the config column:
ALTER TABLE shops ADD COLUMN IF NOT EXISTS config JSONB DEFAULT '{}';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Add trigger to automatically update updated_at (optional)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_shops_updated_at ON shops;
CREATE TRIGGER update_shops_updated_at
  BEFORE UPDATE ON shops
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
  `);
});

// =====================================================
// AUTO-RECOVER SUPABASE CREDS FROM SAVED SHOP CONFIG
// If the server restarts and .env has no creds, try to read them
// from a previously saved shop config so data is not lost.
// =====================================================
async function tryRecoverSupabaseFromShopConfig() {
  if (serverConfig.supabaseUrl && serverConfig.supabaseKey) return; // already set via .env
  try {
    // Read creds from a local fallback file written when user saves settings
    const fs = require('fs');
    const path = require('path');
    const credsFile = path.join(__dirname, '.supabase-creds.json');
    if (fs.existsSync(credsFile)) {
      const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
      if (creds.supabaseUrl && creds.supabaseKey) {
        serverConfig.supabaseUrl = creds.supabaseUrl;
        serverConfig.supabaseKey = creds.supabaseKey;
        supabaseClient = null;
        const sb = getSupabase();
        if (sb) console.log('🔄 Auto-recovered Supabase connection from saved credentials');
      }
    }
  } catch (e) {
    console.warn('⚠️ Could not auto-recover Supabase creds:', e.message);
  }
}

// =====================================================
// START SERVER
// =====================================================
app.listen(PORT, async () => {
  // Try to recover Supabase creds from last saved config (survives restarts)
  await tryRecoverSupabaseFromShopConfig();
  const sb = getSupabase();
  const dbStatus = sb ? '✅ Supabase' : '⚠️  In-memory (set SUPABASE_URL + SUPABASE_KEY in .env)';
  console.log(`\n${'='.repeat(52)}`);
  console.log(`🏍️  MOTOSHOP SERVER RUNNING`);
  console.log(`${'='.repeat(52)}`);
  console.log(`📍 URL:      http://localhost:${PORT}`);
  console.log(`💾 Database: ${dbStatus}`);
  console.log(`📋 Schema:   http://localhost:${PORT}/api/schema`);
  if (!sb) {
    console.log(`\nSet env vars to use Supabase:`);
    console.log(`  SUPABASE_URL=https://xxxx.supabase.co`);
    console.log(`  SUPABASE_KEY=eyJhbGci...\n`);
  }
});