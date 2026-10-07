<template>
  <section class="page" data-module="emission">
    <header class="page-head">
      <div>
        <h2>环保指标监控管理</h2>
        <p class="page-desc">
          维护环保监控记录，并承接在线排放监测的超标预警。预警清单与在线排放监测列表、运营概览取数同源（{{ standardVersion }}），三处条数一致。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记环保监控记录</button>
        <button class="btn" type="button" @click="exportRows">导出环保指标监控清单</button>
      </div>
    </header>

    <!-- 排放超标预警清单：预警数与 cems 列表页、运营概览是同一份取数 -->
    <article class="warn-panel">
      <header class="warn-panel-head">
        <h3>排放超标预警清单（检查详情）</h3>
        <span class="warn-count" :class="{ 'is-zero': warningRows.length === 0 }">{{ warningRows.length }} 条</span>
      </header>
      <table v-if="warningRows.length" class="data-table warn-table">
        <thead>
          <tr>
            <th>监测编号</th>
            <th>监测因子</th>
            <th>实测值</th>
            <th>实测氧含量</th>
            <th>折算系数</th>
            <th>折算值</th>
            <th>排放限值</th>
            <th>超标倍数</th>
            <th>采集时间</th>
            <th>判定口径</th>
            <th>监测状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in warningRows" :key="String(row.id)" class="row-warn">
            <td>{{ row['监测编号'] }}</td>
            <td>{{ factorLabel(row['监测因子']) }}</td>
            <td>{{ row['实测值'] }}</td>
            <td>{{ row['实测氧含量'] || '—' }}</td>
            <td>{{ row['折算系数'] }}</td>
            <td class="warn-text">{{ row['折算值'] }}</td>
            <td>{{ row['排放限值'] }}</td>
            <td class="warn-text">{{ exceedRatio(row) }}</td>
            <td>{{ row['采集时间'] }}</td>
            <td>{{ row['判定口径版本'] }}</td>
            <td>{{ row['监测状态'] }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state warn-empty">当前执行口径下暂无超标预警记录</p>
      <footer class="warn-panel-foot">
        重算后状态变更会立即反映到这里；已审核封档记录不参与预警，仍按审核时口径保留。
      </footer>
    </article>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无环保指标监控数据，可先登记环保监控记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条环保监控记录；排放超标预警 {{ warningRows.length }} 条，与在线排放监测、运营概览一致</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { currentVersion, standardOf } from '@/data/emission-standards'
import { listWarningRows } from '@/data/cems-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('emission')
const columns = ["监控编号", "监控指标", "限值要求", "实测值", "达标判定", "监控日期", "监控人员", "监控状态"]
const actions = ["提交监控", "判定达标", "标记未达标"]
const statuses = ["待监控", "监控中", "已达标", "未达标"]
const standardVersion = currentVersion()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 预警清单直接读 cems 的统一取数口，不另存副本，杜绝两处各说各话。
const warningRows = computed(() => listWarningRows())
const stats = computed(() => [
  { label: '待监控指标', value: rows.value.filter((row) => String(row.status) === '待监控').length },
  { label: '已达标指标', value: rows.value.filter((row) => String(row.status) === '已达标').length },
  { label: '排放超标预警', value: warningRows.value.length },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function factorLabel(factor: unknown): string {
  const standard = standardOf(String(factor))
  return standard ? `${standard.factor}（${standard.factorName}）` : String(factor ?? '')
}

function exceedRatio(row: EntryRow): string {
  const converted = Number(row['折算值'])
  const limit = Number(row['排放限值'])
  if (!Number.isFinite(converted) || !Number.isFinite(limit) || limit === 0) {
    return '—'
  }
  return `${(converted / limit).toFixed(2)} 倍`
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '环保监控记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '环保指标监控列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.warn-panel {
  border: 1px solid #fecdca;
  background: #fff;
  border-radius: 8px;
  margin-bottom: 14px;
  overflow: hidden;
}
.warn-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: #fef3f2;
}
.warn-panel-head h3 { margin: 0; font-size: 14px; color: #7a271a; }
.warn-count {
  background: #d92d20;
  color: #fff;
  border-radius: 999px;
  padding: 2px 12px;
  font-size: 13px;
  font-weight: 600;
}
.warn-count.is-zero { background: #98a2b3; }
.warn-table th, .warn-table td { padding: 6px 9px; font-size: 12px; }
.row-warn { background: #fff8f7; }
.warn-panel-foot { padding: 8px 14px; font-size: 12px; color: var(--muted); }
.warn-empty { padding: 18px; }
.warn-text { color: #b42318; font-weight: 600; }
</style>
