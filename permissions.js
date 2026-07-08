export const PERMISSION_ACTIONS = ['view', 'create', 'edit', 'delete', 'print'];

export const PERMISSION_SECTION_KEYS = [
  'dashboard',
  'users',
  'user_permissions',
  'captains',
  'shifts',
  'messages',
  'orders',
  'finance',
  'reports_attendance',
  'reports_sales',
  'reports_commissions',
  'reports_rent',
  'reports_stores',
  'reports_account_statement',
];

function emptySection() {
  return PERMISSION_ACTIONS.reduce((acc, action) => {
    acc[action] = false;
    return acc;
  }, {});
}

export function createEmptyPermissions(value = false) {
  return PERMISSION_SECTION_KEYS.reduce((acc, key) => {
    acc[key] = PERMISSION_ACTIONS.reduce((actions, action) => {
      actions[action] = value;
      return actions;
    }, {});
    return acc;
  }, {});
}

export function createFullPermissions() {
  return createEmptyPermissions(true);
}

export function parsePermissions(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return normalizePermissions(raw);
  try {
    return normalizePermissions(JSON.parse(String(raw)));
  } catch {
    return null;
  }
}

export function normalizePermissions(input) {
  const empty = createEmptyPermissions(false);
  if (!input || typeof input !== 'object') return empty;

  for (const section of PERMISSION_SECTION_KEYS) {
    const row = input[section];
    if (!row || typeof row !== 'object') continue;
    for (const action of PERMISSION_ACTIONS) {
      const addAlias = action === 'create' ? row.add : undefined;
      empty[section][action] = Boolean(row[action] || addAlias);
    }
  }

  return empty;
}

export function defaultPermissionsForRole(role) {
  const key = String(role || 'employee').toLowerCase();
  if (key === 'admin') return createFullPermissions();

  const perms = createEmptyPermissions(false);
  const allow = (section, actions) => {
    actions.forEach((action) => {
      perms[section][action] = true;
    });
  };

  if (key === 'manager') {
    PERMISSION_SECTION_KEYS.forEach((section) => {
      if (section === 'user_permissions') return;
      allow(section, ['view', 'create', 'edit', 'print']);
    });
    allow('users', ['delete']);
    allow('captains', ['delete']);
    allow('orders', ['delete']);
    return perms;
  }

  allow('dashboard', ['view']);
  allow('orders', ['view', 'create', 'edit', 'print']);
  allow('captains', ['view']);
  allow('reports_attendance', ['view', 'print']);
  allow('reports_sales', ['view', 'print']);
  return perms;
}

export function resolveUserPermissions(user) {
  const parsed = parsePermissions(user?.permissions);
  if (parsed) return parsed;
  return defaultPermissionsForRole(user?.role);
}

export async function getUserPermissions(userId, queryOne) {
  const user = await queryOne('SELECT id, role, permissions FROM users WHERE id = ?', [userId]);
  if (!user) throw new Error('المستخدم غير موجود');
  return {
    user_id: user.id,
    role: user.role,
    permissions: resolveUserPermissions(user),
  };
}

export async function saveUserPermissions(userId, { role, permissions }, { queryOne, execute }) {
  const user = await queryOne('SELECT id FROM users WHERE id = ?', [userId]);
  if (!user) throw new Error('المستخدم غير موجود');

  const nextRole = ['admin', 'manager', 'employee'].includes(String(role || '').toLowerCase())
    ? String(role).toLowerCase()
    : 'employee';
  const nextPermissions = normalizePermissions(permissions);

  await execute(
    'UPDATE users SET role = ?, permissions = ? WHERE id = ?',
    [nextRole, JSON.stringify(nextPermissions), userId]
  );

  return {
    success: true,
    user_id: userId,
    role: nextRole,
    permissions: nextPermissions,
  };
}
