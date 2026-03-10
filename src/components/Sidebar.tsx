import { useState, useEffect, useRef } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { Home, MessageSquare, BarChart3, FileText, Settings, Download, Aperture, UserCircle, Lock, LockOpen, ChevronUp, Trash2 } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import * as configService from '../services/config'
import { onExportSessionStatus, requestExportSessionStatus } from '../services/exportBridge'

import './Sidebar.scss'

interface SidebarUserProfile {
  wxid: string
  displayName: string
  alias?: string
  avatarUrl?: string
}

const SIDEBAR_USER_PROFILE_CACHE_KEY = 'sidebar_user_profile_cache_v1'

interface SidebarUserProfileCache extends SidebarUserProfile {
  updatedAt: number
}

const readSidebarUserProfileCache = (): SidebarUserProfile | null => {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_USER_PROFILE_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SidebarUserProfileCache
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.wxid || !parsed.displayName) return null
    return {
      wxid: parsed.wxid,
      displayName: parsed.displayName,
      alias: parsed.alias,
      avatarUrl: parsed.avatarUrl
    }
  } catch {
    return null
  }
}

const writeSidebarUserProfileCache = (profile: SidebarUserProfile): void => {
  if (!profile.wxid || !profile.displayName) return
  try {
    const payload: SidebarUserProfileCache = {
      ...profile,
      updatedAt: Date.now()
    }
    window.localStorage.setItem(SIDEBAR_USER_PROFILE_CACHE_KEY, JSON.stringify(payload))
  } catch {
    // 忽略本地缓存失败，不影响主流程
  }
}

const normalizeAccountId = (value?: string | null): string => {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  if (trimmed.toLowerCase().startsWith('wxid_')) {
    const match = trimmed.match(/^(wxid_[^_]+)/i)
    return match?.[1] || trimmed
  }
  const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  return suffixMatch ? suffixMatch[1] : trimmed
}

interface SidebarProps {
  collapsed: boolean
}

