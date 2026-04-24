import { ConfigService } from './config'
import { chatService, type ChatSession, type Message } from './chatService'
import { wcdbService } from './wcdbService'
import { httpService } from './httpService'
import { promises as fs } from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { pathToFileURL } from 'url'

interface SessionBaseline {
  lastTimestamp: number
  unreadCount: number
}

interface PushSessionResult {
  fetched: boolean
  maxFetchedTimestamp: number
  incomingCandidateCount: number
  observedIncomingCount: number
  expectedIncomingCount: number
  retry: boolean
}

interface MessagePushPayload {
  event: 'message.new'
  sessionId: string
  sessionType: 'private' | 'group' | 'official' | 'other'
  messageKey: string
  avatarUrl?: string
  sourceName: string
  groupName?: string
  content: string | null
  timestamp: number
  emojiMd5?: string
}

interface MessageRevokePayload {
  event: 'message.revoke'
  sessionId: string
  sessionType: 'private' | 'group' | 'official' | 'other'
  messageKey: string
  avatarUrl?: string
  sourceName: string
  groupName?: string
  content: string | null
  originalServerId?: string
}

const PUSH_CONFIG_KEYS = new Set([
  'messagePushEnabled',
  'messagePushFilterMode',
  'messagePushFilterList',
  'dbPath',
  'decryptKey',
  'myWxid'
])

class MessagePushService {
  private readonly configService: ConfigService
  private readonly sessionBaseline = new Map<string, SessionBaseline>()
  private readonly recentMessageKeys = new Map<string, number>()
  private readonly seenMessageKeys = new Map<string, number>()
  private readonly seenPrimedSessions = new Set<string>()
  private readonly revokedServerIds = new Set<string>()
  private readonly groupNicknameCache = new Map<string, { nicknames: Record<string, string>; updatedAt: number }>()
  private readonly pushAvatarCacheDir: string
  private readonly pushAvatarDataCache = new Map<string, string>()
  private readonly debounceMs = 350
  private readonly lookbackSeconds = 2
  private readonly recentMessageTtlMs = 10 * 60 * 1000
  private readonly groupNicknameCacheTtlMs = 5 * 60 * 1000
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private processing = false
  private rerunRequested = false
  private started = false
  private baselineReady = false
  private messageTableScanRequested = false

  constructor() {
    this.configService = ConfigService.getInstance()
    this.pushAvatarCacheDir = path.join(this.configService.getCacheBasePath(), 'push-avatar-files')
  }

  private getSseConnectedAt(): number {
    return httpService.getMessagePushConnectedAt()
  }

  start(): void {
    if (this.started) return
    this.started = true
    void this.refreshConfiguration('startup')
  }

  stop(): void {
    this.started = false
    this.processing = false
    this.rerunRequested = false
    this.resetRuntimeState()
  }

  handleDbMonitorChange(type: string, json: string): void {
    if (!this.started) return
    if (!this.isPushEnabled()) return

    let payload: Record<string, unknown> | null = null
    try {
      payload = JSON.parse(json)
    } catch {
      payload = null
    }

    console.log(`[MessagePushService] handleDbMonitorChange: type=${type}, table=${payload?.table}, hasLocalType=${payload?.localType !== undefined}, hasContent=${!!payload?.content}`)
    console.log(`[MessagePushService] payload 内容: ${JSON.stringify(payload)}`)

    const tableName = String(payload?.table || '').trim()

    // session 表变化：检查是否有防撤回消息（立即检查），同时推送正常消息
    if (tableName.toLowerCase() === 'session') {
      console.log(`[MessagePushService] session 表变化，调用 handleSessionChangeForAntiRevoke`)
      void this.handleSessionChangeForAntiRevoke(payload)
      this.scheduleSync()
      return
    }

    // 消息表变化：尝试直接推送（包含防撤回注入的消息）
    if (tableName && this.isMessageTable(tableName)) {
      console.log(`[MessagePushService] 消息表变化: ${tableName}，调用 handleMessageTableChange`)
      console.log(`[MessagePushService] Message 表变化 payload: ${JSON.stringify(payload)}`)
      void this.handleMessageTableChange(payload)
      return
    } else {
      console.log(`[MessagePushService] 跳过 tableName="${tableName}", isMessageTable=false`)
    }

    // 兜底：如果 payload 中包含消息相关的字段（localType、content、localId 等），
    // 说明是消息表变化，尝试提取 sessionId 并检测防撤回
    if (payload && this.hasMessageFields(payload)) {
      const sessionIds = chatService.collectSessionIdsFromPayload(payload)
      console.log(`[MessagePushService] hasMessageFields=true，提取到 ${sessionIds.size} 个 sessionId`)
      if (sessionIds.size > 0) {
        // 精确检测受影响的会话
        void (async () => {
          const results = await Promise.all([...sessionIds].map(sessionId => this.queryAntiRevokeInSession(sessionId)))
          const foundCount = results.filter(Boolean).length
          console.log(`[MessagePushService] 兜底防撤回检测完成，共 ${foundCount} 个会话有防撤回消息`)
        })()
      }
      this.scheduleSync({ scanMessageBackedSessions: true })
      return
    }

    // 其他表（如未知表），保守处理，走 debounce
    if (tableName) {
      console.log(`[MessagePushService] 未知表: ${tableName}，走 debounce`)
      this.scheduleSync()
    }
  }

