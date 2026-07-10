import { execute, isMySQL } from './database.js';

function readTimestampExpr() {
  return isMySQL ? 'NOW()' : "datetime('now')";
}

export async function markChatReadByPlatform(captainId) {
  await execute(
    `UPDATE chat_messages
     SET read_by_platform_at = ${readTimestampExpr()}
     WHERE captain_id = ? AND sender_type = 'captain' AND read_by_platform_at IS NULL`,
    [captainId]
  );
  return { ok: true };
}

export async function markChatReadByCaptain(captainId) {
  await execute(
    `UPDATE chat_messages
     SET read_by_captain_at = ${readTimestampExpr()}
     WHERE captain_id = ? AND sender_type = 'platform' AND read_by_captain_at IS NULL`,
    [captainId]
  );
  return { ok: true };
}
