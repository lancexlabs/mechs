// THIS MUST BE THE FIRST LINE
require('dotenv').config();

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();

// =====================================================
// CONFIGURATION - Add error checking
// =====================================================
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'veloshop-super-secret-key-2024';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Check if environment variables are loaded
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('\n❌ ERROR: Missing Supabase credentials in .env file!\n');
  console.error('Please create a .env file with:');
  console.error('SUPABASE_URL=https://your-project.supabase.co');
  console.error('SUPABASE_ANON_KEY=your-anon-key');
  console.error('SUPABASE_SERVICE_ROLE_KEY=your-service-role-key\n');
  process.exit(1);
}

console.log('\n✅ Configuration loaded:');
console.log(`   PORT: ${PORT}`);
console.log(`   SUPABASE_URL: ${SUPABASE_URL}`);
console.log(`   SUPABASE_ANON_KEY: ${SUPABASE_ANON_KEY.substring(0, 20)}...`);
console.log(`   SUPABASE_SERVICE_ROLE_KEY: ${SUPABASE_SERVICE_ROLE_KEY.substring(0, 20)}...\n`);

// Initialize Supabase clients
const supabasePublic = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Rest of your server.js code...

// Store WhatsApp clients per shop
const waClients = new Map();

// Middleware
app.use(cors());
app.use(express.json());

// =====================================================
// AUTH MIDDLEWARE
// =====================================================
const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Get user from database using admin client
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('*, shops(*)')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    req.user = user;
    req.shopId = user.shop_id;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// =====================================================
// AUTH ENDPOINTS
// =====================================================

// Admin login
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  
  if (username === 'admin' && password === 'veloadmin2024') {
    const token = jwt.sign({ role: 'admin', username }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ token, role: 'admin' });
  }
  
  res.status(401).json({ error: 'Invalid admin credentials' });
});

// Staff login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;

  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('*, shops(*)')
    .eq('username', username.toLowerCase())
    .single();

  if (error || !user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const validPassword = await bcrypt.compare(password, user.password_hash);
  if (!validPassword) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Update last login
  await supabaseAdmin
    .from('users')
    .update({ last_login: new Date().toISOString() })
    .eq('id', user.id);

  const token = jwt.sign(
    { userId: user.id, shopId: user.shop_id, role: user.role },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      shop: user.shops
    }
  });
});

// Verify license (public endpoint)
app.post('/api/auth/verify-license', async (req, res) => {
  const { licenseKey } = req.body;

  if (!licenseKey) {
    return res.status(400).json({ error: 'License key required' });
  }

  const { data: license, error } = await supabasePublic
    .from('licenses')
    .select('*')
    .eq('license_key', licenseKey.toUpperCase())
    .single();

  if (error || !license) {
    return res.status(400).json({ error: 'Invalid license key' });
  }

  if (license.is_revoked) {
    return res.status(400).json({ error: 'License has been revoked' });
  }

  if (new Date(license.expires_at) < new Date()) {
    return res.status(400).json({ error: 'License has expired' });
  }

  res.json({ 
    valid: true, 
    license: {
      id: license.id,
      plan: license.plan,
      max_seats: license.max_seats,
      features: license.features,
      expires_at: license.expires_at
    }
  });
});

