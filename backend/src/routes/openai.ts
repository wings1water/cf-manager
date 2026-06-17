import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import {
  selectBestAccount,
  getAccountsByPriorityWithAffinity,
  rememberAccountAffinity,
  clearAccountAffinity,
  clearCache,
} from '../services/accountRouter';
import { getAvailableModels } from '../services/aiService';
import { getAuthHeaders } from '../services/cfFactory';
import { getAiGatewayHeaders } from '../services/aiGatewayService';
import { createAuditLog } from '../models/auditLog';
import { setQuota } from '../models/quotaUsage';
import { proxyFetch } from '../services/proxyService';
import { appLogger } from '../services/logger';

const router = Router();

function isNeuronLimitError(text: string): boolean {
  return text.includes('4006') || text.includes('daily free allocation') || text.includes('neuron limit');
}

interface AiAffinityIds {
  primary: string;
  fallback?: string;
}

function hashAffinity(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function scopedAffinity(req: Request, value: string): string {
  const model = req.body?.model || '';
  return hashAffinity(`${model}|${value}`);
}

function extractTextContent(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') return part.text || part.content || '';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function truncateForAffinity(value: string): string {
  return value.slice(0, 200);
}

function extractTurnMetadataSession(req: Request): string {
  const metadata = req.body?.client_metadata || {};
  const rawTurnMetadata = metadata['x-codex-turn-metadata'];
  if (typeof rawTurnMetadata === 'string') {
    try {
      const turnMetadata = JSON.parse(rawTurnMetadata);
      return turnMetadata.prompt_cache_key || turnMetadata.window_id || turnMetadata.turn_id || '';
    } catch {
      return rawTurnMetadata;
    }
  }
  return '';
}

function extractExplicitSessionId(req: Request): string {
  const userId = req.body?.metadata?.user_id;
  if (typeof userId === 'string' && userId) {
    const match = userId.match(/_session_([a-f0-9-]+)$/i);
    if (match?.[1]) return `claude:${match[1]}`;
    if (userId.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(userId);
        if (parsed.session_id) return `claude:${parsed.session_id}`;
      } catch {
        return `user:${userId}`;
      }
    }
    return `user:${userId}`;
  }

  const headerSession =
    req.get('x-session-id') ||
    req.get('session-id') ||
    req.get('session_id') ||
    req.get('x-client-request-id');
  if (headerSession) return `header:${headerSession}`;

  const turnMetadataSession = extractTurnMetadataSession(req);
  if (turnMetadataSession) return `codex:${turnMetadataSession}`;

  if (typeof req.body?.prompt_cache_key === 'string' && req.body.prompt_cache_key) {
    return `cache:${req.body.prompt_cache_key}`;
  }

  if (typeof req.body?.conversation_id === 'string' && req.body.conversation_id) {
    return `conv:${req.body.conversation_id}`;
  }

  return '';
}

function extractMessageAffinityIds(req: Request): { primary: string; fallback?: string } | undefined {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  let systemPrompt = '';
  let firstUserMessage = '';
  let firstAssistantMessage = '';

  for (const message of messages) {
    const content = truncateForAffinity(extractTextContent(message?.content));
    if (!content) continue;

    if (message.role === 'system' && !systemPrompt) systemPrompt = content;
    if (message.role === 'user' && !firstUserMessage) firstUserMessage = content;
    if (message.role === 'assistant' && !firstAssistantMessage) firstAssistantMessage = content;

    if (systemPrompt && firstUserMessage && firstAssistantMessage) break;
  }

  if (!systemPrompt && !firstUserMessage) return undefined;

  const shortId = `msg:${hashAffinity(`${systemPrompt}|${firstUserMessage}|`)}`;
  if (!firstAssistantMessage) return { primary: shortId };

  return {
    primary: `msg:${hashAffinity(`${systemPrompt}|${firstUserMessage}|${firstAssistantMessage}`)}`,
    fallback: shortId,
  };
}