  private hasMessageFields(payload: Record<string, unknown>): boolean {
    return (
      typeof payload.localType === 'number' ||
      typeof payload.localId === 'number' ||
      (typeof payload.content === 'string' && payload.content.length > 0) ||
      typeof payload.serverId === 'number' ||
      typeof payload.createTime === 'number' ||
      typeof payload.sortSeq === 'number'
    )
  }

  private isMessageTable(tableName: string): boolean {
    const normalized = tableName.toLowerCase()
    return normalized.includes('msg') ||
           normalized.includes('message') ||
           normalized.includes('chat') ||
           normalized === 'contact' ||
           normalized === 'chatmsg' ||
           normalized === 'messagelist' ||
           normalized === 'msgqueue'
  }

  private async handleSessionChangeForAntiRevoke(payload: Record<string, unknown> | null): Promise<void> {
    // 先尝试从 payload 中精确提取受影响的会话 ID，避免全量扫描
    if (payload) {
      const sessionIds = chatService.collectSessionIdsFromPayload(payload)
      if (sessionIds.size > 0) {
        console.log(`[MessagePushService] handleSessionChangeForAntiRevoke: 精确检测 ${sessionIds.size} 个会话: ${[...sessionIds].join(', ')}`)
        const results = await Promise.all([...sessionIds].map(sessionId => this.queryAntiRevokeInSession(sessionId)))
        const foundCount = results.filter(Boolean).length
        console.log(`[MessagePushService] handleSessionChangeForAntiRevoke: 完成，共 ${foundCount} 个会话有防撤回消息`)
        return
      }
    }

    // 无法精确提取时，退化为全量扫描（仅在确实需要时）
    console.log(`[MessagePushService] handleSessionChangeForAntiRevoke: 无法精确提取，退化为全量扫描`)

    const sessionsResult = await chatService.getSessions()
    if (!sessionsResult.success || !sessionsResult.sessions || sessionsResult.sessions.length === 0) {
      console.log(`[MessagePushService] handleSessionChangeForAntiRevoke: 无会话数据`)
      return
    }

    const sessions = sessionsResult.sessions as ChatSession[]
    console.log(`[MessagePushService] handleSessionChangeForAntiRevoke: 共 ${sessions.length} 个会话需要检查`)

    const batchSize = 5
    let foundCount = 0

    for (let i = 0; i < sessions.length; i += batchSize) {
      const batch = sessions.slice(i, i + batchSize)
      const results = await Promise.all(
        batch.map(session => this.queryAntiRevokeInSession(session.username))
      )
      foundCount += results.filter(Boolean).length
    }

    console.log(`[MessagePushService] handleSessionChangeForAntiRevoke: 检查完成，共发现 ${foundCount} 个会话有防撤回消息`)
  }

  private async queryAntiRevokeInSession(sessionId: string): Promise<boolean> {
    const since = Math.floor(Date.now() / 1000) - 300
    console.log(`[MessagePushService] queryAntiRevokeInSession: sessionId=${sessionId}, since=${since}`)

    const newMessagesResult = await chatService.getNewMessages(sessionId, since, 20)
    if (!newMessagesResult.success || !newMessagesResult.messages || newMessagesResult.messages.length === 0) {
      console.log(`[MessagePushService] queryAntiRevokeInSession: 无新消息`)
      return false
    }

    console.log(`[MessagePushService] queryAntiRevokeInSession: 查到 ${newMessagesResult.messages.length} 条消息`)

    const sseConnectedAt = this.getSseConnectedAt()

    for (const message of newMessagesResult.messages) {
      const messageKey = String(message.messageKey || '').trim()
      if (!messageKey) continue

      const localType = Number(message.localType || 0)
      const content = String(message.rawContent || message.content || '').trim()
      const createTime = Number(message.createTime || 0)

      // SSE 连接前的历史撤回不推送
      if (sseConnectedAt > 0 && createTime < sseConnectedAt) {
        continue
      }

      console.log(`[MessagePushService] 检查消息: localType=${localType}, content="${content.substring(0, 50)}"`)

      if (this.isAntiRevokeInjectMessage(localType, content)) {
        const revokeMessageKey = `${messageKey}:revoke`
        if (this.isRecentMessage(revokeMessageKey)) {
          console.log(`[MessagePushService] queryAntiRevokeInSession: 撤回事件已推送过，跳过`)
          continue
        }
        if (!this.shouldPushPayload(sessionId)) {
          console.log(`[MessagePushService] queryAntiRevokeInSession: sessionId=${sessionId} 被过滤，跳过`)
          continue
        }
        console.log(`[MessagePushService] queryAntiRevokeInSession: 检测到防撤回消息，立即推送`)
        await this.pushAntiRevokeMessageFromMessage(sessionId, message)
        return true
      }
    }
    return false
  }