// Complete setup (create shop and admin user)
app.post('/api/auth/setup', async (req, res) => {
  const { licenseKey, shopName, shopPhone, shopEmail, adminName, adminUsername, adminPassword } = req.body;

  // Verify license first
  const { data: license, error: licenseError } = await supabasePublic
    .from('licenses')
    .select('*')
    .eq('license_key', licenseKey.toUpperCase())
    .single();

  if (licenseError || !license) {
    return res.status(400).json({ error: 'Invalid license key' });
  }

  if (license.is_revoked) {
    return res.status(400).json({ error: 'License has been revoked' });
  }

  if (new Date(license.expires_at) < new Date()) {
    return res.status(400).json({ error: 'License has expired' });
  }

  // Check if already activated
  const { data: existingShop } = await supabaseAdmin
    .from('shops')
    .select('id')
    .eq('license_id', license.id)
    .single();

  if (existingShop) {
    return res.status(400).json({ error: 'License already activated' });
  }

  // Create shop
  const { data: shop, error: shopError } = await supabaseAdmin
    .from('shops')
    .insert({
      license_id: license.id,
      name: shopName,
      phone: shopPhone,
      email: shopEmail,
      settings: { currency: '₹', timezone: 'Asia/Kolkata' }
    })
    .select()
    .single();

  if (shopError) {
    return res.status(500).json({ error: 'Failed to create shop: ' + shopError.message });
  }

  // Create shop settings
  await supabaseAdmin
    .from('shop_settings')
    .insert({
      shop_id: shop.id,
      theme: 'dark',
      date_format: 'DD/MM/YYYY',
      time_format: '24h'
    });

  // Create admin user
  const passwordHash = await bcrypt.hash(adminPassword, 10);
  const { error: userError } = await supabaseAdmin
    .from('users')
    .insert({
      shop_id: shop.id,
      username: adminUsername.toLowerCase().replace(/\s/g, ''),
      password_hash: passwordHash,
      full_name: adminName,
      email: shopEmail,
      phone: shopPhone,
      role: 'admin',
      is_active: true
    });

  if (userError) {
    // Rollback shop creation
    await supabaseAdmin.from('shops').delete().eq('id', shop.id);
    return res.status(500).json({ error: 'Failed to create admin user: ' + userError.message });
  }

  res.json({
    success: true,
    shop: { id: shop.id, name: shop.name },
    message: 'Setup complete! Please login.'
  });
});

// =====================================================
// DASHBOARD ENDPOINTS
// =====================================================

app.get('/api/dashboard/stats', authenticate, async (req, res) => {
  const { shopId } = req;

  // Get all jobs for this shop
  const { data: jobs, error: jobsError } = await supabaseAdmin
    .from('jobs')
    .select('*')
    .eq('shop_id', shopId);

  if (jobsError) {
    return res.status(500).json({ error: jobsError.message });
  }

  // Get customers count
  const { count: totalCustomers, error: customersError } = await supabaseAdmin
    .from('customers')
    .select('*', { count: 'exact', head: true })
    .eq('shop_id', shopId);

  // Get active mechanics count
  const { count: activeMechanics, error: mechanicsError } = await supabaseAdmin
    .from('mechanics')
    .select('*', { count: 'exact', head: true })
    .eq('shop_id', shopId)
    .eq('is_active', true);

  const allJobs = jobs || [];
  const today = new Date().toISOString().split('T')[0];

  const stats = {
    totalJobs: allJobs.length,
    openJobs: allJobs.filter(j => j.status === 'pending').length,
    inProgressJobs: allJobs.filter(j => j.status === 'in_progress').length,
    completedToday: allJobs.filter(j => j.status === 'done' && j.completed_at?.split('T')[0] === today).length,
    revenueThisMonth: allJobs
      .filter(j => j.status === 'done' && new Date(j.completed_at).getMonth() === new Date().getMonth())
      .reduce((sum, j) => sum + (j.actual_cost || 0), 0),
    totalCustomers: totalCustomers || 0,
    activeMechanics: activeMechanics || 0
  };

  res.json(stats);
});

// =====================================================
// CUSTOMERS CRUD
// =====================================================

