import apiClient from './client';

export const settingsApi = {
  get: () => apiClient.get('/settings'),
  clearCache: () => apiClient.post('/settings/cache/clear'),
  testProxy: (proxyUrl: string) => apiClient.post('/settings/proxy/test', { proxy_url: proxyUrl }),
  saveAiGateway: (data: any) => apiClient.put('/settings/ai-gateway', data),
  syncAiGateway: (data: any) => apiClient.post('/settings/ai-gateway/sync', data, { timeout: 120000 }),
};
