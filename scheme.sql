-- =====================================================
-- CLIENT SHOP DATABASE SCHEMA (WITH DUPLICATE CHECKS)
-- Run this in EACH client's Supabase project
-- =====================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- SHOP INFO TABLE
-- =====================================================
DROP TABLE IF EXISTS shop_info CASCADE;
CREATE TABLE shop_info (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  license_key TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  currency TEXT DEFAULT '₹',
  logo_url TEXT,
  timezone TEXT DEFAULT 'Asia/Kolkata',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- USERS TABLE
-- =====================================================
DROP TABLE IF EXISTS users CASCADE;
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shop_id UUID REFERENCES shop_info(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  role TEXT DEFAULT 'mechanic' CHECK (role IN ('admin', 'manager', 'mechanic', 'viewer')),
  is_active BOOLEAN DEFAULT TRUE,
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(shop_id, username)
);

-- =====================================================
-- CUSTOMERS TABLE
-- =====================================================
DROP TABLE IF EXISTS customers CASCADE;
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shop_id UUID REFERENCES shop_info(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  bikes TEXT[] DEFAULT '{}',
  preferred_bike TEXT,
  notes TEXT,
  total_spent DECIMAL(10,2) DEFAULT 0,
  total_jobs INTEGER DEFAULT 0,
  last_visit TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- MECHANICS TABLE
-- =====================================================
DROP TABLE IF EXISTS mechanics CASCADE;
CREATE TABLE mechanics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shop_id UUID REFERENCES shop_info(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  speciality TEXT,
  skills TEXT[] DEFAULT '{}',
  hourly_rate DECIMAL(10,2),
  is_active BOOLEAN DEFAULT TRUE,
  jobs_completed INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- JOBS TABLE (with ENUM types)
-- =====================================================
DROP TYPE IF EXISTS job_status CASCADE;
DROP TYPE IF EXISTS job_type CASCADE;
CREATE TYPE job_status AS ENUM ('pending', 'in_progress', 'done', 'delivered', 'cancelled');
CREATE TYPE job_type AS ENUM ('repair', 'service', 'inspection', 'custom');

DROP TABLE IF EXISTS jobs CASCADE;
CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shop_id UUID REFERENCES shop_info(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  mechanic_id UUID REFERENCES mechanics(id) ON DELETE SET NULL,
  
  -- Job identifiers
  job_number TEXT NOT NULL,
  invoice_number TEXT,
  
  -- Job details
  type job_type DEFAULT 'repair',
  status job_status DEFAULT 'pending',
  priority INTEGER DEFAULT 2,
  
  -- Vehicle info
  bike_model TEXT NOT NULL,
  bike_reg TEXT,
  bike_color TEXT,
  bike_odometer INTEGER,
  
  -- Description
  customer_complaint TEXT,
  mechanic_notes TEXT,
  diagnosis TEXT,
  
  -- Financials
  estimated_cost DECIMAL(10,2),
  actual_cost DECIMAL(10,2),
  advance_paid DECIMAL(10,2) DEFAULT 0,
  discount DECIMAL(10,2) DEFAULT 0,
  tax DECIMAL(10,2) DEFAULT 0,
  
  -- Payment
  payment_status TEXT DEFAULT 'pending' CHECK (payment_status IN ('pending', 'partial', 'paid', 'refunded')),
  payment_method TEXT,
  payment_date TIMESTAMPTZ,
  
  -- Parts used
  parts_used JSONB DEFAULT '[]',
  checklist JSONB DEFAULT '[]',
  
  -- Timing
  estimated_hours DECIMAL(5,2),
  actual_hours DECIMAL(5,2),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  
  -- Notifications
  customer_notified BOOLEAN DEFAULT FALSE,
  last_notification_at TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(shop_id, job_number)
);

-- =====================================================
-- WHATSAPP MESSAGES TABLE
-- =====================================================
DROP TABLE IF EXISTS wa_messages CASCADE;
CREATE TABLE wa_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shop_id UUID REFERENCES shop_info(id) ON DELETE CASCADE,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  
  phone TEXT NOT NULL,
  message TEXT NOT NULL,
  message_type TEXT DEFAULT 'notification',
  status TEXT DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'failed', 'pending')),
  whatsapp_message_id TEXT,
  error TEXT,
  
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ
);