function Sidebar({ collapsed }: SidebarProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const [authEnabled, setAuthEnabled] = useState(false)
  const [activeExportTaskCount, setActiveExportTaskCount] = useState(0)
  const [userProfile, setUserProfile] = useState<SidebarUserProfile>({
    wxid: '',
    displayName: '未识别用户'
  })
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false)
  const [showClearAccountDialog, setShowClearAccountDialog] = useState(false)
  const [shouldClearCacheData, setShouldClearCacheData] = useState(false)
  const [shouldClearExportData, setShouldClearExportData] = useState(false)
  const [isClearingAccountData, setIsClearingAccountData] = useState(false)
  const accountCardWrapRef = useRef<HTMLDivElement | null>(null)
  const setLocked = useAppStore(state => state.setLocked)

  useEffect(() => {
    window.electronAPI.auth.verifyEnabled().then(setAuthEnabled)
  }, [])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!isAccountMenuOpen) return
      const target = event.target as Node | null
      if (accountCardWrapRef.current && target && !accountCardWrapRef.current.contains(target)) {
        setIsAccountMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isAccountMenuOpen])

  useEffect(() => {
    const unsubscribe = onExportSessionStatus((payload) => {
      const countFromPayload = typeof payload?.activeTaskCount === 'number'
        ? payload.activeTaskCount
        : Array.isArray(payload?.inProgressSessionIds)
          ? payload.inProgressSessionIds.length
          : 0
      const normalized = Math.max(0, Math.floor(countFromPayload))
      setActiveExportTaskCount(normalized)
    })

    requestExportSessionStatus()
    const timer = window.setTimeout(() => requestExportSessionStatus(), 120)

    return () => {
      unsubscribe()
      window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    const loadCurrentUser = async () => {
      const patchUserProfile = (patch: Partial<SidebarUserProfile>, expectedWxid?: string) => {
        setUserProfile(prev => {
          if (expectedWxid && prev.wxid && prev.wxid !== expectedWxid) {
            return prev
          }
          const next: SidebarUserProfile = {
            ...prev,
            ...patch
          }
          if (!next.displayName) {
            next.displayName = next.wxid || '未识别用户'
          }
          writeSidebarUserProfileCache(next)
          return next
        })
      }

      try {
        const wxid = await configService.getMyWxid()
        const resolvedWxidRaw = String(wxid || '').trim()
        const cleanedWxid = normalizeAccountId(resolvedWxidRaw)
        const resolvedWxid = cleanedWxid || resolvedWxidRaw
        const wxidCandidates = new Set<string>([
          resolvedWxidRaw.toLowerCase(),
          resolvedWxid.trim().toLowerCase(),
          cleanedWxid.trim().toLowerCase()
        ].filter(Boolean))

        const normalizeName = (value?: string | null): string | undefined => {
          if (!value) return undefined
          const trimmed = value.trim()
          if (!trimmed) return undefined
          const lowered = trimmed.toLowerCase()
          if (lowered === 'self') return undefined
          if (lowered.startsWith('wxid_')) return undefined
          if (wxidCandidates.has(lowered)) return undefined
          return trimmed
        }

        const pickFirstValidName = (...candidates: Array<string | null | undefined>): string | undefined => {
          for (const candidate of candidates) {
            const normalized = normalizeName(candidate)
            if (normalized) return normalized
          }
          return undefined
        }

        const fallbackDisplayName = resolvedWxid || '未识别用户'

        // 第一阶段：先把 wxid/名称打上，保证侧边栏第一时间可见。
        patchUserProfile({
          wxid: resolvedWxid,
          displayName: fallbackDisplayName
        })

        if (!resolvedWxidRaw && !resolvedWxid) return

        // 第二阶段：后台补齐名称（不会阻塞首屏）。
        void (async () => {
          try {
            let myContact: Awaited<ReturnType<typeof window.electronAPI.chat.getContact>> | null = null
            for (const candidate of Array.from(new Set([resolvedWxidRaw, resolvedWxid, cleanedWxid].filter(Boolean)))) {
              const contact = await window.electronAPI.chat.getContact(candidate)
              if (!contact) continue
              if (!myContact) myContact = contact
              if (contact.remark || contact.nickName || contact.alias) {
                myContact = contact
                break
              }
            }
            const fromContact = pickFirstValidName(
              myContact?.remark,
              myContact?.nickName,
              myContact?.alias
            )

            if (fromContact) {
              patchUserProfile({ displayName: fromContact }, resolvedWxid)
              // 同步补充微信号（alias）
              if (myContact?.alias) {
                patchUserProfile({ alias: myContact.alias }, resolvedWxid)
              }
              return
            }

            const enrichTargets = Array.from(new Set([resolvedWxidRaw, resolvedWxid, cleanedWxid, 'self'].filter(Boolean)))
            const enrichedResult = await window.electronAPI.chat.enrichSessionsContactInfo(enrichTargets)
            const enrichedDisplayName = pickFirstValidName(
              enrichedResult.contacts?.[resolvedWxidRaw]?.displayName,
              enrichedResult.contacts?.[resolvedWxid]?.displayName,
              enrichedResult.contacts?.[cleanedWxid]?.displayName,
              enrichedResult.contacts?.self?.displayName,
              myContact?.alias
            )
            const bestName = enrichedDisplayName
            if (bestName) {
              patchUserProfile({ displayName: bestName }, resolvedWxid)
            }
            // 降级分支也补充微信号
            if (myContact?.alias) {
              patchUserProfile({ alias: myContact.alias }, resolvedWxid)
            }
          } catch (nameError) {
            console.error('加载侧边栏用户昵称失败:', nameError)
          }
        })()

        // 第二阶段：后台补齐头像（不会阻塞首屏）。
        void (async () => {
          try {
            const avatarResult = await window.electronAPI.chat.getMyAvatarUrl()
            if (avatarResult.success && avatarResult.avatarUrl) {
              patchUserProfile({ avatarUrl: avatarResult.avatarUrl }, resolvedWxid)
            }
          } catch (avatarError) {
            console.error('加载侧边栏用户头像失败:', avatarError)
          }
        })()
      } catch (error) {
        console.error('加载侧边栏用户信息失败:', error)
      }
    }

    const cachedProfile = readSidebarUserProfileCache()
    if (cachedProfile) {
      setUserProfile(prev => ({
        ...prev,
        ...cachedProfile
      }))
    }

    void loadCurrentUser()
    const onWxidChanged = () => { void loadCurrentUser() }
    window.addEventListener('wxid-changed', onWxidChanged as EventListener)
    return () => window.removeEventListener('wxid-changed', onWxidChanged as EventListener)
  }, [])

  const getAvatarLetter = (name: string): string => {
    if (!name) return '?'
    return [...name][0] || '?'
  }

  const isActive = (path: string) => {
    return location.pathname === path || location.pathname.startsWith(`${path}/`)
  }
  const exportTaskBadge = activeExportTaskCount > 99 ? '99+' : `${activeExportTaskCount}`
  const canConfirmClear = shouldClearCacheData || shouldClearExportData

  const resetClearDialogState = () => {
    setShouldClearCacheData(false)
    setShouldClearExportData(false)
    setShowClearAccountDialog(false)
  }

  const openClearAccountDialog = () => {
    setIsAccountMenuOpen(false)
    setShouldClearCacheData(false)
    setShouldClearExportData(false)
    setShowClearAccountDialog(true)
  }

  const openSettingsFromAccountMenu = () => {
    setIsAccountMenuOpen(false)
    navigate('/settings', {
      state: {
        backgroundLocation: location
      }
    })
  }

  const handleConfirmClearAccountData = async () => {
    if (!canConfirmClear || isClearingAccountData) return
    setIsClearingAccountData(true)
    try {
      const result = await window.electronAPI.chat.clearCurrentAccountData({
        clearCache: shouldClearCacheData,
        clearExports: shouldClearExportData
      })
      if (!result.success) {
        window.alert(result.error || '清理失败，请稍后重试。')
        return
      }
      window.localStorage.removeItem(SIDEBAR_USER_PROFILE_CACHE_KEY)
      setUserProfile({ wxid: '', displayName: '未识别用户' })
      window.dispatchEvent(new Event('wxid-changed'))

      const removedPaths = Array.isArray(result.removedPaths) ? result.removedPaths : []
      const selectedScopes = [
        shouldClearCacheData ? '缓存数据' : '',
        shouldClearExportData ? '导出数据' : ''
      ].filter(Boolean)
      const detailLines: string[] = [
        `清理范围：${selectedScopes.join('、') || '未选择'}`,
        `已清理项目：${removedPaths.length} 项`
      ]
      if (removedPaths.length > 0) {
        detailLines.push('', '清理明细（最多显示 8 项）：')
        for (const [index, path] of removedPaths.slice(0, 8).entries()) {
          detailLines.push(`${index + 1}. ${path}`)
        }
        if (removedPaths.length > 8) {
          detailLines.push(`... 其余 ${removedPaths.length - 8} 项已省略`)
        }
      }
      if (result.warning) {
        detailLines.push('', `注意：${result.warning}`)
      }
      const followupHint = shouldClearCacheData
        ? '若需再次获取数据，请手动登录微信客户端并重新在 WeFlow 完成配置。'
        : '你可以继续使用当前登录状态，无需重新登录。'
      window.alert(`账号数据清理完成。\n\n${detailLines.join('\n')}\n\n为保障数据安全，WeFlow 已清除该账号本地缓存/导出相关数据。${followupHint}`)
      resetClearDialogState()
      if (shouldClearCacheData) {
        window.location.reload()
      }
    } catch (error) {
      console.error('清理账号数据失败:', error)
      window.alert('清理失败，请稍后重试。')
    } finally {
      setIsClearingAccountData(false)
    }
  }

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <nav className="nav-menu">
        {/* 首页 */}
        <NavLink
          to="/home"
          className={`nav-item ${isActive('/home') ? 'active' : ''}`}
          title={collapsed ? '首页' : undefined}
        >
          <span className="nav-icon"><Home size={20} /></span>
          <span className="nav-label">首页</span>
        </NavLink>

        {/* 聊天 */}
        <NavLink
          to="/chat"
          className={`nav-item ${isActive('/chat') ? 'active' : ''}`}
          title={collapsed ? '聊天' : undefined}
        >
          <span className="nav-icon"><MessageSquare size={20} /></span>
          <span className="nav-label">聊天</span>
        </NavLink>

        {/* 朋友圈 */}
        <NavLink
          to="/sns"
          className={`nav-item ${isActive('/sns') ? 'active' : ''}`}
          title={collapsed ? '朋友圈' : undefined}
        >
          <span className="nav-icon"><Aperture size={20} /></span>
          <span className="nav-label">朋友圈</span>
        </NavLink>

        {/* 通讯录 */}
        <NavLink
          to="/contacts"
          className={`nav-item ${isActive('/contacts') ? 'active' : ''}`}
          title={collapsed ? '通讯录' : undefined}
        >
          <span className="nav-icon"><UserCircle size={20} /></span>
          <span className="nav-label">通讯录</span>
        </NavLink>

        {/* 聊天分析 */}
        <NavLink
          to="/analytics"
          className={`nav-item ${isActive('/analytics') ? 'active' : ''}`}
          title={collapsed ? '聊天分析' : undefined}
        >
          <span className="nav-icon"><BarChart3 size={20} /></span>
          <span className="nav-label">聊天分析</span>
        </NavLink>

        {/* 年度报告 */}
        <NavLink
          to="/annual-report"
          className={`nav-item ${isActive('/annual-report') ? 'active' : ''}`}
          title={collapsed ? '年度报告' : undefined}
        >
          <span className="nav-icon"><FileText size={20} /></span>
          <span className="nav-label">年度报告</span>
        </NavLink>

        {/* 导出 */}
        <NavLink
          to="/export"
          className={`nav-item ${isActive('/export') ? 'active' : ''}`}
          title={collapsed ? '导出' : undefined}
        >
          <span className="nav-icon nav-icon-with-badge">
            <Download size={20} />
            {collapsed && activeExportTaskCount > 0 && (
              <span className="nav-badge icon-badge">{exportTaskBadge}</span>
            )}
          </span>
          <span className="nav-label">导出</span>
          {!collapsed && activeExportTaskCount > 0 && (
            <span className="nav-badge">{exportTaskBadge}</span>
          )}
        </NavLink>


      </nav>

      <div className="sidebar-footer">
        <button
          className="nav-item"
          onClick={() => {
            if (authEnabled) {
              setLocked(true)
              return
            }
            navigate('/settings', {
              state: {
                initialTab: 'security',
                backgroundLocation: location
              }
            })
          }}
          title={collapsed ? (authEnabled ? '锁定' : '未锁定') : undefined}
        >
          <span className="nav-icon">{authEnabled ? <Lock size={20} /> : <LockOpen size={20} />}</span>
          <span className="nav-label">{authEnabled ? '锁定' : '未锁定'}</span>
        </button>

        <div className="sidebar-user-card-wrap" ref={accountCardWrapRef}>
          {isAccountMenuOpen && (
            <div className="sidebar-user-menu" role="menu" aria-label="账号菜单">
              <button
                className="sidebar-user-menu-item"
                onClick={openSettingsFromAccountMenu}
                type="button"
                role="menuitem"
              >
                <Settings size={14} />
                <span>设置</span>
              </button>
              <button
                className="sidebar-user-menu-item danger"
                onClick={openClearAccountDialog}
                type="button"
                role="menuitem"
              >
                <Trash2 size={14} />
                <span>清除数据</span>
              </button>
            </div>
          )}
          <div
            className={`sidebar-user-card ${isAccountMenuOpen ? 'menu-open' : ''}`}
            title={collapsed ? `${userProfile.displayName}${(userProfile.alias || userProfile.wxid) ? `\n${userProfile.alias || userProfile.wxid}` : ''}` : undefined}
            onClick={() => setIsAccountMenuOpen(prev => !prev)}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setIsAccountMenuOpen(prev => !prev)
              }
            }}
          >
            <div className="user-avatar">
              {userProfile.avatarUrl ? <img src={userProfile.avatarUrl} alt="" /> : <span>{getAvatarLetter(userProfile.displayName)}</span>}
            </div>
            <div className="user-meta">
              <div className="user-name">{userProfile.displayName}</div>
              <div className="user-wxid">{userProfile.alias || userProfile.wxid || 'wxid 未识别'}</div>
            </div>
            {!collapsed && (
              <span className={`user-menu-caret ${isAccountMenuOpen ? 'open' : ''}`}>
                <ChevronUp size={14} />
              </span>
            )}
          </div>
        </div>
      </div>

      {showClearAccountDialog && (
        <div className="sidebar-clear-dialog-overlay" onClick={() => !isClearingAccountData && resetClearDialogState()}>
          <div className="sidebar-clear-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <h3>清除此账号所有数据</h3>
            <p>
              操作后可将该账户在 weflow 下产生的所有缓存文件、导出文件等彻底清除。
              清除后必须手动登录微信客户端 weflow 才能再次获取，保障你的数据安全。
            </p>
            <div className="sidebar-clear-options">
              <label>
                <input
                  type="checkbox"
                  checked={shouldClearCacheData}
                  onChange={(event) => setShouldClearCacheData(event.target.checked)}
                  disabled={isClearingAccountData}
                />
                缓存数据
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={shouldClearExportData}
                  onChange={(event) => setShouldClearExportData(event.target.checked)}
                  disabled={isClearingAccountData}
                />
                导出数据
              </label>
            </div>
            <div className="sidebar-clear-actions">
              <button type="button" onClick={resetClearDialogState} disabled={isClearingAccountData}>取消</button>
              <button
                type="button"
                className="danger"
                disabled={!canConfirmClear || isClearingAccountData}
                onClick={handleConfirmClearAccountData}
              >
                {isClearingAccountData ? '清除中...' : '确认清除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}

export default Sidebar
