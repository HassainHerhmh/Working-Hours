-- تشغيل هذا الملف في Railway MySQL Console (اختياري — التطبيق ينشئ الجداول تلقائياً)
-- Run in Railway MySQL → Database → Query

CREATE TABLE IF NOT EXISTS captains (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(20) NOT NULL UNIQUE,
  captain_number VARCHAR(50) NOT NULL UNIQUE,
  username VARCHAR(50) UNIQUE,
  photo VARCHAR(500) DEFAULT '',
  password_hash VARCHAR(255) DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS shifts (
  id VARCHAR(36) PRIMARY KEY,
  captain_id VARCHAR(36) NOT NULL,
  day_of_week TINYINT NOT NULL,
  start_time VARCHAR(10) NOT NULL,
  end_time VARCHAR(10) NOT NULL,
  period1_end VARCHAR(10) DEFAULT '12:00',
  break_hours DECIMAL(4,1) DEFAULT 2,
  break_minutes INT DEFAULT 120,
  period2_start VARCHAR(10) DEFAULT '14:00',
  period_count TINYINT DEFAULT 2,
  is_active TINYINT DEFAULT 1,
  UNIQUE KEY uniq_captain_day (captain_id, day_of_week),
  FOREIGN KEY (captain_id) REFERENCES captains(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sms_messages (
  id VARCHAR(36) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  captain_id VARCHAR(36) NULL,
  scheduled_at DATETIME NOT NULL,
  repeat_type ENUM('once','daily','weekly') DEFAULT 'once',
  is_active TINYINT DEFAULT 1,
  last_sent_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (captain_id) REFERENCES captains(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sms_log (
  id VARCHAR(36) PRIMARY KEY,
  message_id VARCHAR(36) NULL,
  captain_id VARCHAR(36) NULL,
  captain_name VARCHAR(255) NULL,
  captain_phone VARCHAR(20) NULL,
  body TEXT NOT NULL,
  status ENUM('pending','sent','delivered','failed') DEFAULT 'sent',
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  source VARCHAR(50) DEFAULT 'gateway',
  FOREIGN KEY (message_id) REFERENCES sms_messages(id) ON DELETE SET NULL,
  FOREIGN KEY (captain_id) REFERENCES captains(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE,
  phone VARCHAR(20) NULL,
  role ENUM('admin','manager','employee') DEFAULT 'employee',
  status ENUM('active','inactive') DEFAULT 'active',
  photo VARCHAR(500) DEFAULT '',
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sms_queue (
  id VARCHAR(36) PRIMARY KEY,
  recipient_phone VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  message_id VARCHAR(36) NULL,
  captain_id VARCHAR(36) NULL,
  captain_name VARCHAR(255) NULL,
  sms_type VARCHAR(50) DEFAULT 'shift',
  status ENUM('pending','sent','failed') DEFAULT 'pending',
  error_message VARCHAR(500) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  sent_at DATETIME NULL,
  FOREIGN KEY (message_id) REFERENCES sms_messages(id) ON DELETE SET NULL,
  FOREIGN KEY (captain_id) REFERENCES captains(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sms_gateway_heartbeat (
  id INT PRIMARY KEY DEFAULT 1,
  last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS shift_reminder_config (
  id INT PRIMARY KEY DEFAULT 1,
  send_time VARCHAR(5) NOT NULL DEFAULT '09:00',
  body_work TEXT NOT NULL,
  body_off TEXT NOT NULL,
  is_active TINYINT DEFAULT 0,
  last_sent_date VARCHAR(10) NULL
);

CREATE TABLE IF NOT EXISTS attendance_checkins (
  id VARCHAR(36) PRIMARY KEY,
  captain_id VARCHAR(36) NOT NULL,
  check_date VARCHAR(10) NOT NULL,
  checked_in_at DATETIME NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_captain_date (captain_id, check_date),
  FOREIGN KEY (captain_id) REFERENCES captains(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS finance_config (
  id INT PRIMARY KEY DEFAULT 1,
  company_commission_rate DECIMAL(5,2) DEFAULT 20
);

CREATE TABLE IF NOT EXISTS finance_stores (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  is_active TINYINT DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS captain_finances (
  captain_id VARCHAR(36) PRIMARY KEY,
  transfers_debts DECIMAL(12,2) DEFAULT 0,
  rent DECIMAL(12,2) DEFAULT 0,
  total_commission DECIMAL(12,2) DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (captain_id) REFERENCES captains(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS captain_store_invoices (
  id VARCHAR(36) PRIMARY KEY,
  captain_id VARCHAR(36) NOT NULL,
  store_id VARCHAR(36) NOT NULL,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  sales_date VARCHAR(10) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_captain_store_date (captain_id, store_id, sales_date),
  FOREIGN KEY (captain_id) REFERENCES captains(id) ON DELETE CASCADE,
  FOREIGN KEY (store_id) REFERENCES finance_stores(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS finance_vouchers (
  id VARCHAR(36) PRIMARY KEY,
  captain_id VARCHAR(36) NOT NULL,
  voucher_type VARCHAR(20) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  note VARCHAR(500) DEFAULT '',
  voucher_date VARCHAR(10) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (captain_id) REFERENCES captains(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS finance_invoice_postings (
  id VARCHAR(36) PRIMARY KEY,
  captain_id VARCHAR(36) NOT NULL,
  total_invoices DECIMAL(12,2) NOT NULL DEFAULT 0,
  transfers_debts DECIMAL(12,2) NOT NULL DEFAULT 0,
  sales_date VARCHAR(10) NOT NULL,
  posted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_captain_invoice_sales_date (captain_id, sales_date),
  FOREIGN KEY (captain_id) REFERENCES captains(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS finance_commission_postings (
  id VARCHAR(36) PRIMARY KEY,
  captain_id VARCHAR(36) NOT NULL,
  total_commission DECIMAL(12,2) NOT NULL DEFAULT 0,
  rent DECIMAL(12,2) NOT NULL DEFAULT 0,
  sales_date VARCHAR(10) NOT NULL,
  posted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_captain_commission_sales_date (captain_id, sales_date),
  FOREIGN KEY (captain_id) REFERENCES captains(id) ON DELETE CASCADE
);
