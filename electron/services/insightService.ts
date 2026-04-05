/**
 * insightService.ts
 *
 * AI 见解后台服务：
 * 1. 监听 DB 变更事件（debounce 500ms 防抖，避免开机/重连时爆发大量事件阻塞主线程）
 * 2. 沉默联系人扫描（独立 setInterval，每 4 小时一次）
 * 3. 触发后拉取真实聊天上下文（若用户授权），组装 prompt 调用单一 AI 模型
 * 4. 输出 ≤80 字见解，通过现有 showNotification 弹出右下角通知
 *
 * 设计原则：
 * - 不引入任何额外 npm 依赖，使用 Node 原生 https 模块调用 OpenAI 兼容 API
 * - 所有失败静默处理，不影响主流程
 * - 当日触发记录（sessionId + 时间列表）随 prompt 一起发送，让模型自行判断是否克制
 */

import https from 'https'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { URL } from 'url'
import { app, Notification } from 'electron'
import { ConfigService } from './config'
import { chatService, ChatSession, Message } from './chatService'

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** DB 变更防抖延迟（毫秒） */
const DB_CHANGE_DEBOUNCE_MS = 500

/** 首次沉默扫描延迟（毫秒），避免启动期间抢占资源 */
const SILENCE_SCAN_INITIAL_DELAY_MS = 3 * 60 * 1000

/** 单次 API 请求超时（毫秒） */
const API_TIMEOUT_MS = 45_000

/** 沉默天数阈值默认值 */
const DEFAULT_SILENCE_DAYS = 3

// ─── 类型 ────────────────────────────────────────────────────────────────────

interface TodayTriggerRecord {
  /** 该会话今日触发的时间戳列表（毫秒） */
  timestamps: number[]
}

// ─── 桌面日志 ─────────────────────────────────────────────────────────────────

/**
 * 将日志同时输出到 console 和桌面上的 weflow-insight.log 文件。
 * 文件名带当天日期，每天自动换一个新文件，旧文件保留。
 */
function insightLog(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  const now = new Date()
  const dateStr = now.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-')
  const timeStr = now.toLocaleTimeString('zh-CN', { hour12: false })
  const line = `[${dateStr} ${timeStr}] [${level}] ${message}\n`

  // 同步到 console
  if (level === 'ERROR' || level === 'WARN') {
    console.warn(`[InsightService] ${message}`)
  } else {
    console.log(`[InsightService] ${message}`)
  }

  // 写入桌面日志文件
  try {
    const desktopPath = app.getPath('desktop')
    const logFile = path.join(desktopPath, `weflow-insight-${dateStr}.log`)
    fs.appendFileSync(logFile, line, 'utf-8')
  } catch {
    // 写文件失败静默处理，不影响主流程
  }
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/**
 * 绝对拼接 baseUrl 与路径，避免 Node.js URL 相对路径陷阱。
 *
 * 例如：
 *   baseUrl = "https://api.ohmygpt.com/v1"
 *   path    = "/chat/completions"
 * 结果为  "https://api.ohmygpt.com/v1/chat/completions"
 *
 * 如果 baseUrl 末尾没有斜杠，直接用字符串拼接（而非 new URL(path, base)），
 * 因为 new URL("chat/completions", "https://api.example.com/v1") 会错误地
 * 丢弃 v1，变成 https://api.example.com/chat/completions。
 */
function buildApiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '') // 去掉末尾斜杠
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

