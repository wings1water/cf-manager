<template>
  <div>
    <n-h2>设置</n-h2>

    <n-card title="配置状态" size="small" style="margin-bottom: 16px">
      <n-spin :show="loading">
        <n-descriptions :column="1" bordered label-placement="left">
          <n-descriptions-item label="加密密钥">
            <n-tag :type="settings.encryption_key_configured ? 'success' : 'error'" size="small">
              {{ settings.encryption_key_configured ? '已配置' : '未配置' }}
            </n-tag>
          </n-descriptions-item>
          <n-descriptions-item label="API Secret">
            <n-tag :type="settings.api_secret_configured ? 'success' : 'error'" size="small">
              {{ settings.api_secret_configured ? '已配置' : '未配置' }}
            </n-tag>
          </n-descriptions-item>
          <n-descriptions-item label="数据库路径">
            <n-text>{{ settings.db_path || '-' }}</n-text>
          </n-descriptions-item>
        </n-descriptions>
      </n-spin>
    </n-card>

    <n-card title="代理设置" size="small" style="margin-bottom: 16px">
      <n-space vertical>
        <n-input-group>
          <n-input v-model:value="proxyUrl" placeholder="例如: http://127.0.0.1:7890 或 socks5://127.0.0.1:1080" clearable style="flex: 1" />
          <n-button type="info" :loading="proxyTesting" :disabled="!proxyUrl" @click="testProxy">测试</n-button>
          <n-button type="primary" :loading="proxySaving" @click="saveProxy">保存</n-button>
        </n-input-group>
        <n-text depth="3" style="font-size: 12px">
          支持 HTTP/HTTPS 和 SOCKS5 代理协议，留空则不使用代理。所有 Cloudflare API 请求（SDK + 原生 fetch）均会通过此代理。
        </n-text>
      </n-space>
    </n-card>

    <n-card title="AI Gateway 统一管理" size="small" style="margin-bottom: 16px">
      <n-space vertical>
        <n-alert type="info" :bordered="false">
          保存后会立即影响新的 AI 请求；点击同步会在所有启用 AI 的活跃账号下创建或更新同名 Gateway。
        </n-alert>
        <n-form label-placement="left" label-width="120">
          <n-form-item label="Gateway ID">
            <n-input v-model:value="aiGatewayForm.gateway_id" placeholder="例如: default" />
          </n-form-item>
          <n-form-item label="缓存 TTL">
            <n-input-number v-model:value="aiGatewayForm.cache_ttl" :min="0" placeholder="600" style="width: 180px" />
          </n-form-item>
          <n-form-item label="采集日志">
            <n-switch v-model:value="aiGatewayForm.collect_logs" />
          </n-form-item>
          <n-form-item label="更新清缓存">
            <n-switch v-model:value="aiGatewayForm.cache_invalidate_on_update" />
          </n-form-item>
          <n-form-item label="限流窗口">
            <n-input-number v-model:value="aiGatewayForm.rate_limiting_interval" :min="0" placeholder="0" style="width: 180px" />
          </n-form-item>
          <n-form-item label="限流请求数">
            <n-input-number v-model:value="aiGatewayForm.rate_limiting_limit" :min="0" placeholder="0" style="width: 180px" />
          </n-form-item>
        </n-form>
        <n-space>
          <n-button type="primary" :loading="aiGatewaySaving" @click="saveAiGateway">保存配置</n-button>
          <n-button type="info" :loading="aiGatewaySyncing" :disabled="!aiGatewayForm.gateway_id" @click="syncAiGateway">
            同步到所有 AI 账号
          </n-button>
        </n-space>
        <n-data-table
          v-if="aiGatewayResults.length"
          :columns="aiGatewayColumns"
          :data="aiGatewayResults"
          :bordered="false"
          size="small"
          :scroll-x="760"
        />
      </n-space>
    </n-card>

    <n-card title="缓存管理" size="small" style="margin-bottom: 16px">
      <n-space>
        <n-button type="warning" @click="handleClearCache" :loading="clearing">清除缓存</n-button>
      </n-space>
    </n-card>

    <!-- 定时任务 -->
    <n-card size="small">
      <template #header>
        定时任务
        <n-tag size="small" type="warning" style="margin-left: 8px; vertical-align: middle">任务逻辑待实现</n-tag>
      </template>
      <template #header-extra>
        <n-button size="small" type="primary" @click="openTaskModal()">添加任务</n-button>
      </template>
      <n-spin :show="tasksLoading">
        <n-data-table v-if="tasks.length" :columns="taskColumns" :data="tasks" :bordered="false" size="small" :scroll-x="600" />
        <n-empty v-else-if="!tasksLoading" description="暂无定时任务" />
      </n-spin>
    </n-card>

    <!-- 添加/编辑任务 Modal -->
    <n-modal v-model:show="showTaskModal" preset="dialog" :title="editingTaskId ? '编辑任务' : '添加任务'" style="width: 550px; max-width: 95vw">
      <n-form label-placement="left" label-width="100">
        <n-form-item label="任务名称">
          <n-input v-model:value="taskForm.name" placeholder="例如: 每日配额报告" />
        </n-form-item>
        <n-form-item label="任务类型">
          <n-select v-model:value="taskForm.type" :options="taskTypeOptions" @update:value="onTaskTypeChange" />
        </n-form-item>
        <n-text v-if="currentTypeDesc" depth="3" style="display: block; margin: -8px 0 12px 100px; font-size: 12px">{{ currentTypeDesc }}</n-text>

        <!-- 动态配置: 账号选择 -->
        <n-form-item v-if="taskNeedsAccount" label="账号">
          <n-select v-model:value="taskConfig.accountId" :options="accountOptions" placeholder="选择账号" />
        </n-form-item>

        <!-- KV 清理配置 -->
        <template v-if="taskForm.type === 'kv_cleanup'">
          <n-form-item label="命名空间 ID">
            <n-input v-model:value="taskConfig.namespaceId" placeholder="KV Namespace ID" />
          </n-form-item>
          <n-form-item label="Key 前缀">
            <n-input v-model:value="taskConfig.prefix" placeholder="仅清理指定前缀（可选）" />
          </n-form-item>
        </template>

        <!-- D1 备份配置 -->
        <template v-if="taskForm.type === 'd1_backup'">
          <n-form-item label="数据库 ID">
            <n-input v-model:value="taskConfig.databaseId" placeholder="D1 Database UUID" />
          </n-form-item>
        </template>

        <!-- R2 清理配置 -->
        <template v-if="taskForm.type === 'r2_cleanup'">
          <n-form-item label="存储桶">
            <n-input v-model:value="taskConfig.bucket" placeholder="Bucket 名称" />
          </n-form-item>
          <n-form-item label="最大保留天数">
            <n-input-number v-model:value="taskConfig.maxAgeDays" :min="1" :max="365" placeholder="30" />
          </n-form-item>
          <n-form-item label="前缀过滤">
            <n-input v-model:value="taskConfig.prefix" placeholder="仅清理指定前缀（可选）" />
          </n-form-item>
        </template>

        <n-form-item label="Cron 表达式">
          <n-input v-model:value="taskForm.cron" placeholder="例如: 0 8 * * *" />
        </n-form-item>
        <n-text depth="3" style="display: block; margin: -8px 0 0 100px; font-size: 12px">
          格式: 分 时 日 月 周 | 例: 0 8 * * * (每天8点), */30 * * * * (每30分钟), 0 0 * * 1 (每周一)
        </n-text>
      </n-form>
      <template #action>
        <n-button @click="showTaskModal = false">取消</n-button>
        <n-button type="primary" :loading="taskSaving" @click="handleSaveTask">保存</n-button>
      </template>
    </n-modal>

    <!-- 执行历史 Drawer -->
    <n-drawer v-model:show="showHistoryDrawer" :width="drawerWidth(520)" placement="right">
      <n-drawer-content :title="`执行历史 - ${historyTaskName}`" closable>
        <n-spin :show="historyLoading">
          <n-timeline>
            <n-timeline-item v-for="h in taskHistory" :key="h.id" :type="h.status === 'success' ? 'success' : h.status === 'error' ? 'error' : 'info'" :title="h.status" :content="h.detail || '-'" :time="h.started_at ? formatCN(h.started_at) : '-'" />
          </n-timeline>
          <n-empty v-if="!taskHistory.length && !historyLoading" description="暂无执行记录" />
        </n-spin>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, h, onMounted } from 'vue';