  private async handleMessageTableChange(payload: Record<string, unknown> | null): Promise<void> {
    if (!payload) {
      console.log(`[MessagePushService] handleMessageTableChange: payload 为空，走 debounce`)
      this.scheduleSync({ scanMessageBackedSessions: true })
      return
    }

    const sessionIds = chatService.collectSessionIdsFromPayload(payload)
    if (sessionIds.size === 0) {
      console.log(`[MessagePushService] handleMessageTableChange: 无法提取 sessionId，走 debounce`)
      this.scheduleSync({ scanMessageBackedSessions: true })
      return
    }

    const content = String(payload.content || payload.rawContent || '').trim()
    const localType = Number(payload.localType || payload.type || 0)
    const isAntiRevokeMessage = this.isAntiRevokeInjectMessage(localType, content)

    if (isAntiRevokeMessage) {
      for (const sessionId of sessionIds) {
        await this.pushAntiRevokeMessageDirect(sessionId, payload)
      }
    } else {
      this.scheduleSync({ scanMessageBackedSessions: true })
    }
  }

  private isAntiRevokeInjectMessage(localType: number, content: string): boolean {
    if (localType === 10000) {
      const normalizedContent = content.toLowerCase()
      return normalizedContent.includes('撤回') ||
             normalizedContent.includes('recall') ||
             normalizedContent.includes('revoke') ||
             normalizedContent.includes('尝试撤回')
    }
    return false
  }

  private shouldPushPayload(sessionId: string): boolean {
    const filterMode = this.getMessagePushFilterMode()
    if (filterMode === 'all') {
      return true
    }

    const filterList = this.getMessagePushFilterList()
    const listed = filterList.has(sessionId)
    if (filterMode === 'whitelist') {
      return listed
    }
    return !listed
  }

  private getMessagePushFilterMode(): 'all' | 'whitelist' | 'blacklist' {
    const value = this.configService.get('messagePushFilterMode')
    if (value === 'whitelist' || value === 'blacklist') return value
    return 'all'
  }

  private getMessagePushFilterList(): Set<string> {
    const value = this.configService.get('messagePushFilterList')
    if (!Array.isArray(value)) return new Set()
    return new Set(value.map((item) => String(item || '').trim()).filter(Boolean))
  }

  private async pushAntiRevokeMessageFromMessage(sessionId: string, message: Message): Promise<void> {
    const messageKey = String(message.messageKey || '').trim()
    if (!messageKey) {
      console.log(`[MessagePushService] pushAntiRevokeMessageFromMessage: messageKey 为空`)
      return
    }

    const revokeMessageKey = `${messageKey}:revoke`
    const content = String(message.parsedContent || message.rawContent || '[系统消息]').trim()
    const serverId = message.serverId ? String(message.serverId) : undefined
    const sessionType = this.getSessionTypeFromId(sessionId)

    if (!this.shouldPushPayload(sessionId)) {
      console.log(`[MessagePushService] pushAntiRevokeMessageFromMessage: sessionId=${sessionId} 被过滤，跳过`)
      return
    }

    console.log(`[MessagePushService] pushAntiRevokeMessageFromMessage: 准备推送撤回事件, messageKey=${messageKey}, revokeMessageKey=${revokeMessageKey}`)

    const revokePayload: MessageRevokePayload = {
      event: 'message.revoke',
      sessionId,
      sessionType,
      messageKey: revokeMessageKey,
      avatarUrl: undefined,
      sourceName: sessionId,
      groupName: sessionId.endsWith('@chatroom') ? sessionId : undefined,
      content,
      originalServerId: serverId
    }

    console.log(`[MessagePushService] pushAntiRevokeMessageFromMessage: 调用 broadcastMessagePush`)
    httpService.broadcastMessagePush(revokePayload as unknown as Record<string, unknown>)
    this.rememberMessageKey(revokeMessageKey)
    if (serverId) {
      this.revokedServerIds.add(serverId)
    }
    console.log(`[MessagePushService] pushAntiRevokeMessageFromMessage: broadcastMessagePush 完成`)
  }

