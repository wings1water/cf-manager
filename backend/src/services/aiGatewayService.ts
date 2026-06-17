import { config } from '../config';
import { getSetting, setSetting } from '../db';
import { Account, getActiveAccountsByFeature } from '../models/account';
import { createAuditLog } from '../models/auditLog';
import { getAuthHeaders } from './cfFactory';
import { proxyFetch } from './proxyService';

export interface AiGatewaySettings {
  gateway_id: string;
  cache_ttl: number;
  collect_logs: boolean;
  cache_invalidate_on_update: boolean;
  rate_limiting_interval: number;
  rate_limiting_limit: number;
}

export interface AiGatewaySyncResult {
  accountId: number;
  accountName: string;
  cloudflareAccountId: string | null;
  status: 'created' | 'updated' | 'failed' | 'skipped';
  message: string;
}

function toNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function toBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === 'true';
}

function readSetting(key: string, fallback: string): string {
  const dbValue = getSetting(key);
  return dbValue !== undefined ? dbValue : fallback;
}

export function getAiGatewaySettings(): AiGatewaySettings {
  return {
    gateway_id: readSetting('ai_gateway_id', config.aiGatewayId),
    cache_ttl: toNumber(readSetting('ai_gateway_cache_ttl', config.aiGatewayCacheTtl), 600),
    collect_logs: toBoolean(readSetting('ai_gateway_collect_logs', 'true'), true),
    cache_invalidate_on_update: toBoolean(readSetting('ai_gateway_cache_invalidate_on_update', 'false'), false),
    rate_limiting_interval: toNumber(readSetting('ai_gateway_rate_limiting_interval', '0'), 0),
    rate_limiting_limit: toNumber(readSetting('ai_gateway_rate_limiting_limit', '0'), 0),
  };
}

export function saveAiGatewaySettings(input: Partial<AiGatewaySettings>): AiGatewaySettings {
  const current = getAiGatewaySettings();
  const next: AiGatewaySettings = {
    gateway_id: typeof input.gateway_id === 'string' ? input.gateway_id.trim() : current.gateway_id,
    cache_ttl: Number.isFinite(input.cache_ttl) && Number(input.cache_ttl) >= 0 ? Number(input.cache_ttl) : current.cache_ttl,
    collect_logs: typeof input.collect_logs === 'boolean' ? input.collect_logs : current.collect_logs,
    cache_invalidate_on_update: typeof input.cache_invalidate_on_update === 'boolean'
      ? input.cache_invalidate_on_update
      : current.cache_invalidate_on_update,
    rate_limiting_interval: Number.isFinite(input.rate_limiting_interval) && Number(input.rate_limiting_interval) >= 0
      ? Number(input.rate_limiting_interval)
      : current.rate_limiting_interval,
    rate_limiting_limit: Number.isFinite(input.rate_limiting_limit) && Number(input.rate_limiting_limit) >= 0
      ? Number(input.rate_limiting_limit)
      : current.rate_limiting_limit,
  };

  setSetting('ai_gateway_id', next.gateway_id);
  setSetting('ai_gateway_cache_ttl', String(next.cache_ttl));
  setSetting('ai_gateway_collect_logs', String(next.collect_logs));
  setSetting('ai_gateway_cache_invalidate_on_update', String(next.cache_invalidate_on_update));
  setSetting('ai_gateway_rate_limiting_interval', String(next.rate_limiting_interval));
  setSetting('ai_gateway_rate_limiting_limit', String(next.rate_limiting_limit));

  return next;
}

export function getAiGatewayHeaders(sessionAffinity?: string): Record<string, string> {
  const settings = getAiGatewaySettings();
  const headers: Record<string, string> = {};

  if (settings.gateway_id) {
    headers['cf-aig-gateway-id'] = settings.gateway_id;
  }

  if (settings.cache_ttl > 0) {
    headers['cf-aig-cache-ttl'] = String(settings.cache_ttl);
  }

  if (sessionAffinity) {
    headers['x-session-affinity'] = sessionAffinity;
  }

  return headers;
}

