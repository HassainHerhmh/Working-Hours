-- تشغيل هذا الملف في Railway MySQL Console (اختياري — التطبيق ينشئ الجداول تلقائياً)
-- Run in Railway MySQL → Database → Query

CREATE TABLE IF NOT EXISTS captains (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(20) NOT NULL UNIQUE,
  captain_number VARCHAR(50) NOT NULL UNIQUE,
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