app.get('/api/customers', authenticate, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('customers')
    .select('*')
    .eq('shop_id', req.shopId)
    .order('name');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/customers', authenticate, async (req, res) => {
  const customerData = {
    ...req.body,
    shop_id: req.shopId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabaseAdmin
    .from('customers')
    .insert(customerData)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/customers/:id', authenticate, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('customers')
    .update({
      ...req.body,
      updated_at: new Date().toISOString()
    })
    .eq('id', req.params.id)
    .eq('shop_id', req.shopId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/customers/:id', authenticate, async (req, res) => {
  const { error } = await supabaseAdmin
    .from('customers')
    .delete()
    .eq('id', req.params.id)
    .eq('shop_id', req.shopId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// =====================================================
// MECHANICS CRUD
// =====================================================

app.get('/api/mechanics', authenticate, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('mechanics')
    .select('*')
    .eq('shop_id', req.shopId)
    .order('name');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/mechanics', authenticate, async (req, res) => {
  const mechanicData = {
    ...req.body,
    shop_id: req.shopId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabaseAdmin
    .from('mechanics')
    .insert(mechanicData)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/mechanics/:id', authenticate, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('mechanics')
    .update({
      ...req.body,
      updated_at: new Date().toISOString()
    })
    .eq('id', req.params.id)
    .eq('shop_id', req.shopId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/mechanics/:id', authenticate, async (req, res) => {
  const { error } = await supabaseAdmin
    .from('mechanics')
    .delete()
    .eq('id', req.params.id)
    .eq('shop_id', req.shopId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// =====================================================
// JOBS CRUD
// =====================================================

app.get('/api/jobs', authenticate, async (req, res) => {
  let query = supabaseAdmin
    .from('jobs')
    .select('*, customers(name, phone), mechanics(name)')
    .eq('shop_id', req.shopId);

  if (req.query.status && req.query.status !== 'all') {
    query = query.eq('status', req.query.status);
  }

  const { data, error } = await query.order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/jobs', authenticate, async (req, res) => {
  const jobData = {
    ...req.body,
    shop_id: req.shopId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabaseAdmin
    .from('jobs')
    .insert(jobData)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/jobs/:id', authenticate, async (req, res) => {
  const updates = { ...req.body, updated_at: new Date().toISOString() };

  if (updates.status === 'done' && !updates.completed_at) {
    updates.completed_at = new Date().toISOString();
  }

  if (updates.status === 'delivered' && !updates.delivered_at) {
    updates.delivered_at = new Date().toISOString();
  }

  const { data, error } = await supabaseAdmin
    .from('jobs')
    .update(updates)
    .eq('id', req.params.id)
    .eq('shop_id', req.shopId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/jobs/:id', authenticate, async (req, res) => {
  const { error } = await supabaseAdmin
    .from('jobs')
    .delete()
    .eq('id', req.params.id)
    .eq('shop_id', req.shopId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// =====================================================
// SHOP SETTINGS
// =====================================================

app.get('/api/shop/settings', authenticate, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('shops')
    .select('*, licenses(plan, max_seats, features, expires_at)')
    .eq('id', req.shopId)
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/shop/settings', authenticate, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('shops')
    .update({
      ...req.body,
      updated_at: new Date().toISOString()
    })
    .eq('id', req.shopId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// =====================================================
// WHATSAPP BRIDGE
// =====================================================

async function initWhatsApp(shopId) {
  if (waClients.has(shopId)) {
    return waClients.get(shopId);
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `shop_${shopId}` }),
    puppeteer: { 
      headless: true, 
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ] 
    }
  });

  const shopData = { client, status: 'initializing', qrCode: null, phone: null };

  client.on('qr', async (qr) => {
    shopData.status = 'waiting_qr';
    shopData.qrCode = await QRCode.toDataURL(qr);
    
    await supabaseAdmin
      .from('wa_sessions')
      .upsert({
        shop_id: shopId,
        qr_code: shopData.qrCode,
        last_qr_at: new Date().toISOString(),
        is_connected: false
      });
  });

  client.on('ready', async () => {
    shopData.status = 'connected';
    shopData.phone = client.info.wid.user;
    
    await supabaseAdmin
      .from('wa_sessions')
      .upsert({
        shop_id: shopId,
        phone_number: shopData.phone,
        is_connected: true,
        connected_at: new Date().toISOString()
      });
  });

  client.on('disconnected', async () => {
    shopData.status = 'disconnected';
    await supabaseAdmin
      .from('wa_sessions')
      .update({ is_connected: false })
      .eq('shop_id', shopId);
  });

  await client.initialize();
  waClients.set(shopId, shopData);
  return shopData;
}

app.get('/api/whatsapp/status', authenticate, async (req, res) => {
  const shopData = waClients.get(req.shopId);
  
  if (!shopData) {
    const { data: session } = await supabaseAdmin
      .from('wa_sessions')
      .select('*')
      .eq('shop_id', req.shopId)
      .single();
    
    if (session?.is_connected) {
      await initWhatsApp(req.shopId);
      return res.json({ status: 'reconnecting', phone: session.phone_number });
    }
    
    return res.json({ status: 'not_initialized' });
  }
  
  res.json({
    status: shopData.status,
    phone: shopData.phone,
    qrCode: shopData.qrCode
  });
});

app.post('/api/whatsapp/start', authenticate, async (req, res) => {
  const shopData = await initWhatsApp(req.shopId);
  res.json({ status: shopData.status });
});

app.post('/api/whatsapp/stop', authenticate, async (req, res) => {
  const shopData = waClients.get(req.shopId);
  if (shopData) {
    await shopData.client.destroy();
    waClients.delete(req.shopId);
    
    await supabaseAdmin
      .from('wa_sessions')
      .update({ is_connected: false })
      .eq('shop_id', req.shopId);
  }
  res.json({ success: true });
});

app.post('/api/whatsapp/send', authenticate, async (req, res) => {
  const { to, message, jobId, customerId } = req.body;
  
  if (!to || !message) {
    return res.status(400).json({ error: 'Phone number and message are required' });
  }
  
  const shopData = waClients.get(req.shopId);
  if (!shopData || shopData.status !== 'connected') {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }
  
  try {
    const chatId = to.includes('@c.us') ? to : `${to.replace(/\D/g, '')}@c.us`;
    const sent = await shopData.client.sendMessage(chatId, message);
    
    await supabaseAdmin.from('wa_messages').insert({
      shop_id: req.shopId,
      job_id: jobId,
      customer_id: customerId,
      phone: to,
      message: message,
      status: 'sent',
      whatsapp_message_id: sent.id.id,
      sent_at: new Date().toISOString()
    });
    
    res.json({ success: true, messageId: sent.id.id });
  } catch (error) {
    await supabaseAdmin.from('wa_messages').insert({
      shop_id: req.shopId,
      job_id: jobId,
      customer_id: customerId,
      phone: to,
      message: message,
      status: 'failed',
      error: error.message
    });
    
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/whatsapp/messages', authenticate, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('wa_messages')
    .select('*, jobs(job_number), customers(name)')
    .eq('shop_id', req.shopId)
    .order('sent_at', { ascending: false })
    .limit(50);
  
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// =====================================================
// ADMIN LICENSE ENDPOINTS
// =====================================================

// Generate license (admin only)
app.post('/api/admin/licenses/generate', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  const { plan, customerName, customerEmail, maxSeats, durationDays, features, notes } = req.body;
  
  const planCodes = { Trial: 'TRL', Standard: 'STD', Gold: 'GLD', Pro: 'PRO', Enterprise: 'ENT' };
  const planCode = planCodes[plan] || 'CUS';
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  const licenseKey = `VELO-${planCode}-${timestamp.slice(-4)}-${random}`;
  
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + durationDays);
  
  const { data: license, error } = await supabaseAdmin
    .from('licenses')
    .insert({
      license_key: licenseKey,
      plan: plan,
      plan_code: planCode,
      shop_name: customerName,
      contact_email: customerEmail,
      max_seats: maxSeats,
      features: features,
      expires_at: expiresAt.toISOString(),
      notes: notes,
      is_revoked: false,
      is_active: true
    })
    .select()
    .single();
  
  if (error) {
    return res.status(500).json({ error: error.message });
  }
  
  res.json({
    success: true,
    license: {
      key: licenseKey,
      plan: plan,
      expires_at: expiresAt,
      max_seats: maxSeats,
      features: features
    }
  });
});

// Get all licenses (admin only)
app.get('/api/admin/licenses', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  const { data, error } = await supabaseAdmin
    .from('licenses')
    .select('*')
    .order('created_at', { ascending: false });
  
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Revoke license (admin only)
app.put('/api/admin/licenses/:id/revoke', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  const { id } = req.params;
  const { error } = await supabaseAdmin
    .from('licenses')
    .update({ is_revoked: true, is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id);
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// =====================================================
// HEALTH CHECK
// =====================================================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// =====================================================
// ERROR HANDLING
// =====================================================

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error: ' + err.message });
});

// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, () => {
  console.log(`\n🚀 VeloShop Server is running!`);
  console.log(`📍 API URL: http://localhost:${PORT}`);
  console.log(`🔐 Admin Login: admin / veloadmin2024`);
  console.log(`📱 WhatsApp Bridge: http://localhost:${PORT}/api/whatsapp`);
  console.log(`✅ Ready to accept requests\n`);
  
  console.log('Available endpoints:');
  console.log('  POST /api/admin/login - Admin login');
  console.log('  POST /api/auth/login - Staff login');
  console.log('  POST /api/auth/setup - First-time setup');
  console.log('  POST /api/auth/verify-license - License validation');
  console.log('  GET  /api/dashboard/stats - Dashboard stats');
  console.log('  CRUD /api/customers - Customer management');
  console.log('  CRUD /api/mechanics - Mechanic management');
  console.log('  CRUD /api/jobs - Job management');
  console.log('  GET/PUT /api/shop/settings - Shop settings');
  console.log('  GET/POST /api/whatsapp/* - WhatsApp integration');
  console.log('  GET/POST /api/admin/licenses/* - License management');
});