const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 30 * 60 * 1000;
const MAX_ACCOUNT_ATTEMPTS = 5;
const MAX_IP_ATTEMPTS = 25;
const BASE_DELAY_MS = 800;
const MAX_DELAY_MS = 5000;

const accountAttempts = new Map();
const ipAttempts = new Map();

function now() {
  return Date.now();
}

function cleanupMap(map) {
  const cutoff = now() - Math.max(WINDOW_MS, LOCK_MS) * 2;
  for (const [key, entry] of map.entries()) {
    if ((entry.lockedUntil || 0) < cutoff && entry.firstAt < cutoff) {
      map.delete(key);
    }
  }
}

export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket?.remoteAddress || req.ip || 'unknown';
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function getAccountEntry(key) {
  if (!accountAttempts.has(key)) {
    accountAttempts.set(key, { count: 0, firstAt: now(), lockedUntil: 0 });
  }
  return accountAttempts.get(key);
}

function getIpEntry(ip) {
  if (!ipAttempts.has(ip)) {
    ipAttempts.set(ip, { count: 0, firstAt: now(), lockedUntil: 0 });
  }
  return ipAttempts.get(ip);
}

function isLocked(entry) {
  return entry.lockedUntil > now();
}

function lockEntry(entry, durationMs = LOCK_MS) {
  entry.lockedUntil = now() + durationMs;
}

function registerFailure(entry, maxAttempts) {
  const current = now();
  if (current - entry.firstAt > WINDOW_MS) {
    entry.count = 0;
    entry.firstAt = current;
    entry.lockedUntil = 0;
  }
  entry.count += 1;
  if (entry.count >= maxAttempts) {
    lockEntry(entry);
  }
}

function retryAfterSeconds(entry) {
  return Math.max(1, Math.ceil((entry.lockedUntil - now()) / 1000));
}

export function checkPlatformLoginAllowed(req, username) {
  cleanupMap(accountAttempts);
  cleanupMap(ipAttempts);

  const ip = getClientIp(req);
  const accountKey = `${ip}|${normalizeUsername(username)}`;
  const accountEntry = getAccountEntry(accountKey);
  const ipEntry = getIpEntry(ip);

  if (isLocked(ipEntry)) {
    return {
      allowed: false,
      retryAfter: retryAfterSeconds(ipEntry),
      reason: 'ip',
    };
  }

  if (isLocked(accountEntry)) {
    return {
      allowed: false,
      retryAfter: retryAfterSeconds(accountEntry),
      reason: 'account',
    };
  }

  return { allowed: true, delayMs: Math.min(BASE_DELAY_MS + accountEntry.count * 700, MAX_DELAY_MS) };
}

export function recordPlatformLoginFailure(req, username) {
  const ip = getClientIp(req);
  const accountKey = `${ip}|${normalizeUsername(username)}`;
  registerFailure(getAccountEntry(accountKey), MAX_ACCOUNT_ATTEMPTS);
  registerFailure(getIpEntry(ip), MAX_IP_ATTEMPTS);
}

export function clearPlatformLoginFailures(req, username) {
  const ip = getClientIp(req);
  const accountKey = `${ip}|${normalizeUsername(username)}`;
  accountAttempts.delete(accountKey);
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
