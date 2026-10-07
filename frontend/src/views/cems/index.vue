<template>
  <section class="page" data-module="cems">
    <header class="page-head">
      <div>
        <h2>在线排放监测管理</h2>
        <p class="page-desc">
          每条监测记录对住自己的监测编号，排放限值与折算系数按同一套算法取（{{ standardVersion }}，自 {{ effectiveFrom }} 起施行）。
          已采集未审核的存量记录可按新口径一键重算；已审核记录照当时算法封档保留。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记监测报送</button>
        <button class="btn warn" type="button" @click="runRecalc">按新口径重算存量</button>
        <button class="btn" type="button" @click="exportRows">导出在线排放监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ 'warn-text': item.warn }">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item legend-note">状态只能 待采集 → 已采集 → 已审核 / 超标预警，不允许越级</span>
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
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-warn': row.status === '超标预警', 'row-frozen': row.status === '已审核' }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <span :class="['status-tag', `status-${statusClass(row.status)}`]">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <button
              v-if="row.status === '待采集'"
              class="link"
              type="button"
              @click="openCollect(row)"
            >
              提交采集
            </button>
            <button
              v-if="row.status === '已采集'"
              class="link"
              type="button"
              @click="openReview(row)"
            >
              确认审核
            </button>
            <button
              v-if="row.status === '已采集'"
              class="link link-warn"
              type="button"
              @click="markWarning(row)"
            >
              标记超标
            </button>
            <span v-if="row.status === '超标预警'" class="action-hint">已入环保监控预警清单</span>
            <span v-if="row.status === '已审核'" class="action-hint">已按当时口径封档，不回改</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无在线排放监测数据，可先登记监测报送</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条监测记录（同一监测编号多次报送只入一份），超标预警 {{ warningCount }} 条，与环保监控、运营概览同源</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 登记报送 -->
    <div v-if="createOpen" class="modal-mask" @click.self="createOpen = false">
      <div class="modal">
        <h3>登记排放监测报送</h3>
        <p class="modal-tip">限值、折算系数、折算值、超标判定均按当前口径 {{ standardVersion }} 自动计算；同监测编号重复报送只覆盖更新这一份。</p>
        <div class="form-grid">
          <label class="form-item">
            <span>监测编号 *</span>
            <input v-model="createForm.code" placeholder="如 CEMS-0008" />
          </label>
          <label class="form-item">
            <span>监测因子 *</span>
            <select v-model="createForm.factor">
              <option v-for="opt in factorOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </label>
          <label class="form-item">
            <span>实测值 *（{{ previewUnit }}）</span>
            <input v-model="createForm.measured" type="number" step="0.001" />
          </label>
          <label class="form-item">
            <span>实测氧含量（%，汞免填）</span>
            <input v-model="createForm.o2" type="number" step="0.1" :disabled="createForm.factor === 'Hg'" placeholder="如 11" />
          </label>
          <label class="form-item">
            <span>采集时间</span>
            <input v-model="createForm.collectedAt" placeholder="默认当前时间" />
          </label>
        </div>
        <div v-if="preview" class="calc-preview">
          <span>排放限值：{{ preview.limit }} {{ preview.unit }}</span>
          <span>折算系数：{{ preview.factor42 ?? '—' }}</span>
          <span>折算值：{{ preview.converted ?? '—' }} {{ preview.unit }}</span>
          <span :class="preview.exceed ? 'warn-text' : 'ok-text'">判定：{{ preview.verdict }}</span>
        </div>
        <footer class="modal-foot">
          <span v-if="createError" class="error-text">{{ createError }}</span>
          <button class="btn ghost" type="button" @click="createOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">报送入数</button>
        </footer>
      </div>
    </div>

    <!-- 待采集补数 -->
    <div v-if="collectOpen" class="modal-mask" @click.self="collectOpen = false">
      <div class="modal">
        <h3>提交采集：{{ collectRow?.['监测编号'] }}</h3>
        <p class="modal-tip">补报实测值后，按当前口径 {{ standardVersion }} 计算限值、折算值并判定。</p>
        <div class="form-grid">
          <label class="form-item">
            <span>监测因子</span>
            <input :value="collectRow?.['监测因子']" disabled />
          </label>
          <label class="form-item">
            <span>实测值 *</span>
            <input v-model="collectForm.measured" type="number" step="0.001" />
          </label>
          <label class="form-item">
            <span>实测氧含量（%，汞免填）</span>
            <input v-model="collectForm.o2" type="number" step="0.1" :disabled="collectRow?.['监测因子'] === 'Hg'" />
          </label>
        </div>
        <div v-if="collectPreview" class="calc-preview">
          <span>排放限值：{{ collectPreview.limit }}</span>
          <span>折算系数：{{ collectPreview.factor42 ?? '—' }}</span>
          <span>折算值：{{ collectPreview.converted ?? '—' }}</span>
          <span :class="collectPreview.exceed ? 'warn-text' : 'ok-text'">判定：{{ collectPreview.verdict }}</span>
        </div>
        <footer class="modal-foot">
          <span v-if="collectError" class="error-text">{{ collectError }}</span>
          <button class="btn ghost" type="button" @click="collectOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitCollect">提交采集</button>
        </footer>
      </div>
    </div>

    <!-- 审核 -->
    <div v-if="reviewOpen" class="modal-mask" @click.self="reviewOpen = false">
      <div class="modal">
        <h3>确认审核：{{ reviewRow?.['监测编号'] }}</h3>
        <p class="modal-tip">
          审核后按判定时口径（{{ reviewRow?.['判定口径版本'] }}）封档保留，限值再调整也不回头重算、不覆盖审核结论。
        </p>
        <div class="form-grid">
          <label class="form-item">
            <span>审核人员 *</span>
            <input v-model="reviewForm.reviewer" placeholder="请输入审核人员" />
          </label>
        </div>
        <footer class="modal-foot">
          <span v-if="reviewError" class="error-text">{{ reviewError }}</span>
          <button class="btn ghost" type="button" @click="reviewOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitReview">确认审核封档</button>
        </footer>
      </div>
    </div>

    <!-- 重算报告 -->
    <div v-if="reportOpen" class="modal-mask wide" @click.self="reportOpen = false">
      <div class="modal">
        <h3>存量记录重算报告</h3>
        <p class="modal-tip">
          执行口径：{{ report?.version }}（{{ report?.effectiveFrom }} 起施行），执行时间 {{ report?.ranAt }}。
          共扫描 {{ report?.scanned }} 条：重算 {{ report?.recalculated }} 条，已审核冻结 {{ report?.frozen }} 条，无实测值跳过 {{ report?.skipped }} 条。
          超标预警 {{ report?.warningsBefore }} → <strong :class="(report?.warningsAfter ?? 0) > (report?.warningsBefore ?? 0) ? 'warn-text' : 'ok-text'">{{ report?.warningsAfter }}</strong> 条。
        </p>
        <table class="data-table report-table">
          <thead>
            <tr>
              <th>监测编号</th>
              <th>因子</th>
              <th>实测值</th>
              <th>旧限值</th>
              <th>新限值</th>
              <th>旧折算值</th>
              <th>新折算值</th>
              <th>差值</th>
              <th>旧判定</th>
              <th>新判定</th>
              <th>状态变化 / 说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="diff in report?.diffs ?? []" :key="diff.id" :class="{ 'row-frozen': diff.frozen }">
              <td>{{ diff.code }}</td>
              <td>{{ diff.factor }}</td>
              <td>{{ diff.measured ?? '—' }}{{ diff.measured !== null ? ' ' + diff.unit : '' }}</td>
              <td>{{ diff.oldLimit ?? '—' }}</td>
              <td>{{ diff.newLimit ?? '—' }}</td>
              <td>{{ diff.oldConverted ?? '—' }}</td>
              <td>{{ diff.newConverted ?? '—' }}</td>
              <td :class="diffClass(diff)">{{ formatDelta(diff.convertedDelta) }}</td>
              <td :class="diff.oldExceed ? 'warn-text' : 'ok-text'">{{ diff.skipped ? '—' : diff.oldExceed ? '超标' : '达标' }}</td>
              <td :class="diff.newExceed ? 'warn-text' : 'ok-text'">{{ diff.skipped ? '—' : diff.newExceed ? '超标' : '达标' }}</td>
              <td>
                <template v-if="diff.frozen">已审核冻结，不回改</template>
                <template v-else-if="diff.skipped">{{ diff.reason }}</template>
                <template v-else-if="diff.flipped === 'to-exceed'"><span class="warn-text">达标 → 超标预警</span></template>
                <template v-else-if="diff.flipped === 'to-pass'"><span class="ok-text">超标预警 → 已采集（达标）</span></template>
                <template v-else>{{ diff.statusAfter }}（判定不变）</template>
              </td>
            </tr>
          </tbody>
        </table>
        <footer class="modal-foot">
          <button class="btn primary" type="button" @click="reportOpen = false">知道了</button>
        </footer>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import {
  FACTOR_OPTIONS,
  currentEffectiveFrom,
  currentVersion,
  evaluateCurrent,
  type EmissionFactor,
} from '@/data/emission-standards'
import {
  attachMeasurement,
  CEMS_STATUS,
  freezeReviewed,
  markExceed,
  recalcCollected,
  submitRecord,
  listWarningRows,
  type RecalcReport,
} from '@/data/cems-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('cems')
const columns = ["监测编号", "监测因子", "实测值", "实测氧含量", "排放限值", "折算系数", "折算值", "采集时间", "审核人员", "监测状态", "判定口径版本", "重算时间"]
const statuses = ["待采集", "已采集", "已审核", "超标预警"]
const factorOptions = FACTOR_OPTIONS
const standardVersion = currentVersion()
const effectiveFrom = currentEffectiveFrom()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 2)