function getStartOfDay(date: Date = new Date()): number {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/**
 * 调用 OpenAI 兼容 API（非流式），返回模型第一条消息内容。
 * 使用 Node 原生 https/http 模块，无需任何第三方 SDK。
 */
function callApi(
  apiBaseUrl: string,
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  timeoutMs: number = API_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    const endpoint = buildApiUrl(apiBaseUrl, '/chat/completions')
    let urlObj: URL
    try {
      urlObj = new URL(endpoint)
    } catch (e) {
      reject(new Error(`无效的 API URL: ${endpoint}`))
      return
    }

    const body = JSON.stringify({
      model,
      messages,
      max_tokens: 200,
      temperature: 0.7,
      stream: false
    })

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST' as const,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body).toString(),
        Authorization: `Bearer ${apiKey}`
      }
    }

    const isHttps = urlObj.protocol === 'https:'
    const requestFn = isHttps ? https.request : http.request
    const req = requestFn(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          const content = parsed?.choices?.[0]?.message?.content
          if (typeof content === 'string' && content.trim()) {
            resolve(content.trim())
          } else {
            reject(new Error(`API 返回格式异常: ${data.slice(0, 200)}`))
          }
        } catch (e) {
          reject(new Error(`JSON 解析失败: ${data.slice(0, 200)}`))
        }
      })
    })

    req.setTimeout(timeoutMs, () => {
      req.destroy()
      reject(new Error('API 请求超时'))
    })

    req.on('error', (e) => reject(e))
    req.write(body)
    req.end()
  })
}

// ─── InsightService 主类 ──────────────────────────────────────────────────────

class InsightService {
  private readonly config: ConfigService

  /** DB 变更防抖定时器 */
  private dbDebounceTimer: NodeJS.Timeout | null = null

  /** 沉默扫描定时器 */
  private silenceScanTimer: NodeJS.Timeout | null = null
  private silenceInitialDelayTimer: NodeJS.Timeout | null = null

  /** 是否正在处理中（防重入） */
  private processing = false

  /**
   * 当日触发记录：sessionId -> TodayTriggerRecord
   * 每天 00:00 之后自动重置（通过检查日期实现）
   */
  private todayTriggers: Map<string, TodayTriggerRecord> = new Map()
  private todayDate = getStartOfDay()

  /**
   * 活跃分析冷却记录：sessionId -> 上次分析时间戳（毫秒）
   * 同一会话 2 小时内不重复触发活跃分析，防止 DB 频繁变更时爆量调用 API。
   */
  private lastActivityAnalysis: Map<string, number> = new Map()

  /**
   * 跟踪每个会话上次见到的最新消息时间戳，用于判断是否有真正的新消息。
   * sessionId -> lastMessageTimestamp（秒，与微信 DB 保持一致）
   */
  private lastSeenTimestamp: Map<string, number> = new Map()

  private started = false

  constructor() {
    this.config = ConfigService.getInstance()
  }

  // ── 公开 API ────────────────────────────────────────────────────────────────

  start(): void {
    if (this.started) return
    this.started = true
    insightLog('INFO', '已启动')
    this.scheduleSilenceScan()
  }

  stop(): void {
    this.started = false
    if (this.dbDebounceTimer !== null) {
      clearTimeout(this.dbDebounceTimer)
      this.dbDebounceTimer = null
    }
    if (this.silenceScanTimer !== null) {
      clearInterval(this.silenceScanTimer)
      this.silenceScanTimer = null
    }
    if (this.silenceInitialDelayTimer !== null) {
      clearTimeout(this.silenceInitialDelayTimer)
      this.silenceInitialDelayTimer = null
    }
    insightLog('INFO', '已停止')
  }

  /**
   * 由 main.ts 在 addDbMonitorListener 回调中调用。
   * 加入 500ms 防抖，防止开机/重连时大量事件并发阻塞主线程。
   */
  handleDbMonitorChange(_type: string, _json: string): void {
    if (!this.started) return
    if (!this.isEnabled()) return

    if (this.dbDebounceTimer !== null) {
      clearTimeout(this.dbDebounceTimer)
    }
    this.dbDebounceTimer = setTimeout(() => {
      this.dbDebounceTimer = null
      void this.analyzeRecentActivity()
    }, DB_CHANGE_DEBOUNCE_MS)
  }

