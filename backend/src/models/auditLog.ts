import { getDb } from '../db';

export interface AuditLog {
  id: number;
  account_id: number | null;
  action: string;
  target: string | null;
  detail: string | null;
  status: 'success' | 'error';
  created_at: string;
}

export function createAuditLog(
  accountId: number | null,
  action: string,
  target: string | null,
  detail: string | null,
  status: 'success' | 'error'
): void {
  getDb()
    .prepare('INSERT INTO audit_log (account_id, action, target, detail, status) VALUES (?, ?, ?, ?, ?)')
    .run(accountId, action, target, detail, status);
}

export interface AuditLogWithName extends AuditLog {
  account_name: string | null;
}

export function getRecentLogs(limit: number = 20): AuditLogWithName[] {
  return getDb()
    .prepare(
      `SELECT a.*, acc.name AS account_name
       FROM audit_log a
       LEFT JOIN accounts acc ON a.account_id = acc.id
       ORDER BY a.created_at DESC LIMIT ?`
    )
    .all(limit) as AuditLogWithName[];
}

export interface AiCacheStats {
  totalTokens: number;
  cachedTokens: number;
  totalRequests: number;
  cacheHitRequests: number;
  cacheHitRate: number;
}

function parseNumber(detail: string | null, key: string): number {
  if (!detail) return 0;
  const match = detail.match(new RegExp(`${key}:\\s*([0-9,]+)`));
  if (!match) return 0;
  return Number(match[1].replace(/,/g, '')) || 0;
}

function parseGatewayCacheStatus(detail: string | null): string {
  if (!detail) return '';
  const match = detail.match(/gateway_cache:\s*([a-z]+)/i);
  return match?.[1]?.toUpperCase() || '';
}

export function getAiCacheStatsToday(): AiCacheStats {
  const rows = getDb()
    .prepare(
      `SELECT detail
       FROM audit_log
       WHERE action = 'ai_inference'
         AND status = 'success'
         AND date(created_at) = date('now')`
    )
    .all() as Array<{ detail: string | null }>;

  let totalTokens = 0;
  let cachedTokens = 0;
  let cacheHitRequests = 0;

  for (const row of rows) {
    const total = parseNumber(row.detail, 'tokens');
    const cached = parseNumber(row.detail, 'cached_tokens');
    const gatewayCacheStatus = parseGatewayCacheStatus(row.detail);
    totalTokens += total;
    cachedTokens += cached;
    if (cached > 0 || gatewayCacheStatus === 'HIT') cacheHitRequests++;
  }

  return {
    totalTokens,
    cachedTokens,
    totalRequests: rows.length,
    cacheHitRequests,
    cacheHitRate: rows.length > 0 ? Math.round((cacheHitRequests / rows.length) * 10000) / 100 : 0,
  };
}