  private async pushAntiRevokeMessageDirect(sessionId: string, payload: Record<string, unknown>): Promise<void> {
    const baseMessageKey = String(payload.messageKey || payload.key || `${sessionId}_${payload.localId || payload.id || Date.now()}`).trim()
    const revokeMessageKey = `${baseMessageKey}:revoke`

    if (this.isRecentMessage(revokeMessageKey)) {
      return
    }

    if (!this.shouldPushPayload(sessionId)) {
      console.log(`[MessagePushService] pushAntiRevokeMessageDirect: sessionId=${sessionId} 被过滤，跳过推送`)
      return
    }

    const content = String(payload.content || payload.rawContent || '[系统消息]').trim()
    const serverId = payload.serverId ? String(payload.serverId) : undefined
    const sessionType = this.getSessionTypeFromId(sessionId)
    const isGroup = sessionId.endsWith('@chatroom')

    let sourceName = sessionId
    let avatarUrl: string | undefined

    const sessionsResult = await chatService.getSessions()
    if (sessionsResult.success && sessionsResult.sessions) {
      const session = (sessionsResult.sessions as ChatSession[]).find(s => s.username === sessionId)
      if (session) {
        if (isGroup) {
          const groupInfo = await chatService.getContactAvatar(sessionId)
          avatarUrl = session.avatarUrl || groupInfo?.avatarUrl
          sourceName = session.displayName || groupInfo?.displayName || sessionId
        } else {
          const contactInfo = await chatService.getContactAvatar(sessionId)
          avatarUrl = session.avatarUrl || contactInfo?.avatarUrl
          sourceName = session.displayName || contactInfo?.displayName || sessionId
        }
      } else {
        if (isGroup) {
          const groupInfo = await chatService.getContactAvatar(sessionId)
          avatarUrl = groupInfo?.avatarUrl
          sourceName = groupInfo?.displayName || sessionId
        } else {
          const contactInfo = await chatService.getContactAvatar(sessionId)
          avatarUrl = contactInfo?.avatarUrl
          sourceName = contactInfo?.displayName || sessionId
        }
      }
    }

    const revokePayload: MessageRevokePayload = {
      event: 'message.revoke',
      sessionId,
      sessionType,
      messageKey: revokeMessageKey,
      avatarUrl,
      sourceName,
      groupName: isGroup ? sourceName : undefined,
      content,
      originalServerId: serverId
    }

    httpService.broadcastMessagePush(revokePayload as unknown as Record<string, unknown>)
    this.rememberMessageKey(revokeMessageKey)
    if (serverId) {
      this.revokedServerIds.add(serverId)
    }
  }

  private getSessionTypeFromId(sessionId: string): MessagePushPayload['sessionType'] {
    if (sessionId.endsWith('@chatroom')) return 'group'
    if (sessionId.startsWith('gh_')) return 'official'
    return 'other'
  }

  async handleConfigChanged(key: string): Promise<void> {
    if (!PUSH_CONFIG_KEYS.has(String(key || '').trim())) return
    if (key === 'dbPath' || key === 'decryptKey' || key === 'myWxid') {
      this.resetRuntimeState()
      chatService.close()
    }
    await this.refreshConfiguration(`config:${key}`)
  }

  handleConfigCleared(): void {
    this.resetRuntimeState()
    chatService.close()
  }

  private isPushEnabled(): boolean {
    return this.configService.get('messagePushEnabled') === true
  }

  private resetRuntimeState(): void {
    this.sessionBaseline.clear()
    this.recentMessageKeys.clear()
    this.seenMessageKeys.clear()
    this.seenPrimedSessions.clear()
    this.revokedServerIds.clear()
    this.groupNicknameCache.clear()
    this.baselineReady = false
    this.messageTableScanRequested = false
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  private async refreshConfiguration(reason: string): Promise<void> {
    if (!this.isPushEnabled()) {
      this.resetRuntimeState()
      return
    }

    const connectResult = await chatService.connect()
    if (!connectResult.success) {
      console.warn(`[MessagePushService] Bootstrap connect failed (${reason}):`, connectResult.error)
      return
    }

    await this.bootstrapBaseline()
  }

  private async bootstrapBaseline(): Promise<void> {
    const sessionsResult = await chatService.getSessions()
    if (!sessionsResult.success || !sessionsResult.sessions) {
      return
    }
    this.setBaseline(sessionsResult.sessions as ChatSession[])
    this.baselineReady = true
  }

  private scheduleSync(options: { scanMessageBackedSessions?: boolean } = {}): void {
    if (options.scanMessageBackedSessions) {
      this.messageTableScanRequested = true
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.flushPendingChanges()
    }, this.debounceMs)
  }