function gatewayPayload(settings: AiGatewaySettings, includeId: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    cache_invalidate_on_update: settings.cache_invalidate_on_update,
    cache_ttl: settings.cache_ttl,
    collect_logs: settings.collect_logs,
    rate_limiting_interval: settings.rate_limiting_interval,
    rate_limiting_limit: settings.rate_limiting_limit,
  };

  if (includeId) payload.id = settings.gateway_id;
  return payload;
}

async function parseCfError(resp: Awaited<ReturnType<typeof proxyFetch>>): Promise<string> {
  const text = await resp.text();
  try {
    const body = JSON.parse(text);
    const errors = Array.isArray(body?.errors) ? body.errors : [];
    if (errors.length) {
      return errors.map((e: any) => e.message || e.code || JSON.stringify(e)).join('; ');
    }
    return body?.message || text;
  } catch {
    return text || `HTTP ${resp.status}`;
  }
}

async function applyGatewayToAccount(account: Account, settings: AiGatewaySettings): Promise<AiGatewaySyncResult> {
  if (!account.account_id) {
    return {
      accountId: account.id,
      accountName: account.name,
      cloudflareAccountId: null,
      status: 'skipped',
      message: '缺少 Cloudflare Account ID，请先测试连接',
    };
  }

  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai-gateway/gateways`;
  const headers = { 'Content-Type': 'application/json', ...getAuthHeaders(account) };

  const createResp = await proxyFetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(gatewayPayload(settings, true)),
  });

  if (createResp.ok) {
    createAuditLog(account.id, 'ai_gateway_sync', settings.gateway_id, 'created', 'success');
    return {
      accountId: account.id,
      accountName: account.name,
      cloudflareAccountId: account.account_id,
      status: 'created',
      message: '已创建',
    };
  }

  const createError = await parseCfError(createResp);
  if (createResp.status !== 409 && !/already|exist/i.test(createError)) {
    createAuditLog(account.id, 'ai_gateway_sync', settings.gateway_id, createError, 'error');
    return {
      accountId: account.id,
      accountName: account.name,
      cloudflareAccountId: account.account_id,
      status: 'failed',
      message: createError,
    };
  }

  const updateResp = await proxyFetch(`${baseUrl}/${encodeURIComponent(settings.gateway_id)}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(gatewayPayload(settings, false)),
  });

  if (updateResp.ok) {
    createAuditLog(account.id, 'ai_gateway_sync', settings.gateway_id, 'updated', 'success');
    return {
      accountId: account.id,
      accountName: account.name,
      cloudflareAccountId: account.account_id,
      status: 'updated',
      message: '已更新',
    };
  }

  const message = await parseCfError(updateResp);
  createAuditLog(account.id, 'ai_gateway_sync', settings.gateway_id, message, 'error');
  return {
    accountId: account.id,
    accountName: account.name,
    cloudflareAccountId: account.account_id,
    status: 'failed',
    message,
  };
}

export async function syncAiGatewayToAllAccounts(input?: Partial<AiGatewaySettings>): Promise<{
  settings: AiGatewaySettings;
  results: AiGatewaySyncResult[];
}> {
  const settings = input ? saveAiGatewaySettings(input) : getAiGatewaySettings();

  if (!settings.gateway_id) {
    throw Object.assign(new Error('AI Gateway ID is required'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  }

  const accounts = getActiveAccountsByFeature('ai');
  const results: AiGatewaySyncResult[] = [];

  for (const account of accounts) {
    try {
      results.push(await applyGatewayToAccount(account, settings));
    } catch (err: any) {
      const message = err?.message || String(err);
      createAuditLog(account.id, 'ai_gateway_sync', settings.gateway_id, message, 'error');
      results.push({
        accountId: account.id,
        accountName: account.name,
        cloudflareAccountId: account.account_id,
        status: 'failed',
        message,
      });
    }
  }

  return { settings, results };
}