  /**
   * 测��� API 连接，返回 { success, message }。
   * 供设置页"测试连接"按钮调用。
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    const apiBaseUrl = this.config.get('aiInsightApiBaseUrl') as string
    const apiKey = this.config.get('aiInsightApiKey') as string
    const model = (this.config.get('aiInsightApiModel') as string) || 'gpt-4o-mini'

    if (!apiBaseUrl || !apiKey) {
      return { success: false, message: '请先填写 API 地址和 API Key' }
    }

    try {
      const result = await callApi(
        apiBaseUrl,
        apiKey,
        model,
        [{ role: 'user', content: '请回复"连接成功"四个字。' }],
        15_000
      )
      return { success: true, message: `连接成功，模型回复：${result.slice(0, 50)}` }
    } catch (e) {
      return { success: false, message: `连接失败：${(e as Error).message}` }
    }
  }

  /**
   * 强制立即对最近一个私聊会话触发一次见解（忽略冷却，用于测试）。
   * 返回触发结果描述，供设置页展示。
   */
  async triggerTest(): Promise<{ success: boolean; message: string }> {
    insightLog('INFO', '手动触发测试见解...')
    const apiBaseUrl = this.config.get('aiInsightApiBaseUrl') as string
    const apiKey = this.config.get('aiInsightApiKey') as string
    if (!apiBaseUrl || !apiKey) {
      return { success: false, message: '请先填写 API 地址和 Key' }
    }
    try {
      const connectResult = await chatService.connect()
      if (!connectResult.success) {
        return { success: false, message: '数据库连接失败，请先在"数据库连接"页完成配置' }
      }
      const sessionsResult = await chatService.getSessions()
      if (!sessionsResult.success || !sessionsResult.sessions || sessionsResult.sessions.length === 0) {
        return { success: false, message: '未找到任何会话，请确认数据库已正确连接' }
      }
      // 找第一个允许的私聊
      const session = (sessionsResult.sessions as ChatSession[]).find((s) => {
        const id = s.username?.trim() || ''
        return id && !id.endsWith('@chatroom') && !id.toLowerCase().includes('placeholder') && this.isSessionAllowed(id)
      })
      if (!session) {
        return { success: false, message: '未找到任何私聊会话（若已启用白名单，请检查是否有勾选的私聊）' }
      }
      const sessionId = session.username?.trim() || ''
      const displayName = session.displayName || sessionId
      insightLog('INFO', `测试目标会话：${displayName} (${sessionId})`)
      await this.generateInsightForSession({
        sessionId,
        displayName,
        triggerReason: 'activity'
      })
      return { success: true, message: `已向「${displayName}」发送测试见解，请查看右下角弹窗` }
    } catch (e) {
      return { success: false, message: `测试失败：${(e as Error).message}` }
    }
  }

  /** 获取今日触发统计（供设置页展示） */
  getTodayStats(): { sessionId: string; count: number; times: string[] }[] {
    this.resetIfNewDay()
    const result: { sessionId: string; count: number; times: string[] }[] = []
    for (const [sessionId, record] of this.todayTriggers.entries()) {
      result.push({
        sessionId,
        count: record.timestamps.length,
        times: record.timestamps.map(formatTimestamp)
      })
    }
    return result
  }

  // ── 私有方法 ────────────────────────────────────────────────────────────────

  private isEnabled(): boolean {
    return this.config.get('aiInsightEnabled') === true
  }

  /**
   * 判断某个会话是否允许触发见解。
   * 若白名单未启用，则所有私聊会话均允许；
   * 若白名单已启用，则只有在白名单中的会话才允许。
   */
  private isSessionAllowed(sessionId: string): boolean {
    const whitelistEnabled = this.config.get('aiInsightWhitelistEnabled') as boolean
    if (!whitelistEnabled) return true
    const whitelist = (this.config.get('aiInsightWhitelist') as string[]) || []
    return whitelist.includes(sessionId)
  }

  private resetIfNewDay(): void {
    const todayStart = getStartOfDay()
    if (todayStart > this.todayDate) {
      this.todayDate = todayStart
      this.todayTriggers.clear()
    }
  }

  /**
   * 记录触发并返回该会话今日所有触发时间（用于组装 prompt）。
   */
  private recordTrigger(sessionId: string): string[] {
    this.resetIfNewDay()
    const existing = this.todayTriggers.get(sessionId) ?? { timestamps: [] }
    existing.timestamps.push(Date.now())
    this.todayTriggers.set(sessionId, existing)
    return existing.timestamps.map(formatTimestamp)
  }