import { NButton, NSpace, NTag, NSwitch, useMessage } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { settingsApi } from '../api/settings';
import { tasksApi } from '../api/storage';
import apiClient from '../api/client';
import { useAccountStore } from '../stores/accountStore';
import { formatCN } from '../utils/dateFormat';

const message = useMessage();

function drawerWidth(desktopWidth: number): number {
  return window.innerWidth <= 768 ? Math.min(window.innerWidth, desktopWidth) : desktopWidth;
}
const accountStore = useAccountStore();
const loading = ref(false);
const clearing = ref(false);
const settings = ref<any>({});
const proxyUrl = ref('');
const proxySaving = ref(false);
const proxyTesting = ref(false);
const aiGatewaySaving = ref(false);
const aiGatewaySyncing = ref(false);
const aiGatewayResults = ref<any[]>([]);
const aiGatewayForm = ref({
  gateway_id: '',
  cache_ttl: 600,
  collect_logs: true,
  cache_invalidate_on_update: false,
  rate_limiting_interval: 0,
  rate_limiting_limit: 0,
});

async function fetchSettings() {
  loading.value = true;
  try {
    const { data } = await settingsApi.get();
    settings.value = data;
    proxyUrl.value = data.proxy_url || '';
    if (data.ai_gateway) {
      aiGatewayForm.value = normalizeAiGatewaySettings(data.ai_gateway);
    }
  } catch {
    settings.value = {};
  } finally {
    loading.value = false;
  }
}