function getAiAccountAffinityIds(req: Request): AiAffinityIds {
  const explicitSession = extractExplicitSessionId(req);
  if (explicitSession) {
    return { primary: scopedAffinity(req, explicitSession) };
  }

  const messageAffinity = extractMessageAffinityIds(req);
  if (messageAffinity) {
    return {
      primary: scopedAffinity(req, messageAffinity.primary),
      fallback: messageAffinity.fallback ? scopedAffinity(req, messageAffinity.fallback) : undefined,
    };
  }

  return {
    primary: scopedAffinity(req, [
      req.get('authorization') || 'anonymous',
      req.get('user-agent') || '',
      req.get('x-forwarded-for') || req.ip || '',
    ].join('|')),
  };
}

function findCachedTokenCount(value: any): number | undefined {
  if (!value || typeof value !== 'object') return undefined;

  for (const [key, nestedValue] of Object.entries(value)) {
    if (/(cached.*tokens|tokens.*cached|cached.*token.*count|cache_read_input_tokens|cache_creation_input_tokens)/i.test(key) && typeof nestedValue === 'number') {
      return nestedValue;
    }

    const nestedCount = findCachedTokenCount(nestedValue);
    if (nestedCount !== undefined) return nestedCount;
  }

  return undefined;
}

router.get('/models', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = await selectBestAccount('ai_neurons');
    const models = await getAvailableModels(account);
    const data = models.map((m: any) => ({
      id: m.name || m.id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'cloudflare',
    }));
    res.json({ object: 'list', data });
  } catch (err) { next(err); }
});

router.post('/chat/completions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const affinity = getAiAccountAffinityIds(req);
    const accounts = await getAccountsByPriorityWithAffinity('ai_neurons', affinity.primary, affinity.fallback);
    if (accounts.length === 0) {
      res.status(503).json({
        error: { message: 'No active accounts available', type: 'service_error', code: 'NO_ACCOUNTS' },
      });
      return;
    }

    const isStream = req.body.stream === true;
    let lastError = '';

    for (const account of accounts) {
      if (!account.account_id) continue;

      const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/v1/chat/completions`;
      const headers = {
        'Content-Type': 'application/json',
        ...getAuthHeaders(account),
        ...getAiGatewayHeaders(affinity.primary),
      };

      const cfResp = await proxyFetch(cfUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(req.body),
      });

      if (!cfResp.ok) {
        const errorText = await cfResp.text();

        if (isNeuronLimitError(errorText)) {
          appLogger.warn(`[AI] Account ${account.name} neuron limit hit (4006)`);
          setQuota(account.id, 'ai_neurons', 10000);
          clearAccountAffinity('ai_neurons', affinity.primary);
          clearAccountAffinity('ai_neurons', affinity.fallback);
          clearCache();
          createAuditLog(account.id, 'ai_inference', req.body.model, '4006 neuron limit, switching', 'error');
          if (accounts.indexOf(account) < accounts.length - 1) {
            lastError = errorText;
            continue;
          }
        }

        res.status(cfResp.status).json({
          error: { message: errorText, type: 'upstream_error', code: cfResp.status },
        });
        return;
      }

      if (isStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        if (cfResp.body) {
          const body = cfResp.body as any;
          try {
            if (typeof body.getReader === 'function') {
              const reader = body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(Buffer.from(value));
              }
            } else if (typeof body.pipe === 'function') {
              await new Promise<void>((resolve, reject) => {
                body.pipe(res, { end: false });
                body.on('end', resolve);
                body.on('error', reject);
              });
            }
          } catch { /* client disconnected */ }
        }
        res.end();
        rememberAccountAffinity('ai_neurons', affinity.primary, account);
        createAuditLog(account.id, 'ai_inference', req.body.model, 'stream via /v1', 'success');
      } else {
        const data = await cfResp.json() as any;
        res.json(data);
        rememberAccountAffinity('ai_neurons', affinity.primary, account);
        const cachedTokens = findCachedTokenCount(data?.usage);
        createAuditLog(account.id, 'ai_inference', req.body.model,
          `tokens: ${data?.usage?.total_tokens || '?'}, cached_tokens: ${cachedTokens ?? 0}`, 'success');
      }
      return;
    }

    res.status(429).json({
      error: {
        message: 'All accounts have reached daily neuron limit',
        type: 'quota_exceeded',
        code: 'ALL_ACCOUNTS_EXHAUSTED',
      },
    });
  } catch (err) { next(err); }
});

export default router;