  /**
   * 获取今日全局已触发次数（所有会话合计），用于 prompt 中告知模型全局上下文。
   */
  private getTodayTotalTriggerCount(): number {
    this.resetIfNewDay()
    let total = 0
    for (const record of this.todayTriggers.values()) {
      total += record.timestamps.length
    }
    return total
  }

  // ── 沉默联系人扫描 ──────────────────────────────────────────────────────────

  private scheduleSilenceScan(): void {
    this.silenceInitialDelayTimer = setTimeout(() => {
      void this.runSilenceScan()
      // 每次扫描完毕后重新读取间隔配置，允许用户动态调整不需要重启
      const scheduleNext = () => {
        const intervalHours = (this.config.get('aiInsightScanIntervalHours') as number) || 4
        const intervalMs = Math.max(0.1, intervalHours) * 60 * 60 * 1000
        insightLog('INFO', `下次沉默扫描将在 ${intervalHours} 小时后执行`)
        this.silenceScanTimer = setTimeout(() => {
          void this.runSilenceScan().then(scheduleNext)
        }, intervalMs)
      }
      scheduleNext()
    }, SILENCE_SCAN_INITIAL_DELAY_MS)
  }

  private async runSilenceScan(): Promise<void> {
    if (!this.isEnabled()) {
      insightLog('INFO', '沉默扫描：AI 见解未启用，跳过')
      return
    }
    if (this.processing) {
      insightLog('INFO', '沉默扫描：正在处理中，跳过本次')
      return
    }

    this.processing = true
    insightLog('INFO', '开始沉默联系人扫描...')
    try {
      const silenceDays = (this.config.get('aiInsightSilenceDays') as number) || DEFAULT_SILENCE_DAYS
      const thresholdMs = silenceDays * 24 * 60 * 60 * 1000
      const now = Date.now()

      insightLog('INFO', `沉默阈值：${silenceDays} 天`)

      const connectResult = await chatService.connect()
      if (!connectResult.success) {
        insightLog('WARN', '数据库连接失败，跳过沉默扫描')
        return
      }

      const sessionsResult = await chatService.getSessions()
      if (!sessionsResult.success || !sessionsResult.sessions) {
        insightLog('WARN', '获取会话列表失败')
        return
      }

      const sessions: ChatSession[] = sessionsResult.sessions
      insightLog('INFO', `共 ${sessions.length} 个会话，开始过滤...`)

      let silentCount = 0
      for (const session of sessions) {
        const sessionId = session.username?.trim() || ''
        if (!sessionId || sessionId.endsWith('@chatroom')) continue
        if (sessionId.toLowerCase().includes('placeholder')) continue
        if (!this.isSessionAllowed(sessionId)) continue

        const lastTimestamp = (session.lastTimestamp || 0) * 1000
        if (!lastTimestamp || lastTimestamp <= 0) continue

        const silentMs = now - lastTimestamp
        if (silentMs < thresholdMs) continue

        silentCount++
        const silentDays = Math.floor(silentMs / (24 * 60 * 60 * 1000))
        insightLog('INFO', `发现沉默联系人：${session.displayName || sessionId}，已沉默 ${silentDays} 天`)

        await this.generateInsightForSession({
          sessionId,
          displayName: session.displayName || session.username,
          triggerReason: 'silence',
          silentDays
        })
      }
      insightLog('INFO', `沉默扫描完成，共发现 ${silentCount} 个沉默联系人`)
    } catch (e) {
      insightLog('ERROR', `沉默扫描出错: ${(e as Error).message}`)
    } finally {
      this.processing = false
    }
  }

  // ── 活跃会话分析 ────────────────────────────────────────────────────────────

