/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  // 可选：动作允许的起始状态。登记了就按状态机校验，审核状态不许越级。
  actionSources?: Record<string, string[]>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// 一条记录的重算前后对照：差值按同一套算法（emission-standard.ts）算出。
export type RecalcChange = {
  id: number
  monitorNo: string
  factor: string
  beforeLimit: string
  afterLimit: number
  beforeConverted: string
  afterConverted: number
  delta: string // 折算值差值，如 "+7.5"；旧值缺失时为 ''
  exceeded: boolean
}

export type RecalcResult = {
  ok: boolean
  message: string
  standard: string // 本次重算适用的标准版本
  merged: number // 合并掉的重复报送条数
  recalculated: number
  warned: number // 重算后新转入超标预警的条数
  skipped: number // 因子未登记或实测值缺失而跳过的条数
  syncedCreated: number // 环保监控预警清单新增条数
  syncedUpdated: number // 环保监控预警清单更新条数
  changes: RecalcChange[]
  details: string[] // 每条记录重算前后差值的可读说明
}