  private async flushPendingChanges(): Promise<void> {
    if (this.processing) {
      this.rerunRequested = true
      return
    }

    this.processing = true
    try {
      if (!this.isPushEnabled()) return
      const scanMessageBackedSessions = this.messageTableScanRequested
      this.messageTableScanRequested = false

      const connectResult = await chatService.connect()
      if (!connectResult.success) {
        console.warn('[MessagePushService] Sync connect failed:', connectResult.error)
        return
      }

      const sessionsResult = await chatService.getSessions()
      if (!sessionsResult.success || !sessionsResult.sessions) {
        return
      }

      const sessions = sessionsResult.sessions as ChatSession[]
      if (!this.baselineReady) {
        this.setBaseline(sessions)
        this.baselineReady = true
        return
      }

      const previousBaseline = new Map(this.sessionBaseline)

      const candidates = sessions.filter((session) => {
        const previous = previousBaseline.get(session.username)
        if (this.shouldInspectSession(previous, session)) {
          return true
        }
        return scanMessageBackedSessions && this.shouldScanMessageBackedSession(previous, session)
      })
      const candidateIds = new Set<string>()
      for (const session of candidates) {
        const sessionId = String(session.username || '').trim()
        if (sessionId) candidateIds.add(sessionId)
        const result = await this.pushSessionMessages(
          session,
          previousBaseline.get(session.username) || this.sessionBaseline.get(session.username)
        )
        this.updateInspectedBaseline(session, previousBaseline.get(session.username), result)
        if (result.retry) {
          this.rerunRequested = true
        }
      }

      for (const session of sessions) {
        const sessionId = String(session.username || '').trim()
        if (!sessionId || candidateIds.has(sessionId)) continue
        this.updateObservedBaseline(session, previousBaseline.get(sessionId))
      }
    } finally {
      this.processing = false
      if (this.rerunRequested) {
        this.rerunRequested = false
        this.scheduleSync({ scanMessageBackedSessions: this.messageTableScanRequested })
      }
    }
  }

  private setBaseline(sessions: ChatSession[]): void {
    const previousBaseline = new Map(this.sessionBaseline)
    const nextBaseline = new Map<string, SessionBaseline>()
    const nowSeconds = Math.floor(Date.now() / 1000)
    this.sessionBaseline.clear()
    for (const session of sessions) {
      const username = String(session.username || '').trim()
      if (!username) continue
      const previous = previousBaseline.get(username)
      const sessionTimestamp = Number(session.lastTimestamp || 0)
      const initialTimestamp = sessionTimestamp > 0 ? sessionTimestamp : nowSeconds
      nextBaseline.set(username, {
        lastTimestamp: Math.max(sessionTimestamp, Number(previous?.lastTimestamp || 0), previous ? 0 : initialTimestamp),
        unreadCount: Number(session.unreadCount || 0)
      })
    }
    for (const [username, baseline] of nextBaseline.entries()) {
      this.sessionBaseline.set(username, baseline)
    }
  }

  private updateObservedBaseline(session: ChatSession, previous: SessionBaseline | undefined): void {
    const username = String(session.username || '').trim()
    if (!username) return

    const sessionTimestamp = Number(session.lastTimestamp || 0)
    const previousTimestamp = Number(previous?.lastTimestamp || 0)
    this.sessionBaseline.set(username, {
      lastTimestamp: Math.max(sessionTimestamp, previousTimestamp),
      unreadCount: Number(session.unreadCount ?? previous?.unreadCount ?? 0)
    })
  }

  private updateInspectedBaseline(
    session: ChatSession,
    previous: SessionBaseline | undefined,
    result: PushSessionResult
  ): void {
    const username = String(session.username || '').trim()
    if (!username) return

    const previousTimestamp = Number(previous?.lastTimestamp || 0)
    const current = this.sessionBaseline.get(username) || previous || { lastTimestamp: 0, unreadCount: 0 }
    const nextTimestamp = result.retry
      ? previousTimestamp
      : Math.max(previousTimestamp, current.lastTimestamp, result.maxFetchedTimestamp)

    this.sessionBaseline.set(username, {
      lastTimestamp: nextTimestamp,
      unreadCount: result.retry
        ? Number(previous?.unreadCount || 0)
        : Number(session.unreadCount || 0)
    })
  }

