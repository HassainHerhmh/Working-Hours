import { v4 as uuid } from 'uuid';
import { queryAll, queryOne, execute } from './database.js';

export async function listCaptainGroups() {
  const rows = await queryAll(`
    SELECT g.id, g.name, g.created_at, COUNT(c.id) AS captains_count
    FROM captain_groups g
    LEFT JOIN captains c ON c.group_id = g.id
    GROUP BY g.id, g.name, g.created_at
    ORDER BY g.name ASC
  `);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    captains_count: Number(row.captains_count || 0),
  }));
}

export async function createCaptainGroup(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('اسم المجموعة مطلوب');
  const id = uuid();
  await execute('INSERT INTO captain_groups (id, name) VALUES (?, ?)', [id, trimmed]);
  return queryOne('SELECT id, name, created_at FROM captain_groups WHERE id = ?', [id]);
}

export async function updateCaptainGroup(id, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('اسم المجموعة مطلوب');
  const existing = await queryOne('SELECT id FROM captain_groups WHERE id = ?', [id]);
  if (!existing) throw new Error('المجموعة غير موجودة');
  await execute('UPDATE captain_groups SET name = ? WHERE id = ?', [trimmed, id]);
  return queryOne('SELECT id, name, created_at FROM captain_groups WHERE id = ?', [id]);
}

export async function deleteCaptainGroup(id) {
  const existing = await queryOne('SELECT id FROM captain_groups WHERE id = ?', [id]);
  if (!existing) throw new Error('المجموعة غير موجودة');
  await execute('UPDATE captains SET group_id = NULL WHERE group_id = ?', [id]);
  await execute('DELETE FROM captain_groups WHERE id = ?', [id]);
  return { ok: true };
}