  /**
   * 在 DB 变更防抖后执行，分析最近活跃的会话。
   *
   * 触发条件（必须同时满足）：
   * 1. 会话有真正的新消息（lastTimestamp 比上次见到的更新）
   * 2. 该会话距上次活跃分析已超过 2 小时冷却期
   */
  private async analyzeRecentActivity(): Promise<void> {
    if (!this.isEnabled()) return
    if (this.processing) return

    this.processing = true
    insightLog('INFO', 'DB 变更防抖触发，开始活跃分析...')
    try {
      const connectResult = await chatService.connect()
      if (!connectResult.success) {
        insightLog('WARN', '数据库连接失败，跳过活跃分析')
        return
      }

      const sessionsResult = await chatService.getSessions()
      if (!sessionsResult.success || !sessionsResult.sessions) {
        insightLog('WARN', '获取会话列表失败')
        return
      }

      const sessions: ChatSession[] = sessionsResult.sessions
      const now = Date.now()

      // 从 config 读取冷却分钟数（0 = 无冷却）
      const cooldownMinutes = (this.config.get('aiInsightCooldownMinutes') as number) ?? 120
      const cooldownMs = cooldownMinutes * 60 * 1000

      const privateSessions = sessions.filter((s) => {
        const id = s.username?.trim() || ''
        return id && !id.endsWith('@chatroom') && !id.toLowerCase().includes('placeholder') && this.isSessionAllowed(id)
      })

      insightLog('INFO', `筛选到 ${privateSessions.length} 个私聊会话（白名单过滤后），冷却期 ${cooldownMinutes} 分钟`)

      let triggeredCount = 0
      for (const session of privateSessions.slice(0, 10)) {
        const sessionId = session.username?.trim() || ''
        if (!sessionId) continue

        const currentTimestamp = session.lastTimestamp || 0
        const lastSeen = this.lastSeenTimestamp.get(sessionId) ?? 0

        // 检查是否有真正的新消息
        if (currentTimestamp <= lastSeen) {
          continue
        }

        // 更新已见时间戳
        this.lastSeenTimestamp.set(sessionId, currentTimestamp)

        // 检查冷却期（0 分钟 = 无冷却，直接通过）
        if (cooldownMs > 0) {
          const lastAnalysis = this.lastActivityAnalysis.get(sessionId) ?? 0
          const cooldownRemaining = cooldownMs - (now - lastAnalysis)
          if (cooldownRemaining > 0) {
            insightLog('INFO', `${session.displayName || sessionId} 冷却中，还需 ${Math.ceil(cooldownRemaining / 60000)} 分钟`)
            continue
          }
        }

        insightLog('INFO', `${session.displayName || sessionId} 有新消息，准备生成见解...`)
        this.lastActivityAnalysis.set(sessionId, now)

        await this.generateInsightForSession({
          sessionId,
          displayName: session.displayName || session.username,
          triggerReason: 'activity'
        })
        triggeredCount++

        break // 每次最多处理 1 个会话
      }

      if (triggeredCount === 0) {
        insightLog('INFO', '活跃分析完成，无会话触发见解')
      }
    } catch (e) {
      insightLog('ERROR', `活跃分析出错: ${(e as Error).message}`)
    } finally {
      this.processing = false
    }
  }

  // ── 核心见解生成 ────────────────────────────────────────────────────────────