function normalizeAiGatewaySettings(data: any) {
  return {
    gateway_id: data.gateway_id || '',
    cache_ttl: Number(data.cache_ttl ?? 600),
    collect_logs: data.collect_logs !== false,
    cache_invalidate_on_update: data.cache_invalidate_on_update === true,
    rate_limiting_interval: Number(data.rate_limiting_interval ?? 0),
    rate_limiting_limit: Number(data.rate_limiting_limit ?? 0),
  };
}

async function saveAiGateway() {
  aiGatewaySaving.value = true;
  try {
    const { data } = await settingsApi.saveAiGateway(aiGatewayForm.value);
    aiGatewayForm.value = normalizeAiGatewaySettings(data);
    message.success('AI Gateway 配置已保存');
  } finally {
    aiGatewaySaving.value = false;
  }
}

async function syncAiGateway() {
  if (!aiGatewayForm.value.gateway_id) {
    message.warning('请先填写 Gateway ID');
    return;
  }
  aiGatewaySyncing.value = true;
  try {
    const { data } = await settingsApi.syncAiGateway(aiGatewayForm.value);
    aiGatewayForm.value = normalizeAiGatewaySettings(data.settings);
    aiGatewayResults.value = Array.isArray(data.results) ? data.results : [];
    const failed = aiGatewayResults.value.filter((item) => item.status === 'failed').length;
    if (failed) {
      message.warning(`同步完成，${failed} 个账号失败`);
    } else {
      message.success('AI Gateway 已同步到所有 AI 账号');
    }
  } finally {
    aiGatewaySyncing.value = false;
  }
}