  private shouldInspectSession(previous: SessionBaseline | undefined, session: ChatSession): boolean {
    const sessionId = String(session.username || '').trim()
    if (!sessionId || sessionId.toLowerCase().includes('placeholder_foldgroup')) {
      return false
    }

    const summary = String(session.summary || '').trim()
    if (Number(session.lastMsgType || 0) === 10002 || summary.includes('撤回了一条消息')) {
      return false
    }

    const lastTimestamp = Number(session.lastTimestamp || 0)
    const unreadCount = Number(session.unreadCount || 0)

    if (!previous) {
      return unreadCount > 0 && lastTimestamp > 0
    }

    return lastTimestamp > previous.lastTimestamp || unreadCount > previous.unreadCount
  }

  private shouldScanMessageBackedSession(previous: SessionBaseline | undefined, session: ChatSession): boolean {
    const sessionId = String(session.username || '').trim()
    if (!sessionId || sessionId.toLowerCase().includes('placeholder_foldgroup')) {
      return false
    }

    const summary = String(session.summary || '').trim()
    if (Number(session.lastMsgType || 0) === 10002 || summary.includes('撤回了一条消息')) {
      return false
    }

    const sessionType = this.getSessionTypeFromId(sessionId)
    if (sessionType === 'private') {
      return false
    }

    return Boolean(previous) || Number(session.lastTimestamp || 0) > 0
  }

  private async pushSessionMessages(session: ChatSession, previous: SessionBaseline | undefined): Promise<PushSessionResult> {
    const previousTimestamp = Math.max(0, Number(previous?.lastTimestamp || 0))
    const previousUnreadCount = Math.max(0, Number(previous?.unreadCount || 0))
    const currentUnreadCount = Math.max(0, Number(session.unreadCount || 0))
    const expectedIncomingCount = previous
      ? Math.max(0, currentUnreadCount - previousUnreadCount)
      : 0
    const sseConnectedAt = this.getSseConnectedAt()
    if (sseConnectedAt === 0) {
      return {
        fetched: false,
        maxFetchedTimestamp: previousTimestamp,
        incomingCandidateCount: 0,
        observedIncomingCount: 0,
        expectedIncomingCount,
        retry: false
      }
    }
    const since = previous
      ? Math.max(0, previousTimestamp - this.lookbackSeconds)
      : sseConnectedAt
    const newMessagesResult = await chatService.getNewMessages(session.username, since, 1000)
    if (!newMessagesResult.success || !newMessagesResult.messages || newMessagesResult.messages.length === 0) {
      return {
        fetched: false,
        maxFetchedTimestamp: previousTimestamp,
        incomingCandidateCount: 0,
        observedIncomingCount: 0,
        expectedIncomingCount,
        retry: expectedIncomingCount > 0
      }
    }

    const sessionId = String(session.username || '').trim()
    const maxFetchedTimestamp = newMessagesResult.messages.reduce((max, message) => {
      const createTime = Number(message.createTime || 0)
      return Number.isFinite(createTime) && createTime > max ? createTime : max
    }, previousTimestamp)
    const seenPrimed = sessionId ? this.seenPrimedSessions.has(sessionId) : false
    const sameTimestampIncoming: Message[] = []
    const candidateMessages: Message[] = []
    let observedIncomingCount = 0

    for (const message of newMessagesResult.messages) {
      const messageKey = String(message.messageKey || '').trim()
      if (!messageKey) continue
      const createTime = Number(message.createTime || 0)
      const seen = this.isSeenMessage(messageKey)
      const recent = this.isRecentMessage(messageKey)

      if (message.isSend !== 1) {
        if (!previous || createTime > previousTimestamp || (seenPrimed && createTime === previousTimestamp)) {
          observedIncomingCount += 1
        }
      }

      if (previous && !seenPrimed && createTime < previousTimestamp) {
        this.rememberSeenMessageKey(messageKey)
        continue
      }

      if (seen || recent) {
        continue
      }
      if (message.isSend === 1) continue

      if (sseConnectedAt > 0 && createTime < sseConnectedAt) {
        continue
      }

      const serverId = message.serverId ? String(message.serverId) : undefined
      if (serverId && this.revokedServerIds.has(serverId)) {
        continue
      }

      const localType = Number(message.localType || 0)
      const content = String(message.rawContent || message.content || '').trim()
      if (this.isAntiRevokeInjectMessage(localType, content)) {
        const revokeMessageKey = `${messageKey}:revoke`
        if (this.isRecentMessage(revokeMessageKey)) {
          continue
        }
        if (!this.shouldPushPayload(session.username)) {
          continue
        }
        void this.pushAntiRevokeMessageFromMessage(session.username, message)
        continue
      }

      if (previous && !seenPrimed && createTime === previousTimestamp) {
        sameTimestampIncoming.push(message)
        continue
      }

      candidateMessages.push(message)
    }

    const futureIncomingCount = candidateMessages.filter((message) => {
      const createTime = Number(message.createTime || 0)
      return !previous || createTime > previousTimestamp || seenPrimed
    }).length
    const sameTimestampAllowance = previous && !seenPrimed
      ? Math.max(0, expectedIncomingCount - futureIncomingCount)
      : 0
    const selectedSameTimestamp = sameTimestampAllowance > 0
      ? sameTimestampIncoming.slice(-sameTimestampAllowance)
      : []
    const messagesToPush = [...selectedSameTimestamp, ...candidateMessages]
    const incomingCandidateCount = messagesToPush.length

    for (const message of messagesToPush) {
      const messageKey = String(message.messageKey || '').trim()
      if (!messageKey) continue
      if (!this.shouldPushPayload(session.username)) {
        continue
      }

      const payload = await this.buildPayload(session, message)
      if (!payload) continue

      httpService.broadcastMessagePush(payload as unknown as Record<string, unknown>)
      this.rememberMessageKey(messageKey)
      this.bumpSessionBaseline(session.username, message)
    }

    for (const message of newMessagesResult.messages) {
      const messageKey = String(message.messageKey || '').trim()
      if (messageKey) this.rememberSeenMessageKey(messageKey)
    }
    if (sessionId) this.seenPrimedSessions.add(sessionId)

    return {
      fetched: true,
      maxFetchedTimestamp,
      incomingCandidateCount,
      observedIncomingCount,
      expectedIncomingCount,
      retry: expectedIncomingCount > 0 && observedIncomingCount < expectedIncomingCount
    }
  }