const warningCount = computed(() => listWarningRows().length)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: '待采集因子', value: rows.value.filter((row) => row.status === CEMS_STATUS.waiting).length, warn: false },
  { label: '已审核因子', value: rows.value.filter((row) => row.status === CEMS_STATUS.reviewed).length, warn: false },
  { label: '超标预警次数', value: warningCount.value, warn: true },
])

function statusClass(status: string): string {
  if (status === CEMS_STATUS.warning) return 'warn'
  if (status === CEMS_STATUS.reviewed) return 'frozen'
  if (status === CEMS_STATUS.collected) return 'active'
  return 'muted'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

// ---- 登记报送 ----
const createOpen = ref(false)
const createError = ref('')
const createForm = reactive({ code: '', factor: 'SO2' as EmissionFactor, measured: '', o2: '', collectedAt: '' })
const previewUnit = computed(() => evaluateCurrent({ factor: createForm.factor, measured: 0 }).unit)
const preview = computed(() => {
  const measured = Number(createForm.measured)
  if (createForm.measured === '' || !Number.isFinite(measured)) return null
  const o2 = createForm.o2 === '' ? null : Number(createForm.o2)
  return evaluateCurrent({ factor: createForm.factor, measured, o2 })
})

function openCreate() {
  createForm.code = ''
  createForm.factor = 'SO2'
  createForm.measured = ''
  createForm.o2 = ''
  createForm.collectedAt = ''
  createError.value = ''
  createOpen.value = true
}

function submitCreate() {
  createError.value = ''
  const measured = Number(createForm.measured)
  if (!Number.isFinite(measured)) {
    createError.value = '请填写有效的实测值'
    return
  }
  const o2 = createForm.o2 === '' ? null : Number(createForm.o2)
  const result = submitRecord({
    code: createForm.code,
    factor: createForm.factor,
    measured,
    o2,
    collectedAt: createForm.collectedAt,
  })
  if (!result.ok) {
    createError.value = result.message
    return
  }
  createOpen.value = false
  errorMessage.value = result.message
  reload()
}

// ---- 待采集补数 ----
const collectOpen = ref(false)
const collectError = ref('')
const collectRow = ref<EntryRow | null>(null)
const collectForm = reactive({ measured: '', o2: '' })
const collectPreview = computed(() => {
  if (!collectRow.value) return null
  const measured = Number(collectForm.measured)
  if (collectForm.measured === '' || !Number.isFinite(measured)) return null
  const o2 = collectForm.o2 === '' ? null : Number(collectForm.o2)
  return evaluateCurrent({ factor: String(collectRow.value['监测因子']), measured, o2 })
})

function openCollect(row: EntryRow) {
  collectRow.value = row
  collectForm.measured = ''
  collectForm.o2 = ''
  collectError.value = ''
  collectOpen.value = true
}

function submitCollect() {
  if (!collectRow.value) return
  collectError.value = ''
  const measured = Number(collectForm.measured)
  if (!Number.isFinite(measured)) {
    collectError.value = '请填写有效的实测值'
    return
  }
  const o2 = collectForm.o2 === '' ? null : Number(collectForm.o2)
  const result = attachMeasurement(Number(collectRow.value.id), measured, o2)
  if (!result.ok) {
    collectError.value = result.message
    return
  }
  collectOpen.value = false
  errorMessage.value = result.message
  reload()
}

// ---- 审核封档 ----
const reviewOpen = ref(false)
const reviewError = ref('')
const reviewRow = ref<EntryRow | null>(null)
const reviewForm = reactive({ reviewer: '王环保' })

function openReview(row: EntryRow) {
  reviewRow.value = row
  reviewForm.reviewer = '王环保'
  reviewError.value = ''
  reviewOpen.value = true
}

function submitReview() {
  if (!reviewRow.value) return
  reviewError.value = ''
  const result = freezeReviewed(Number(reviewRow.value.id), reviewForm.reviewer)
  if (!result.ok) {
    reviewError.value = result.message
    return
  }
  reviewOpen.value = false
  errorMessage.value = result.message
  reload()
}

// ---- 标记超标：只能从已采集来，且必须真按当前口径算出超标，杜绝人工越级 ----
function markWarning(row: EntryRow) {
  errorMessage.value = ''
  const result = markExceed(Number(row.id))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  reload()
}

// ---- 一键重算 ----
const reportOpen = ref(false)
const report = ref<RecalcReport | null>(null)

function runRecalc() {
  errorMessage.value = ''
  report.value = recalcCollected()
  reportOpen.value = true
  reload()
}

function formatDelta(value: number | null): string {
  if (value === null) return '—'
  if (value > 0) return `+${value}`
  return String(value)
}

function diffClass(diff: { convertedDelta: number | null; flipped: string }): string {
  if (diff.convertedDelta === null || diff.flipped === 'none') return ''
  return diff.convertedDelta >= 0 ? 'warn-text' : 'ok-text'
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '在线排放监测列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.warn-text { color: #b42318; font-weight: 600; }
.ok-text { color: #027a48; }
.action-hint { color: var(--muted); font-size: 12px; }
.link-warn { color: #b42318; }
.row-warn { background: #fef3f2; }
.row-frozen { background: #f2f4f7; color: #667085; }
.status-tag { border-radius: 999px; padding: 1px 10px; font-size: 12px; }
.status-warn { background: #fee4e2; color: #b42318; }
.status-frozen { background: #e4e7ec; color: #475467; }
.status-active { background: #e0f2fe; color: #075985; }
.status-muted { background: #f2f4f7; color: #667085; }
.legend-note { background: transparent; padding-left: 4px; }
.modal-mask {
  position: fixed; inset: 0; background: rgba(16, 24, 40, 0.45);
  display: flex; align-items: center; justify-content: center; z-index: 50;
}
.modal-mask.wide .modal { width: 960px; }
.modal {
  width: 560px; max-height: 86vh; overflow: auto;
  background: #fff; border-radius: 10px; padding: 18px 20px;
}
.modal h3 { margin: 0 0 8px; font-size: 16px; }
.modal-tip { color: var(--muted); font-size: 12px; line-height: 1.6; margin: 0 0 12px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; }
.form-item span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 3px; }
.form-item input, .form-item select { width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; }
.calc-preview {
  display: flex; flex-wrap: wrap; gap: 12px; margin-top: 12px; padding: 8px 12px;
  background: #f8fafc; border-radius: 6px; font-size: 13px;
}
.modal-foot { display: flex; justify-content: flex-end; align-items: center; gap: 10px; margin-top: 16px; }
.modal-foot .error-text { margin-right: auto; }
.report-table { font-size: 12px; }
.report-table th, .report-table td { padding: 5px 7px; }
.btn.warn { border-color: #d92d20; color: #d92d20; }
</style>