async function saveProxy() {
  proxySaving.value = true;
  try {
    await apiClient.put('/settings/proxy', { proxy_url: proxyUrl.value });
    message.success('代理设置已保存');
  } catch {
    message.error('保存代理设置失败');
  } finally {
    proxySaving.value = false;
  }
}

async function testProxy() {
  if (!proxyUrl.value) return;
  proxyTesting.value = true;
  try {
    const { data } = await settingsApi.testProxy(proxyUrl.value);
    message.success(`代理可用！延迟 ${data.latency_ms}ms，HTTP ${data.status}`);
  } catch (err: any) {
    const msg = err?.response?.data?.error?.message || err?.message || '连接失败';
    message.error(`代理不可用：${msg}`);
  } finally {
    proxyTesting.value = false;
  }
}

async function handleClearCache() {
  clearing.value = true;
  try {
    await settingsApi.clearCache();
    message.success('缓存已清除');
  } finally {
    clearing.value = false;
  }
}

// ============ Tasks ============
const tasks = ref<any[]>([]);
const tasksLoading = ref(false);
const showTaskModal = ref(false);
const editingTaskId = ref<number | null>(null);
const taskForm = ref({ name: '', type: 'quota_report', cron: '0 8 * * *' });
const taskConfig = ref<any>({ accountId: null, namespaceId: '', databaseId: '', bucket: '', maxAgeDays: 30, prefix: '' });
const taskSaving = ref(false);
const showHistoryDrawer = ref(false);
const historyTaskName = ref('');
const taskHistory = ref<any[]>([]);
const historyLoading = ref(false);

const taskTypeOptions = [
  { label: '配额使用报告（未实现）', value: 'quota_report' },
  { label: 'KV 过期清理（未实现）', value: 'kv_cleanup' },
  { label: 'D1 数据库备份（未实现）', value: 'd1_backup' },
  { label: 'R2 过期文件清理（未实现）', value: 'r2_cleanup' },
];

const taskTypeDescMap: Record<string, string> = {
  quota_report: '[未实现] 定期检查 Workers / Pages 的请求量配额，生成使用报告',
  kv_cleanup: '[未实现] 清理指定 KV 命名空间中过期或指定前缀的 key',
  d1_backup: '[未实现] 对指定 D1 数据库执行导出备份',
  r2_cleanup: '[未实现] 删除指定 R2 存储桶中超过保留天数的文件',
};

const currentTypeDesc = computed(() => taskTypeDescMap[taskForm.value.type] || '');
const taskNeedsAccount = computed(() => ['kv_cleanup', 'd1_backup', 'r2_cleanup'].includes(taskForm.value.type));

const accountOptions = computed(() =>
  accountStore.accounts.filter((a: any) => a.is_active).map((a: any) => ({ label: a.name, value: a.id }))
);

const aiGatewayColumns: DataTableColumns<any> = [
  { title: '账号', key: 'accountName', minWidth: 140 },
  {
    title: '状态', key: 'status', width: 100,
    render: (row) => h(NTag, {
      size: 'small',
      type: row.status === 'failed' ? 'error' : row.status === 'skipped' ? 'warning' : 'success',
    }, { default: () => aiGatewayStatusLabels[row.status as keyof typeof aiGatewayStatusLabels] || row.status }),
  },
  { title: 'Cloudflare Account ID', key: 'cloudflareAccountId', minWidth: 220 },
  { title: '结果', key: 'message', minWidth: 300 },
];

const aiGatewayStatusLabels = {
  created: '已创建',
  updated: '已更新',
  skipped: '已跳过',
  failed: '失败',
};

function onTaskTypeChange() {
  taskConfig.value = { accountId: accountOptions.value[0]?.value || null, namespaceId: '', databaseId: '', bucket: '', maxAgeDays: 30, prefix: '' };
}