-- =====================================================
-- ACTIVITY LOGS
-- =====================================================
DROP TABLE IF EXISTS activity_logs CASCADE;
CREATE TABLE activity_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shop_id UUID REFERENCES shop_info(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  details JSONB DEFAULT '{}',
  ip_address TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- SHOP SETTINGS
-- =====================================================
DROP TABLE IF EXISTS shop_settings CASCADE;
CREATE TABLE shop_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shop_id UUID REFERENCES shop_info(id) ON DELETE CASCADE UNIQUE,
  
  theme TEXT DEFAULT 'dark',
  date_format TEXT DEFAULT 'DD/MM/YYYY',
  time_format TEXT DEFAULT '24h',
  
  invoice_prefix TEXT DEFAULT 'INV',
  invoice_next_number INTEGER DEFAULT 1,
  invoice_footer TEXT,
  
  whatsapp_enabled BOOLEAN DEFAULT FALSE,
  whatsapp_api_url TEXT,
  whatsapp_api_key TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- INDEXES
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_users_shop ON users(shop_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_customers_shop ON customers(shop_id);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_mechanics_shop ON mechanics(shop_id);
CREATE INDEX IF NOT EXISTS idx_jobs_shop ON jobs(shop_id);
CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_mechanic ON jobs(mechanic_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_number ON jobs(job_number);
CREATE INDEX IF NOT EXISTS idx_wa_messages_shop ON wa_messages(shop_id);
CREATE INDEX IF NOT EXISTS idx_activity_shop ON activity_logs(shop_id);

-- =====================================================
-- TRIGGER FUNCTION
-- =====================================================
DROP FUNCTION IF EXISTS update_updated_at() CASCADE;
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- TRIGGERS
-- =====================================================
DROP TRIGGER IF EXISTS update_shop_info_updated_at ON shop_info;
CREATE TRIGGER update_shop_info_updated_at BEFORE UPDATE ON shop_info FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_customers_updated_at ON customers;
CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_mechanics_updated_at ON mechanics;
CREATE TRIGGER update_mechanics_updated_at BEFORE UPDATE ON mechanics FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_jobs_updated_at ON jobs;
CREATE TRIGGER update_jobs_updated_at BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_shop_settings_updated_at ON shop_settings;
CREATE TRIGGER update_shop_settings_updated_at BEFORE UPDATE ON shop_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =====================================================
-- AUTO-GENERATE JOB NUMBER FUNCTION
-- =====================================================
DROP FUNCTION IF EXISTS generate_job_number() CASCADE;
CREATE OR REPLACE FUNCTION generate_job_number()
RETURNS TRIGGER AS $$
DECLARE
  seq_num INT;
  year_str TEXT;
  month_str TEXT;
BEGIN
  year_str := TO_CHAR(NOW(), 'YY');
  month_str := TO_CHAR(NOW(), 'MM');
  
  SELECT COALESCE(MAX(CAST(SUBSTRING(job_number FROM '-([0-9]+)$') AS INT)), 0) + 1
  INTO seq_num
  FROM jobs
  WHERE shop_id = NEW.shop_id 
    AND SUBSTRING(job_number FROM 5 FOR 4) = year_str || month_str;
  
  NEW.job_number := 'JOB-' || year_str || month_str || '-' || LPAD(seq_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_job_number ON jobs;
CREATE TRIGGER set_job_number 
  BEFORE INSERT ON jobs 
  FOR EACH ROW 
  EXECUTE FUNCTION generate_job_number();

-- =====================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- =====================================================
-- Disable RLS first
ALTER TABLE shop_info DISABLE ROW LEVEL SECURITY;
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
ALTER TABLE customers DISABLE ROW LEVEL SECURITY;
ALTER TABLE mechanics DISABLE ROW LEVEL SECURITY;
ALTER TABLE jobs DISABLE ROW LEVEL SECURITY;
ALTER TABLE wa_messages DISABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE shop_settings DISABLE ROW LEVEL SECURITY;

-- Drop existing policies
DROP POLICY IF EXISTS "Users see own shop data" ON shop_info;
DROP POLICY IF EXISTS "Users see own customers" ON customers;
DROP POLICY IF EXISTS "Users see own mechanics" ON mechanics;
DROP POLICY IF EXISTS "Users see own jobs" ON jobs;
DROP POLICY IF EXISTS "Admins can modify" ON customers;

-- Enable RLS
ALTER TABLE shop_info ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE mechanics ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_settings ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Users see own shop data" ON shop_info
  FOR SELECT
  USING (id IN (SELECT shop_id FROM users WHERE id = auth.uid()));

CREATE POLICY "Users see own customers" ON customers
  FOR SELECT
  USING (shop_id IN (SELECT shop_id FROM users WHERE id = auth.uid()));

CREATE POLICY "Users see own mechanics" ON mechanics
  FOR SELECT
  USING (shop_id IN (SELECT shop_id FROM users WHERE id = auth.uid()));

CREATE POLICY "Users see own jobs" ON jobs
  FOR SELECT
  USING (shop_id IN (SELECT shop_id FROM users WHERE id = auth.uid()));

CREATE POLICY "Admins can modify customers" ON customers
  FOR ALL
  USING (
    shop_id IN (SELECT shop_id FROM users WHERE id = auth.uid() AND role = 'admin')
  );

-- =====================================================
-- VERIFY SETUP
-- =====================================================
SELECT 
  tablename, 
  schemaname 
FROM pg_tables 
WHERE schemaname = 'public' 
  AND tablename IN ('shop_info', 'users', 'customers', 'mechanics', 'jobs', 'wa_messages', 'activity_logs', 'shop_settings')
ORDER BY tablename;