  private async generateInsightForSession(params: {
    sessionId: string
    displayName: string
    triggerReason: 'activity' | 'silence'
    silentDays?: number
  }): Promise<void> {
    const { sessionId, displayName, triggerReason, silentDays } = params
    if (!sessionId) return

    const apiBaseUrl = this.config.get('aiInsightApiBaseUrl') as string
    const apiKey = this.config.get('aiInsightApiKey') as string
    const model = (this.config.get('aiInsightApiModel') as string) || 'gpt-4o-mini'
    const allowContext = this.config.get('aiInsightAllowContext') as boolean
    const contextCount = (this.config.get('aiInsightContextCount') as number) || 40

    insightLog('INFO', `generateInsightForSession: sessionId=${sessionId}, reason=${triggerReason}, contextCount=${contextCount}, api=${apiBaseUrl ? '已配置' : '未配置'}`)

    if (!apiBaseUrl || !apiKey) {
      insightLog('WARN', 'API 地址或 Key 未配置，跳过见解生成')
      return
    }

    // ── 构建 prompt ─────────────���────────────────────────────────────────────

    // 今日触发统计（让模型具备时间与克制感）
    const sessionTriggerTimes = this.recordTrigger(sessionId)
    const totalTodayTriggers = this.getTodayTotalTriggerCount()

    let contextSection = ''
    if (allowContext) {
      try {
        const msgsResult = await chatService.getLatestMessages(sessionId, contextCount)
        if (msgsResult.success && msgsResult.messages && msgsResult.messages.length > 0) {
          const messages: Message[] = msgsResult.messages
          const msgLines = messages.map((m) => {
            const sender = m.isSend === 1 ? '我' : (displayName || sessionId)
            const content = m.rawContent || m.parsedContent || '[非文字消息]'
            const time = new Date(Number(m.createTime) * 1000).toLocaleString('zh-CN')
            return `[${time}] ${sender}：${content}`
          })
          contextSection = `\n\n近期对话记录（最近 ${msgLines.length} 条）：\n${msgLines.join('\n')}`
          insightLog('INFO', `已加载 ${msgLines.length} 条上下文消息`)
        }
      } catch (e) {
        insightLog('WARN', `拉取上下文失败: ${(e as Error).message}`)
      }
    }

    const triggerDesc =
      triggerReason === 'silence'
        ? `你已经 ${silentDays} 天没有和「${displayName}」聊天了。`
        : `你最近和「${displayName}」有新的聊天动态。`

    const todayStatsDesc =
      sessionTriggerTimes.length > 1
        ? `今天你已经针对「${displayName}」收到过 ${sessionTriggerTimes.length - 1} 条见解（时间：${sessionTriggerTimes.slice(0, -1).join('、')}），请适当克制，避免过度打扰。`
        : `今天你还没有针对「${displayName}」发出过见解。`

    const globalStatsDesc = `今天全部联系人合计已触发 ${totalTodayTriggers} 条见解。`

    const systemPrompt = `你是用户的私人关系观察助手，名叫"见解"。你的任务是主动提供有价值的观察和建议。

要求：
1. 必须给出见解。基于聊天记录分析对方情绪、话题趋势、关系动态，或给出回复建议、聊天话题推荐。
2. 控制在 80 字以内，直接、具体、一针见血。不要废话。
3. 输出纯文本，不使用 Markdown。
4. 只有在完全没有任何可说的内容时（比如对话只有一条"嗯"），才回复"SKIP"。绝大多数情况下你应该输出见解。

时间感知：${todayStatsDesc} ${globalStatsDesc}`

    const userPrompt = `触发原因：${triggerDesc}${contextSection}

请给出你的见解（≤80字）：`

    const endpoint = buildApiUrl(apiBaseUrl, '/chat/completions')
    insightLog('INFO', `准备调用 API: ${endpoint}，模型: ${model}`)

    try {
      const result = await callApi(
        apiBaseUrl,
        apiKey,
        model,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      )

      insightLog('INFO', `API 返回原文: ${result.slice(0, 150)}`)

      // 模型主动选择跳过
      if (result.trim().toUpperCase() === 'SKIP' || result.trim().startsWith('SKIP')) {
        insightLog('INFO', `模型选择跳过 ${displayName}`)
        return
      }

      const insight = result.slice(0, 120)

      insightLog('INFO', `推送通知 → ${displayName}: ${insight}`)

      // 使用 Electron 原生系统通知，确保 Windows 右下角弹窗可靠显示
      if (Notification.isSupported()) {
        const notif = new Notification({
          title: `见解 · ${displayName}`,
          body: insight,
          silent: false
        })
        notif.show()
      } else {
        insightLog('WARN', '当前系统不支持原生通知')
      }

      insightLog('INFO', `已为 ${displayName} 推送见解`)
    } catch (e) {
      insightLog('ERROR', `API 调用失败 (${displayName}): ${(e as Error).message}`)
    }
  }
}

export const insightService = new InsightService()