async function fetchTasks() {
  tasksLoading.value = true;
  try {
    const { data } = await tasksApi.getAll();
    tasks.value = Array.isArray(data) ? data : [];
  } catch {
    tasks.value = [];
  } finally {
    tasksLoading.value = false;
  }
}

function openTaskModal(task?: any) {
  if (task) {
    editingTaskId.value = task.id;
    taskForm.value = { name: task.name, type: task.type, cron: task.cron };
    const parsed = task.config ? (typeof task.config === 'string' ? JSON.parse(task.config) : task.config) : {};
    taskConfig.value = {
      accountId: parsed.accountId || accountOptions.value[0]?.value || null,
      namespaceId: parsed.namespaceId || '',
      databaseId: parsed.databaseId || '',
      bucket: parsed.bucket || '',
      maxAgeDays: parsed.maxAgeDays || 30,
      prefix: parsed.prefix || '',
    };
  } else {
    editingTaskId.value = null;
    taskForm.value = { name: '', type: 'quota_report', cron: '0 8 * * *' };
    taskConfig.value = { accountId: accountOptions.value[0]?.value || null, namespaceId: '', databaseId: '', bucket: '', maxAgeDays: 30, prefix: '' };
  }
  showTaskModal.value = true;
}

async function handleSaveTask() {
  if (!taskForm.value.name || !taskForm.value.cron) {
    message.warning('请填写完整信息');
    return;
  }
  taskSaving.value = true;
  try {
    const payload = { ...taskForm.value, config: taskNeedsAccount.value ? taskConfig.value : undefined };
    if (editingTaskId.value) {
      await tasksApi.update(editingTaskId.value, payload);
      message.success('任务已更新');
    } else {
      await tasksApi.create(payload);
      message.success('任务已创建');
    }
    showTaskModal.value = false;
    fetchTasks();
  } finally {
    taskSaving.value = false;
  }
}

async function handleDeleteTask(row: any) {
  await tasksApi.delete(row.id);
  message.success('任务已删除');
  fetchTasks();
}

async function handleRunTask(row: any) {
  await tasksApi.run(row.id);
  message.success('任务已执行');
}

async function handleToggleTask(row: any, enabled: boolean) {
  await tasksApi.update(row.id, { enabled });
  row.enabled = enabled ? 1 : 0;
}

async function openHistory(row: any) {
  historyTaskName.value = row.name;
  showHistoryDrawer.value = true;
  historyLoading.value = true;
  try {
    const { data } = await tasksApi.getHistory(row.id);
    taskHistory.value = Array.isArray(data) ? data : [];
  } catch {
    taskHistory.value = [];
  } finally {
    historyLoading.value = false;
  }
}

const taskColumns: DataTableColumns<any> = [
  { title: '名称', key: 'name', minWidth: 120 },
  { title: '类型', key: 'type', width: 120, render: (row) => h(NTag, { size: 'small' }, { default: () => taskTypeOptions.find(o => o.value === row.type)?.label || row.type }) },
  { title: 'Cron', key: 'cron', width: 140 },
  { title: '启用', key: 'enabled', width: 80, render: (row) => h(NSwitch, { value: !!row.enabled, onUpdateValue: (v: boolean) => handleToggleTask(row, v) }) },
  {
    title: '操作', key: 'actions', width: 220,
    render: (row) => h(NSpace, null, { default: () => [
      h(NButton, { size: 'small', onClick: () => handleRunTask(row) }, { default: () => '执行' }),
      h(NButton, { size: 'small', onClick: () => openHistory(row) }, { default: () => '历史' }),
      h(NButton, { size: 'small', onClick: () => openTaskModal(row) }, { default: () => '编辑' }),
      h(NButton, { size: 'small', type: 'error', onClick: () => handleDeleteTask(row) }, { default: () => '删除' }),
    ]}),
  },
];

onMounted(() => {
  fetchSettings();
  fetchTasks();
  accountStore.fetchAccounts();
});
</script>