  private async buildPayload(session: ChatSession, message: Message): Promise<MessagePushPayload | null> {
    const sessionId = String(session.username || '').trim()
    const messageKey = String(message.messageKey || '').trim()
    if (!sessionId || !messageKey) return null

    const isGroup = sessionId.endsWith('@chatroom')
    const sessionType = this.getSessionTypeFromId(sessionId)
    const content = this.getMessageDisplayContent(message)
    const isEmoji = Number(message.localType || 0) === 47
    const emojiMd5 = isEmoji ? (message.emojiMd5 || undefined) : undefined

    const createTime = Number(message.createTime || 0)

    if (isGroup) {
      const groupInfo = await chatService.getContactAvatar(sessionId)
      const groupName = session.displayName || groupInfo?.displayName || sessionId
      const sourceName = await this.resolveGroupSourceName(sessionId, message, session)
      const avatarUrl = await this.normalizePushAvatarUrl(session.avatarUrl || groupInfo?.avatarUrl)
      return {
        event: 'message.new',
        sessionId,
        sessionType,
        messageKey,
        avatarUrl,
        groupName,
        sourceName,
        content,
        timestamp: createTime,
        emojiMd5
      }
    }

    const contactInfo = await chatService.getContactAvatar(sessionId)
    const avatarUrl = await this.normalizePushAvatarUrl(session.avatarUrl || contactInfo?.avatarUrl)
    return {
      event: 'message.new',
      sessionId,
      sessionType,
      messageKey,
      avatarUrl,
      sourceName: session.displayName || contactInfo?.displayName || sessionId,
      content,
      timestamp: createTime,
      emojiMd5
    }
  }

  private async normalizePushAvatarUrl(avatarUrl?: string): Promise<string | undefined> {
    const normalized = String(avatarUrl || '').trim()
    if (!normalized) return undefined
    if (!normalized.startsWith('data:image/')) {
      return normalized || undefined
    }

    const cached = this.pushAvatarDataCache.get(normalized)
    if (cached) return cached

    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i.exec(normalized)
    if (!match) return undefined

    try {
      const mimeType = match[1].toLowerCase()
      const base64Data = match[2]
      const imageBuffer = Buffer.from(base64Data, 'base64')
      if (!imageBuffer.length) return undefined

      const ext = this.getImageExtFromMime(mimeType)
      const hash = createHash('sha1').update(normalized).digest('hex')
      const filePath = path.join(this.pushAvatarCacheDir, `avatar_${hash}.${ext}`)

      await fs.mkdir(this.pushAvatarCacheDir, { recursive: true })
      try {
        await fs.access(filePath)
      } catch {
        await fs.writeFile(filePath, imageBuffer)
      }

      const fileUrl = pathToFileURL(filePath).toString()
      this.pushAvatarDataCache.set(normalized, fileUrl)
      return fileUrl
    } catch {
      return undefined
    }
  }

  private getImageExtFromMime(mimeType: string): string {
    if (mimeType === 'image/png') return 'png'
    if (mimeType === 'image/gif') return 'gif'
    if (mimeType === 'image/webp') return 'webp'
    return 'jpg'
  }

