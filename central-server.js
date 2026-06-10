/**
 * ============================================================
 * VELO LICENSE MANAGER - Central Server (Port 3001)
 * ============================================================
 * Manages all licenses, admin auth, and verification logs.
 * All data is persisted to Supabase using the service role key.
 *
 * HOW TO RUN:
 *   npm install express cors jsonwebtoken bcrypt cookie-parser @supabase/supabase-js dotenv
 *   node central-server.js
 *
 * Required .env keys:
 *   SUPABASE_URL=https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ...
 *   (SUPABASE_ANON_KEY is optional — used only for the status ping)
 *
 * Default Admin PIN: 123456
 * ============================================================
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const https = require('https');
const httpModule = require('http');
const { createClient } = require('@supabase/supabase-js');
const rateLimit = require('express-rate-limit');

// Strict rate limit for auth & credential endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { success: false, error: 'Too many attempts. Try again in 15 minutes.' },
  standardHeaders: true, legacyHeaders: false
});

// General API rate limit
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  message: { success: false, error: 'Too many requests.' },
  standardHeaders: true, legacyHeaders: false
});

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌  JWT_SECRET must be set in .env (use a long random string)');
  process.exit(1);
}
const SALT_ROUNDS = 10;

// ─────────────────────────────────────────────
// SUPABASE CLIENT (service role — bypasses RLS)
// ─────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌  SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [
      'http://localhost:3002', 'http://localhost:5500', 'http://127.0.0.1:5500',
      'https://lancexlabs.github.io'
    ];

app.use(cors({
  origin: (origin, cb) => {
    // Allow server-to-server (no origin) and listed origins
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    // Allow any *.github.io or *.onrender.com (client server calling central)
    if (/^https:\/\/[a-z0-9-]+\.github\.io$/.test(origin)) return cb(null, true);
    if (/^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(origin)) return cb(null, true);
    if (/^https:\/\/[a-z0-9-]+\.netlify\.app$/.test(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed — ' + origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50kb' }));
// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.removeHeader('X-Powered-By');
  next();
});
app.use(apiLimiter);
app.use(cookieParser());

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function generateLicenseKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const segment = (len) =>
    Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `VELO-${segment(4)}-${segment(4)}-${segment(4)}-${segment(4)}`;
}

async function generateUniqueLicenseKey() {
  let key;
  do {
    key = generateLicenseKey();
    const { data } = await supabase
      .from('central_licenses')
      .select('id')
      .eq('license_key', key)
      .maybeSingle();
    if (!data) break;
  } while (true);
  return key;
}

async function addLog(license_key, shop_id, action, status, details = '') {
  const { error } = await supabase.from('central_verification_logs').insert({
    license_key,
    shop_id: shop_id || null,
    action,
    status,
    details
  });
  if (error) console.error('[addLog] Supabase error:', error.message);
}

function getLicenseStatus(license) {
  if (license.is_revoked) return 'revoked';
  if (!license.is_active) return 'inactive';
  if (new Date(license.expires_at) < new Date()) return 'expired';
  return 'active';
}

function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : req.cookies?.admin_token;

  if (!token) {
    return res.status(401).json({ success: false, error: 'Unauthorized: No token provided' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid or expired token' });
  }
}

// ─────────────────────────────────────────────
// SEED: Ensure default superadmin exists
// ─────────────────────────────────────────────
(async () => {
  try {
    const { data: existing } = await supabase
      .from('central_admins')
      .select('id')
      .eq('username', 'admin')
      .maybeSingle();

    if (!existing) {
      const hash = await bcrypt.hash('123456', SALT_ROUNDS);
      const { error } = await supabase.from('central_admins').insert({
        username: 'admin',
        password_hash: hash,
        email: 'admin@veloshop.com',
        role: 'superadmin'
      });
      if (error) throw error;
      console.log('[SEED] Default admin created. Change the PIN immediately via /api/admin/change-pin');
    } else {
      console.log('[SEED] Admin already exists in Supabase.');
    }
  } catch (err) {
    console.error('[SEED] Failed to seed admin:', err.message);
  }
})();

// ─────────────────────────────────────────────
// ROUTE: HEALTH CHECK
// ─────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const { count: licCount } = await supabase
    .from('central_licenses').select('*', { count: 'exact', head: true });
  const { count: logCount } = await supabase
    .from('central_verification_logs').select('*', { count: 'exact', head: true });

  res.json({
    status: 'ok',
    server: 'VELO Central License Server',
    port: PORT,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    storage: 'supabase',
    stats: { total_licenses: licCount || 0, total_logs: logCount || 0 }
  });
});

// ─────────────────────────────────────────────
// ROUTES: ADMIN AUTH
// ─────────────────────────────────────────────

app.post('/api/admin/login', authLimiter, async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ success: false, error: 'PIN is required' });

    const pinStr = String(pin).trim();
    if (!/^\d{6}$/.test(pinStr))
      return res.status(400).json({ success: false, error: 'PIN must be exactly 6 digits' });

    const { data: admin, error } = await supabase
      .from('central_admins').select('*').eq('username', 'admin').maybeSingle();

    if (error || !admin)
      return res.status(500).json({ success: false, error: 'Admin account not found' });

    const isValid = await bcrypt.compare(pinStr, admin.password_hash);
    if (!isValid) {
      await addLog('ADMIN', null, 'admin_login', 'failed', 'Invalid PIN attempt');
      return res.status(401).json({ success: false, error: 'Invalid PIN' });
    }

    const token = jwt.sign(
      { id: admin.id, username: admin.username, role: admin.role },
      JWT_SECRET, { expiresIn: '8h' }
    );

    await addLog('ADMIN', null, 'admin_login', 'success', `Admin "${admin.username}" logged in`);

    res.json({ success: true, token, admin: { id: admin.id, username: admin.username, role: admin.role } });
  } catch (err) {
    console.error('[/api/admin/login]', err);
    res.status(500).json({ success: false, error: 'Server error during login' });
  }
});

app.post('/api/admin/change-pin', requireAuth, async (req, res) => {
  try {
    const { current_pin, new_pin, confirm_pin } = req.body;
    if (!current_pin || !new_pin || !confirm_pin)
      return res.status(400).json({ success: false, error: 'All PIN fields are required' });
    if (!/^\d{6}$/.test(String(new_pin)))
      return res.status(400).json({ success: false, error: 'New PIN must be exactly 6 digits' });
    if (String(new_pin) !== String(confirm_pin))
      return res.status(400).json({ success: false, error: 'New PIN and confirmation do not match' });

    const { data: admin } = await supabase
      .from('central_admins').select('*').eq('username', 'admin').maybeSingle();

    const isValid = await bcrypt.compare(String(current_pin), admin.password_hash);
    if (!isValid)
      return res.status(401).json({ success: false, error: 'Current PIN is incorrect' });

    const newHash = await bcrypt.hash(String(new_pin), SALT_ROUNDS);
    await supabase.from('central_admins').update({ password_hash: newHash }).eq('id', admin.id);
    await addLog('ADMIN', null, 'admin_change_pin', 'success', 'Admin PIN changed');

    res.json({ success: true, message: 'PIN changed successfully' });
  } catch (err) {
    console.error('[/api/admin/change-pin]', err);
    res.status(500).json({ success: false, error: 'Server error changing PIN' });
  }
});

// ─────────────────────────────────────────────
// ROUTES: LICENSE MANAGEMENT
// ─────────────────────────────────────────────

app.post('/api/admin/licenses/generate', requireAuth, async (req, res) => {
  try {
    const {
      client_name, client_company, client_email, client_phone, client_address,
      shop_name, shop_address,
      supabase_url, supabase_anon_key,
      admin_username, admin_password, admin_full_name,
      plan, max_seats, duration_days,
      features,
      whatsapp_enabled, twilio_account_sid, twilio_auth_token, twilio_whatsapp_from,
      notes
    } = req.body;

    const required = { client_name, client_email, client_phone, supabase_url, supabase_anon_key, admin_username, admin_password };
    for (const [field, value] of Object.entries(required)) {
      if (!value || String(value).trim() === '')
        return res.status(400).json({ success: false, error: `Field "${field}" is required` });
    }

    const normalizedUsername = String(admin_username).trim().toLowerCase();

    const { data: existingUser } = await supabase
      .from('central_licenses')
      .select('id')
      .eq('admin_username', normalizedUsername)
      .maybeSingle();

    if (existingUser)
      return res.status(409).json({
        success: false,
        error: `Admin username "${admin_username}" is already taken.`
      });

    const pinStr = String(admin_password).trim();
    if (!/^\d{4,8}$/.test(pinStr))
      return res.status(400).json({ success: false, error: 'Admin PIN must be 4-8 digits' });

    const days = parseInt(duration_days) || 365;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);

    const licenseKey = await generateUniqueLicenseKey();
    const adminPasswordHash = await bcrypt.hash(pinStr, SALT_ROUNDS);
    const featuresArr = Array.isArray(features) ? features : [];
    const isWhatsappEnabled = Boolean(whatsapp_enabled) && Boolean(twilio_account_sid);

    const record = {
      license_key: licenseKey,
      client_name: client_name.trim(),
      client_company: (client_company || '').trim(),
      client_email: client_email.trim(),
      client_phone: client_phone.trim(),
      client_address: (client_address || '').trim(),
      shop_name: (shop_name || client_name).trim(),
      shop_address: (shop_address || '').trim(),
      supabase_url: supabase_url.trim(),
      supabase_anon_key: supabase_anon_key.trim(),
      admin_username: normalizedUsername,
      admin_password_hash: adminPasswordHash,
      admin_full_name: (admin_full_name || client_name).trim(),
      plan: plan || 'standard',
      max_seats: parseInt(max_seats) || 5,
      duration_days: days,
      expires_at: expiresAt.toISOString(),
      features: featuresArr,
      is_active: true,
      is_revoked: false,
      activated_at: null,
      activated_shop_id: null,
      whatsapp_enabled: isWhatsappEnabled,
      twilio_account_sid: isWhatsappEnabled ? (twilio_account_sid || '') : '',
      twilio_auth_token: isWhatsappEnabled ? (twilio_auth_token || '') : '',
      twilio_whatsapp_from: isWhatsappEnabled ? (twilio_whatsapp_from || '') : '',
      notes: (notes || '').trim(),
      created_by: req.admin.username
    };

    const { data: newLicense, error } = await supabase
      .from('central_licenses')
      .insert(record)
      .select()
      .single();

    if (error) throw error;

    await addLog(licenseKey, null, 'license_generated', 'success',
      `License created for "${client_name}" (${plan || 'standard'}) by admin "${req.admin.username}"`);

    const { admin_password_hash: _, twilio_auth_token: __, ...safeResponse } = newLicense;

    res.status(201).json({ success: true, message: 'License generated successfully', license: safeResponse });
  } catch (err) {
    console.error('[/api/admin/licenses/generate]', err);
    res.status(500).json({ success: false, error: 'Server error generating license: ' + err.message });
  }
});

app.get('/api/admin/licenses', requireAuth, async (req, res) => {
  try {
    const { data: licenses, error } = await supabase
      .from('central_licenses')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const safe = licenses.map(l => {
      const { admin_password_hash, twilio_auth_token, ...rest } = l;
      return { ...rest, status: getLicenseStatus(l) };
    });

    res.json({ success: true, licenses: safe, total: safe.length });
  } catch (err) {
    console.error('[GET /api/admin/licenses]', err);
    res.status(500).json({ success: false, error: 'Server error fetching licenses' });
  }
});

app.put('/api/admin/licenses/:id/revoke', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    const { data: license, error: fetchErr } = await supabase
      .from('central_licenses').select('*').eq('id', id).maybeSingle();

    if (fetchErr || !license)
      return res.status(404).json({ success: false, error: 'License not found' });
    if (license.is_revoked)
      return res.status(400).json({ success: false, error: 'License is already revoked' });

    const { error } = await supabase
      .from('central_licenses')
      .update({ is_revoked: true, is_active: false })
      .eq('id', id);

    if (error) throw error;

    await addLog(license.license_key, license.activated_shop_id, 'license_revoked', 'success',
      `License revoked by admin "${req.admin.username}"`);

    res.json({ success: true, message: 'License revoked successfully' });
  } catch (err) {
    console.error('[PUT /api/admin/licenses/:id/revoke]', err);
    res.status(500).json({ success: false, error: 'Server error revoking license' });
  }
});

app.put('/api/admin/licenses/:id/reset-activation', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    const { data: license, error: fetchErr } = await supabase
      .from('central_licenses').select('*').eq('id', id).maybeSingle();

    if (fetchErr || !license)
      return res.status(404).json({ success: false, error: 'License not found' });

    const prevShopId = license.activated_shop_id;

    const { error } = await supabase
      .from('central_licenses')
      .update({
        activated_at: null,
        activated_shop_id: null,
        is_active: license.is_revoked ? false : true
      })
      .eq('id', id);

    if (error) throw error;

    await addLog(license.license_key, prevShopId, 'activation_reset', 'success',
      `Activation reset by admin "${req.admin.username}". Previous shop: ${prevShopId || 'none'}`);

    res.json({ success: true, message: 'Activation reset successfully. License can be re-activated.' });
  } catch (err) {
    console.error('[PUT /api/admin/licenses/:id/reset-activation]', err);
    res.status(500).json({ success: false, error: 'Server error resetting activation' });
  }
});

// ─────────────────────────────────────────────
// ROUTE: RENEW LICENSE — delete old key, issue new one (same client data)
// ─────────────────────────────────────────────
app.post('/api/admin/licenses/:id/renew', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { duration_days, plan, notes } = req.body;

    // Fetch existing license
    const { data: old, error: fetchErr } = await supabase
      .from('central_licenses').select('*').eq('id', id).maybeSingle();

    if (fetchErr || !old)
      return res.status(404).json({ success: false, error: 'License not found' });
    if (old.is_revoked)
      return res.status(400).json({ success: false, error: 'Cannot renew a revoked license' });

    // Store old data before deletion
    const oldKey = old.license_key;
    const oldActivatedShopId = old.activated_shop_id;
    const oldAdminUsername = old.admin_username;

    // FIRST: Delete the old license to free up the admin_username
    const { error: deleteErr } = await supabase
      .from('central_licenses')
      .delete()
      .eq('id', id);
    
    if (deleteErr) throw deleteErr;

    // Generate fresh key
    const newKey = await generateUniqueLicenseKey();
    const days = parseInt(duration_days) || old.duration_days || 365;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);

    // Create new record with the same admin_username (now available since old is deleted)
    const newRecord = {
      license_key: newKey,
      client_name: old.client_name,
      client_company: old.client_company,
      client_email: old.client_email,
      client_phone: old.client_phone,
      client_address: old.client_address,
      shop_name: old.shop_name,
      shop_address: old.shop_address,
      supabase_url: old.supabase_url,
      supabase_anon_key: old.supabase_anon_key,
      admin_username: oldAdminUsername,
      admin_password_hash: old.admin_password_hash,
      admin_full_name: old.admin_full_name,
      plan: plan && plan.trim() ? plan.trim() : old.plan,
      max_seats: old.max_seats,
      duration_days: days,
      expires_at: expiresAt.toISOString(),
      features: old.features,
      is_active: true,
      is_revoked: false,
      activated_at: null,
      activated_shop_id: null,
      whatsapp_enabled: old.whatsapp_enabled,
      twilio_account_sid: old.twilio_account_sid,
      twilio_auth_token: old.twilio_auth_token,
      twilio_whatsapp_from: old.twilio_whatsapp_from,
      notes: notes ? notes.trim() : old.notes,
      created_by: req.admin.username
    };

    const { data: inserted, error: insertErr } = await supabase
      .from('central_licenses')
      .insert(newRecord)
      .select()
      .single();
    
    if (insertErr) throw insertErr;

    // Add logs
    await addLog(oldKey, oldActivatedShopId, 'license_renewed', 'success',
      `Old key deleted. New key: ${newKey}. Renewed by admin "${req.admin.username}" for ${days} days`);
    await addLog(newKey, null, 'license_generated', 'success',
      `Issued as renewal for "${old.client_name}" by admin "${req.admin.username}"`);

    const { admin_password_hash: _, twilio_auth_token: __, ...safe } = inserted;
    res.json({ 
      success: true, 
      message: 'License renewed — new key issued', 
      new_license_key: newKey, 
      license: safe 
    });
  } catch (err) {
    console.error('[POST /api/admin/licenses/:id/renew]', err);
    res.status(500).json({ success: false, error: 'Server error renewing license: ' + err.message });
  }
});

app.get('/api/admin/logs', requireAuth, async (req, res) => {
  try {
    const { data: logs, count, error } = await supabase
      .from('central_verification_logs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) throw error;

    res.json({ success: true, logs, total: count || logs.length });
  } catch (err) {
    console.error('[GET /api/admin/logs]', err);
    res.status(500).json({ success: false, error: 'Server error fetching logs' });
  }
});

// ─────────────────────────────────────────────
// ROUTES: PUBLIC LICENSE ENDPOINTS (used by client-server)
// ─────────────────────────────────────────────

app.post('/api/license-credentials', authLimiter, async (req, res) => {
  try {
    const { license_key, admin_password } = req.body;
    if (!license_key || !admin_password)
      return res.status(400).json({ success: false, error: 'license_key and admin_password are required' });

    const { data: license, error } = await supabase
      .from('central_licenses')
      .select('*')
      .eq('license_key', license_key.trim().toUpperCase())
      .maybeSingle();

    if (error || !license) {
      await addLog(license_key, null, 'credential_fetch', 'failed', 'License not found');
      return res.status(404).json({ success: false, error: 'License key not found' });
    }

    if (license.is_revoked) {
      await addLog(license_key, null, 'credential_fetch', 'failed', 'License is revoked');
      return res.status(403).json({ success: false, error: 'This license has been revoked' });
    }

    const isValid = await bcrypt.compare(String(admin_password), license.admin_password_hash);
    if (!isValid) {
      await addLog(license_key, null, 'credential_fetch', 'failed', 'Invalid admin password');
      return res.status(401).json({ success: false, error: 'Invalid admin PIN' });
    }

    if (new Date(license.expires_at) < new Date()) {
      await addLog(license_key, null, 'credential_fetch', 'warning', 'License is expired');
      return res.status(403).json({ success: false, error: 'This license has expired' });
    }

    await addLog(license_key, license.activated_shop_id, 'credential_fetch', 'success', 'Credentials fetched for setup');

    res.json({
      success: true,
      credentials: {
        license_key: license.license_key,
        shop_name: license.shop_name,
        shop_address: license.shop_address,
        supabase_url: license.supabase_url,
        supabase_anon_key: license.supabase_anon_key,
        admin_username: license.admin_username,
        admin_full_name: license.admin_full_name,
        admin_password_hash: license.admin_password_hash,
        plan: license.plan,
        max_seats: license.max_seats,
        features: license.features,
        expires_at: license.expires_at,
        whatsapp_enabled: license.whatsapp_enabled,
        twilio_account_sid: license.twilio_account_sid,
        twilio_auth_token: license.twilio_auth_token,
        twilio_whatsapp_from: license.twilio_whatsapp_from,
        client_name: license.client_name,
        client_company: license.client_company,
        client_email: license.client_email,
        client_phone: license.client_phone
      }
    });
  } catch (err) {
    console.error('[POST /api/license-credentials]', err);
    res.status(500).json({ success: false, error: 'Server error fetching credentials' });
  }
});

app.post('/api/validate-license', authLimiter, async (req, res) => {
  try {
    const { license_key, shop_id, action } = req.body;
    if (!license_key)
      return res.status(400).json({ success: false, error: 'license_key is required' });

    const { data: license, error } = await supabase
      .from('central_licenses')
      .select('*')
      .eq('license_key', license_key.trim().toUpperCase())
      .maybeSingle();

    if (error || !license) {
      await addLog(license_key, shop_id, action || 'validate', 'failed', 'License not found');
      return res.status(404).json({ success: false, valid: false, error: 'License not found' });
    }

    if (license.is_revoked) {
      await addLog(license_key, shop_id, action || 'validate', 'failed', 'License revoked');
      return res.status(403).json({ success: false, valid: false, error: 'License has been revoked' });
    }

    if (new Date(license.expires_at) < new Date()) {
      await addLog(license_key, shop_id, action || 'validate', 'warning', 'License expired');
      return res.status(403).json({
        success: false, valid: false,
        error: `License expired on ${new Date(license.expires_at).toLocaleDateString()}`
      });
    }

    if (action === 'activate') {
      // Allow reactivation even if already activated (for renewal scenarios)
      if (license.activated_shop_id && license.activated_shop_id !== shop_id) {
        await addLog(license_key, shop_id, 'activate', 'warning',
          `License was previously activated on ${license.activated_shop_id}. Reactivating on ${shop_id}`);
      }

      // Update activation info
      const { error: updateErr } = await supabase
        .from('central_licenses')
        .update({ activated_at: new Date().toISOString(), activated_shop_id: shop_id })
        .eq('id', license.id);

      if (updateErr) throw updateErr;
      await addLog(license_key, shop_id, 'activate', 'success', `License activated for shop: ${shop_id}`);
    } else {
      await addLog(license_key, shop_id, action || 'validate', 'success', 'License valid');
    }

    const daysLeft = Math.ceil((new Date(license.expires_at) - new Date()) / (1000 * 60 * 60 * 24));

    res.json({
      success: true,
      valid: true,
      license: {
        license_key: license.license_key,
        plan: license.plan,
        max_seats: license.max_seats,
        features: license.features,
        expires_at: license.expires_at,
        days_remaining: daysLeft,
        whatsapp_enabled: license.whatsapp_enabled,
        shop_name: license.shop_name,
        activated_at: license.activated_at,
        status: getLicenseStatus(license)
      }
    });
  } catch (err) {
    console.error('[POST /api/validate-license]', err);
    res.status(500).json({ success: false, error: 'Server error validating license' });
  }
});

app.get('/api/license-info/:key', authLimiter, async (req, res) => {
  try {
    const key = req.params.key.trim().toUpperCase();
    const { data: license, error } = await supabase
      .from('central_licenses').select('*').eq('license_key', key).maybeSingle();

    if (error || !license)
      return res.status(404).json({ success: false, error: 'License not found' });

    const daysLeft = Math.max(0, Math.ceil(
      (new Date(license.expires_at) - new Date()) / (1000 * 60 * 60 * 24)
    ));

    // Public endpoint — return ONLY non-sensitive status fields
    res.json({
      success: true,
      license: {
        license_key: license.license_key,
        shop_name: license.shop_name,
        plan: license.plan,
        expires_at: license.expires_at,
        days_remaining: daysLeft,
        is_active: license.is_active,
        is_revoked: license.is_revoked,
        whatsapp_enabled: license.whatsapp_enabled,
        status: getLicenseStatus(license)
      }
    });
  } catch (err) {
    console.error('[GET /api/license-info/:key]', err);
    res.status(500).json({ success: false, error: 'Server error fetching license info' });
  }
});

// ─────────────────────────────────────────────
// ADMIN STATS
// ─────────────────────────────────────────────
app.get('/api/admin/stats', requireAuth, async (req, res) => {
  try {
    const { data: licenses, error } = await supabase
      .from('central_licenses').select('is_active, is_revoked, expires_at');

    if (error) throw error;

    const soon = new Date();
    soon.setDate(soon.getDate() + 30);

    const total = licenses.length;
    const active = licenses.filter(l => getLicenseStatus(l) === 'active').length;
    const revoked = licenses.filter(l => l.is_revoked).length;
    const expired = licenses.filter(l => getLicenseStatus(l) === 'expired').length;
    const expiringSoon = licenses.filter(l =>
      getLicenseStatus(l) === 'active' && new Date(l.expires_at) <= soon
    ).length;

    res.json({ success: true, stats: { total, active, revoked, expired, expiring_soon: expiringSoon } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error fetching stats' });
  }
});

// ─────────────────────────────────────────────
// ADMIN SUPABASE STATUS (reads from .env)
// ─────────────────────────────────────────────
app.get('/api/admin/status', requireAuth, async (req, res) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.json({
      status: 'ok',
      supabase: 'not_configured',
      message: 'SUPABASE_URL or SUPABASE_ANON_KEY not set in .env file',
      env_hint: 'Add SUPABASE_URL and SUPABASE_ANON_KEY to your .env'
    });
  }

  const t0 = Date.now();
  try {
    const urlObj = new URL(supabaseUrl.replace(/\/$/, '') + '/rest/v1/');
    const transport = urlObj.protocol === 'https:' ? https : httpModule;

    const pingResult = await new Promise((resolve, reject) => {
      const reqOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname,
        method: 'GET',
        headers: { 'apikey': supabaseKey, 'Authorization': 'Bearer ' + supabaseKey },
        timeout: 6000
      };
      const pingReq = transport.request(reqOptions, (pingRes) => {
        let body = '';
        pingRes.on('data', chunk => { body += chunk; });
        pingRes.on('end', () => resolve({ statusCode: pingRes.statusCode, body }));
      });
      pingReq.on('error', reject);
      pingReq.on('timeout', () => { pingReq.destroy(); reject(new Error('Supabase connection timed out')); });
      pingReq.end();
    });

    const latencyMs = Date.now() - t0;
    const connected = pingResult.statusCode < 500;
    const maskedUrl = supabaseUrl.replace(/^(https?:\/\/[^.]+).*/, '$1…');

    return res.json({
      status: 'ok',
      supabase: connected ? 'connected' : 'error',
      supabase_url: maskedUrl,
      latency_ms: latencyMs,
      http_status: pingResult.statusCode,
      message: connected ? `Supabase reachable (${latencyMs}ms)` : `Supabase returned HTTP ${pingResult.statusCode}`,
      env_source: '.env'
    });
  } catch (err) {
    const latencyMs = Date.now() - t0;
    return res.json({
      status: 'ok',
      supabase: 'disconnected',
      latency_ms: latencyMs,
      message: err.message || 'Cannot reach Supabase',
      env_source: '.env'
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
// START SERVER
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║   VELO Central License Server             ║');
  console.log(`║   Running on http://localhost:${PORT}         ║`);
  console.log('║   Storage: Supabase                       ║');
  console.log('║   Change default PIN immediately!         ║');
  console.log('╚═══════════════════════════════════════════╝');
  console.log('');
});

module.exports = app;
