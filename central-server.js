require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.CENTRAL_PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'central-secret-key-2024';

app.use(cors());
app.use(express.json());

// =====================================================
// SUPABASE CONNECTION (Central License DB)
// =====================================================
// Credentials loaded from .env file (via dotenv at top)
let supabaseUrl = process.env.SUPABASE_URL || '';
let supabaseKey = process.env.SUPABASE_KEY || '';
let supabase = null;

function getSupabase() {
  if (supabase) return supabase;
  if (supabaseUrl && supabaseKey) {
    try {
      supabase = createClient(supabaseUrl, supabaseKey);
      console.log('✅ Central DB connected to Supabase');
    } catch (e) {
      console.error('❌ Supabase init failed:', e.message);
    }
  }
  return supabase;
}

// Eagerly connect on startup
getSupabase();

// =====================================================
// IN-MEMORY FALLBACK (when Supabase not configured)
// =====================================================
let licensesMem = [];
let adminUsersMem = [];
let nextId = 1;

// Default admin (password: admin123)
async function initDefaultAdmin() {
  const hash = await bcrypt.hash('admin123', 10);
  adminUsersMem.push({
    id: 1,
    username: 'admin',
    password_hash: hash,
    role: 'super_admin'
  });
}
initDefaultAdmin();

// =====================================================
// LICENSE STORAGE ABSTRACTION
// =====================================================
const LicenseDB = {
  // Create licenses table if using Supabase
  async initSchema() {
    const sb = getSupabase();
    if (sb) {
      // Check if table exists, create if not
      const { error } = await sb.from('licenses').select('id').limit(1);
      if (error && error.message.includes('does not exist')) {
        console.log('📋 Creating licenses table in Supabase...');
        // You'll need to run the SQL schema manually or via migrations
        console.log('⚠️ Please run the SQL schema from /api/schema endpoint');
      }
    }
  },

  async createLicense(license) {
    const sb = getSupabase();
    if (sb) {
      const { data, error } = await sb.from('licenses')
        .insert({ ...license, created_at: new Date().toISOString() })
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data;
    }
    // In-memory fallback
    const newLicense = { ...license, id: nextId++, created_at: new Date().toISOString() };
    licensesMem.push(newLicense);
    return newLicense;
  },

  async getAllLicenses() {
    const sb = getSupabase();
    if (sb) {
      const { data, error } = await sb.from('licenses')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return data || [];
    }
    return licensesMem;
  },

  async getLicenseByKey(licenseKey) {
    const sb = getSupabase();
    if (sb) {
      const { data, error } = await sb.from('licenses')
        .select('*')
        .eq('license_key', licenseKey)
        .single();
      if (error && error.code !== 'PGRST116') throw new Error(error.message);
      return data;
    }
    return licensesMem.find(l => l.license_key === licenseKey);
  },

  async updateLicense(id, updates) {
    const sb = getSupabase();
    if (sb) {
      const { data, error } = await sb.from('licenses')
        .update(updates)
        .eq('id', id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data;
    }
    const index = licensesMem.findIndex(l => l.id === id);
    if (index === -1) return null;
    licensesMem[index] = { ...licensesMem[index], ...updates };
    return licensesMem[index];
  },

  async revokeLicense(id) {
    return this.updateLicense(id, { is_revoked: true, revoked_at: new Date().toISOString() });
  },

  async validateLicense(licenseKey, shopDbUrl = null, shopId = null) {
    const license = await this.getLicenseByKey(licenseKey);
    if (!license) return { valid: false, error: 'License key not found' };
    if (license.is_revoked) return { valid: false, error: 'License has been revoked' };
    if (new Date(license.expires_at) < new Date()) {
      return { valid: false, error: 'License has expired' };
    }

    // ── ACTIVATION LOCK ────────────────────────────────────────────────────────
    // If this license has already been activated by a different shop, block it.
    if (license.activated_shop_id && shopId && license.activated_shop_id !== shopId) {
      return {
        valid: false,
        error: `License is already activated by another installation (shop: ${license.activated_shop_id}). Contact support to transfer.`
      };
    }

    // If not yet activated, stamp it now (first-use lock)
    if (!license.activated_at && shopId) {
      const activationPatch = {
        activated_at: new Date().toISOString(),
        activated_shop_id: shopId
      };
      await this.updateLicense(license.id, activationPatch);
      Object.assign(license, activationPatch); // update local object too
    }

    // Optional: Check if shop DB URL matches (anti-theft)
    if (shopDbUrl && license.client_db_url && license.client_db_url !== shopDbUrl) {
      return { valid: false, error: 'License is registered to a different database' };
    }
    
    return { 
      valid: true,
      firstActivation: !license.activated_at, // true on very first use
      license: {
        license_key: license.license_key,
        plan: license.plan,
        max_seats: license.max_seats,
        features: license.features,
        expires_at: license.expires_at,
        client_db_url: license.client_db_url,
        client_db_key: license.client_db_key,
        activated_at: license.activated_at,
        activated_shop_id: license.activated_shop_id
      }
    };
  }
};

// =====================================================
// ADMIN AUTHENTICATION
// =====================================================
async function authenticateAdmin(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Admin login
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  
  try {
    const sb = getSupabase();
    let admin = null;
    
    if (sb) {
      const { data } = await sb.from('admin_users')
        .select('*')
        .eq('username', username)
        .single();
      admin = data;
    } else {
      admin = adminUsersMem.find(u => u.username === username);
    }
    
    if (!admin) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign(
      { adminId: admin.id, username: admin.username, role: admin.role },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    
    res.json({ token, admin: { id: admin.id, username: admin.username, role: admin.role } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// LICENSE MANAGEMENT ENDPOINTS (for Admin Panel)
// =====================================================

// Generate new license
app.post('/api/admin/licenses/generate', authenticateAdmin, async (req, res) => {
  const {
    plan,
    clientName,
    clientEmail,
    clientPhone,
    clientDbUrl,
    clientDbKey,
    maxSeats,
    durationDays,
    features,
    notes
  } = req.body;
  
  if (!clientName) {
    return res.status(400).json({ error: 'Client name is required' });
  }
  
  // Generate unique license key
  const generateLicenseKey = () => {
    const prefix = 'VELO';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let key = prefix;
    for (let i = 0; i < 4; i++) {
      key += '-';
      for (let j = 0; j < 4; j++) {
        key += chars[Math.floor(Math.random() * chars.length)];
      }
    }
    return key;
  };
  
  let licenseKey;
  let isUnique = false;
  while (!isUnique) {
    licenseKey = generateLicenseKey();
    const existing = await LicenseDB.getLicenseByKey(licenseKey);
    if (!existing) isUnique = true;
  }
  
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + (durationDays || 365));
  
  const license = {
    license_key: licenseKey,
    client_name: clientName,
    client_email: clientEmail || null,
    client_phone: clientPhone || null,
    client_db_url: clientDbUrl || null,
    client_db_key: clientDbKey || null,
    plan: plan || 'Standard',
    max_seats: maxSeats || 5,
    features: features || [],
    duration_days: durationDays || 365,
    expires_at: expiresAt.toISOString(),
    is_revoked: false,
    notes: notes || null,
    created_by: req.admin.username
  };
  
  try {
    const saved = await LicenseDB.createLicense(license);
    res.json({ success: true, license: saved });
  } catch (error) {
    console.error('Generate license error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all licenses
app.get('/api/admin/licenses', authenticateAdmin, async (req, res) => {
  try {
    const licenses = await LicenseDB.getAllLicenses();
    res.json(licenses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reset activation lock (allows license to be activated by a different shop)
app.put('/api/admin/licenses/:id/reset-activation', authenticateAdmin, async (req, res) => {
  try {
    const license = await LicenseDB.updateLicense(parseInt(req.params.id), {
      activated_at: null,
      activated_shop_id: null
    });
    if (!license) return res.status(404).json({ error: 'License not found' });
    res.json({ success: true, message: 'Activation reset — license can be re-activated by a new shop', license });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Revoke license
app.put('/api/admin/licenses/:id/revoke', authenticateAdmin, async (req, res) => {
  try {
    const license = await LicenseDB.revokeLicense(parseInt(req.params.id));
    if (!license) {
      return res.status(404).json({ error: 'License not found' });
    }
    res.json({ success: true, license });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// PUBLIC LICENSE VALIDATION (for client shops)
// =====================================================
app.post('/api/validate-license', async (req, res) => {
  // shopId: unique identifier for the activating installation (e.g. shop UUID or DB URL hash)
  const { licenseKey, shopDbUrl, shopId } = req.body;
  
  if (!licenseKey) {
    return res.status(400).json({ valid: false, error: 'License key required' });
  }
  
  try {
    const result = await LicenseDB.validateLicense(licenseKey, shopDbUrl, shopId);
    res.json(result);
  } catch (error) {
    console.error('Validation error:', error);
    res.status(500).json({ valid: false, error: 'Validation service error' });
  }
});

// =====================================================
// HEALTH CHECK
// =====================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'central-license-server',
    port: PORT,
    mode: getSupabase() ? 'supabase' : 'memory'
  });
});

// =====================================================
// SCHEMA SQL (for Supabase setup)
// =====================================================
app.get('/api/schema', (req, res) => {
  res.type('text/plain').send(`
-- =====================================================
-- CENTRAL LICENSE SERVER - SUPABASE SCHEMA
-- Run this in your Supabase SQL Editor
-- =====================================================

-- Licenses table
CREATE TABLE IF NOT EXISTS licenses (
  id SERIAL PRIMARY KEY,
  license_key TEXT UNIQUE NOT NULL,
  client_name TEXT NOT NULL,
  client_email TEXT,
  client_phone TEXT,
  client_db_url TEXT,
  client_db_key TEXT,
  plan TEXT DEFAULT 'Standard',
  max_seats INTEGER DEFAULT 5,
  features JSONB DEFAULT '[]',
  duration_days INTEGER DEFAULT 365,
  expires_at TIMESTAMPTZ NOT NULL,
  is_revoked BOOLEAN DEFAULT FALSE,
  revoked_at TIMESTAMPTZ,
  notes TEXT,
  created_by TEXT,
  activated_at TIMESTAMPTZ,          -- set on first successful validation
  activated_shop_id TEXT,            -- shop ID that first activated this license
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- If upgrading existing installs, run:
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS activated_shop_id TEXT;

-- Admin users table
CREATE TABLE IF NOT EXISTS admin_users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'admin',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default admin (password: admin123)
-- Run: node generate-hash.js to get your hash
INSERT INTO admin_users (username, password_hash, role)
VALUES ('admin', '$2b$10$YourGeneratedHashHere', 'super_admin')
ON CONFLICT (username) DO NOTHING;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(license_key);
CREATE INDEX IF NOT EXISTS idx_licenses_expires ON licenses(expires_at);
CREATE INDEX IF NOT EXISTS idx_licenses_client ON licenses(client_name);

-- Enable RLS
ALTER TABLE licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;

-- Create policy for admin access
CREATE POLICY "Enable all for authenticated admins" ON licenses
  FOR ALL USING (true);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_licenses_updated_at ON licenses;
CREATE TRIGGER update_licenses_updated_at
  BEFORE UPDATE ON licenses
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
  `);
});

// =====================================================
// START SERVER
// =====================================================
app.listen(PORT, () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🔐 CENTRAL LICENSE SERVER`);
  console.log(`${'='.repeat(50)}`);
  console.log(`📍 URL: http://localhost:${PORT}`);
  console.log(`📋 Admin Login: admin / admin123`);
  console.log(`💾 Mode: ${getSupabase() ? 'Supabase' : 'In-Memory (data lost on restart!)'}`);
  console.log(`\n📌 For production, set env vars:`);
  console.log(`   SUPABASE_URL=your-project-url`);
  console.log(`   SUPABASE_KEY=your-anon-key`);
  console.log(`   JWT_SECRET=your-secret-key\n`);
  
  LicenseDB.initSchema();
});