  private bumpSessionBaseline(sessionId: string, message: Message): void {
    const key = String(sessionId || '').trim()
    if (!key) return

    const createTime = Number(message.createTime || 0)
    if (!Number.isFinite(createTime) || createTime <= 0) return

    const current = this.sessionBaseline.get(key) || { lastTimestamp: 0, unreadCount: 0 }
    if (createTime > current.lastTimestamp) {
      this.sessionBaseline.set(key, {
        ...current,
        lastTimestamp: createTime
      })
    }
  }

  private getMessageDisplayContent(message: Message): string | null {
    switch (Number(message.localType || 0)) {
      case 1:
        return message.rawContent || null
      case 3:
        return '[图片]'
      case 34:
        return '[语音]'
      case 43:
        return '[视频]'
      case 47:
        return '[表情]'
      case 42:
        return message.cardNickname || '[名片]'
      case 48:
        return '[位置]'
      case 49:
        return message.linkTitle || message.fileName || '[消息]'
      default:
        return message.parsedContent || message.rawContent || null
    }
  }

  private async resolveGroupSourceName(chatroomId: string, message: Message, session: ChatSession): Promise<string> {
    const senderUsername = String(message.senderUsername || '').trim()
    if (!senderUsername) {
      return session.lastSenderDisplayName || '未知发送者'
    }

    const groupNicknames = await this.getGroupNicknames(chatroomId)
    const senderKey = senderUsername.toLowerCase()
    const nickname = groupNicknames[senderKey]

    if (nickname) {
      return nickname
    }

    const contactInfo = await chatService.getContactAvatar(senderUsername)
    return contactInfo?.displayName || senderUsername
  }

  private async getGroupNicknames(chatroomId: string): Promise<Record<string, string>> {
    const cacheKey = String(chatroomId || '').trim()
    if (!cacheKey) return {}

    const cached = this.groupNicknameCache.get(cacheKey)
    if (cached && Date.now() - cached.updatedAt < this.groupNicknameCacheTtlMs) {
      return cached.nicknames
    }

    const result = await wcdbService.getGroupNicknames(cacheKey)
    const nicknames = result.success && result.nicknames
      ? this.sanitizeGroupNicknames(result.nicknames)
      : {}
    this.groupNicknameCache.set(cacheKey, { nicknames, updatedAt: Date.now() })
    return nicknames
  }

  private sanitizeGroupNicknames(nicknames: Record<string, string>): Record<string, string> {
    const buckets = new Map<string, Set<string>>()
    for (const [memberIdRaw, nicknameRaw] of Object.entries(nicknames || {})) {
      const memberId = String(memberIdRaw || '').trim().toLowerCase()
      const nickname = String(nicknameRaw || '').trim()
      if (!memberId || !nickname) continue
      const slot = buckets.get(memberId)
      if (slot) {
        slot.add(nickname)
      } else {
        buckets.set(memberId, new Set([nickname]))
      }
    }

    const trusted: Record<string, string> = {}
    for (const [memberId, nicknameSet] of buckets.entries()) {
      if (nicknameSet.size !== 1) continue
      trusted[memberId] = Array.from(nicknameSet)[0]
    }
    return trusted
  }

  private isRecentMessage(messageKey: string): boolean {
    this.pruneRecentMessageKeys()
    const timestamp = this.recentMessageKeys.get(messageKey)
    return typeof timestamp === 'number' && Date.now() - timestamp < this.recentMessageTtlMs
  }

  private rememberMessageKey(messageKey: string): void {
    this.recentMessageKeys.set(messageKey, Date.now())
    this.pruneRecentMessageKeys()
  }

  private isSeenMessage(messageKey: string): boolean {
    this.pruneSeenMessageKeys()
    const timestamp = this.seenMessageKeys.get(messageKey)
    return typeof timestamp === 'number' && Date.now() - timestamp < this.recentMessageTtlMs
  }

  private rememberSeenMessageKey(messageKey: string): void {
    this.seenMessageKeys.set(messageKey, Date.now())
    this.pruneSeenMessageKeys()
  }

  private pruneRecentMessageKeys(): void {
    const now = Date.now()
    for (const [key, timestamp] of this.recentMessageKeys.entries()) {
      if (now - timestamp > this.recentMessageTtlMs) {
        this.recentMessageKeys.delete(key)
      }
    }
  }

  private pruneSeenMessageKeys(): void {
    const now = Date.now()
    for (const [key, timestamp] of this.seenMessageKeys.entries()) {
      if (now - timestamp > this.recentMessageTtlMs) {
        this.seenMessageKeys.delete(key)
      }
    }
  }

}

export const messagePushService = new MessagePushService()
