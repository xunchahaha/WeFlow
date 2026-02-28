import { useState, useEffect, useCallback, useRef } from 'react'
import { Smartphone, Send, QrCode, Wifi, WifiOff, LogOut, Users, Search, RefreshCw } from 'lucide-react'
import './IpadPage.scss'

interface ContactItem {
  wxid: string
  nickname: string
  remark: string
  avatar?: string
}

function IpadPage() {
  // 服务器连接
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:8058')
  const [serverOnline, setServerOnline] = useState(false)

  // 登录状态
  const [loggedIn, setLoggedIn] = useState(false)
  const [wxid, setWxid] = useState('')
  const [qrImage, setQrImage] = useState('')
  const [qrUuid, setQrUuid] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)
  const [loginMsg, setLoginMsg] = useState('')

  // 联系人
  const [contacts, setContacts] = useState<ContactItem[]>([])
  const [contactsLoading, setContactsLoading] = useState(false)
  const [contactSearch, setContactSearch] = useState('')
  const [selectedContact, setSelectedContact] = useState<ContactItem | null>(null)

  // 发消息
  const [toWxid, setToWxid] = useState('')
  const [msgContent, setMsgContent] = useState('')
  const [sending, setSending] = useState(false)
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)

  // 轮询 ref
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const api = (window as any).electronAPI?.ipad

  // 初始化：自动启动服务 + 检查状态
  useEffect(() => {
    if (!api) return
    ;(async () => {
      // 先检查是否已登录
      const s = await api.getStatus()
      if (s.loggedIn) {
        setLoggedIn(true)
        setWxid(s.wxid)
        setServerOnline(true)
      }
      if (s.baseUrl) setBaseUrl(s.baseUrl)

      // 自动启动 Redis + 协议服务
      const running = await api.serverRunning()
      if (!running.running) {
        setLoginMsg('正在启动协议服务...')
        const res = await api.startServer()
        if (res.success) {
          setServerOnline(true)
          setLoginMsg('协议服务已就绪')
        } else {
          setLoginMsg(`服务启动失败: ${res.error}`)
        }
      } else {
        setServerOnline(true)
      }
    })()
  }, [])

  // 心跳保活
  useEffect(() => {
    if (!loggedIn || !api) return
    heartbeatRef.current = setInterval(() => api.heartbeat(), 4 * 60 * 1000)
    return () => { if (heartbeatRef.current) clearInterval(heartbeatRef.current) }
  }, [loggedIn])

  // 清理轮询
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  // 检测服务器
  const handleCheckServer = useCallback(async () => {
    if (!api) return
    await api.setBaseUrl(baseUrl)
    const res = await api.checkConnection()
    setServerOnline(res.success)
    setLoginMsg(res.success ? '服务连接成功' : `连接失败: ${res.error}`)
  }, [baseUrl])

  // 获取二维码
  const handleGetQR = useCallback(async () => {
    if (!api) return
    setLoginLoading(true)
    setLoginMsg('')
    setQrImage('')
    setQrUuid('')

    await api.setBaseUrl(baseUrl)
    const res = await api.getQRCode()

    if (res.success && res.data) {
      const data = res.data
      // QR 图片可能是 base64 或 URL
      const img = data.QrBase64 || data.QrImgBase64 || data.qrImgBase64 || data.qrcode || ''
      const uuid = data.Uuid || data.uuid || data.UUID || ''

      if (img) {
        setQrImage(img.startsWith('data:') ? img : `data:image/png;base64,${img}`)
      }
      setQrUuid(uuid)
      setLoginMsg('请用微信扫描二维码')

      // 开始轮询扫码状态
      if (uuid) startPolling(uuid)
    } else {
      setLoginMsg(res.error || '获取二维码失败')
    }
    setLoginLoading(false)
  }, [baseUrl])

  // 轮询扫码
  const startPolling = useCallback((uuid: string) => {
    if (pollRef.current) clearInterval(pollRef.current)

    pollRef.current = setInterval(async () => {
      const res = await api.checkQR(uuid)
      if (res.success && res.data) {
        const data = res.data
        // protobuf JSON: acctSectResp.userName 或直接 wxid/Wxid
        const loginWxid =
          data.acctSectResp?.userName ||
          data.AcctSectResp?.UserName ||
          data.wxid || data.Wxid || data.userName || ''

        if (loginWxid || res.message === '登录成功') {
          // 登录成功
          if (pollRef.current) clearInterval(pollRef.current)
          setLoggedIn(true)
          setWxid(loginWxid || '已登录')
          setQrImage('')
          setQrUuid('')
          setLoginMsg(`登录成功: ${loginWxid || ''}`)
        }
      } else if (res.status === -3 || res.error?.includes('过期')) {
        // 二维码过期
        if (pollRef.current) clearInterval(pollRef.current)
        setLoginMsg('二维码已过期，请重新获取')
        setQrImage('')
        setQrUuid('')
      }
    }, 3000)
  }, [])

  // 登出
  const handleLogout = useCallback(async () => {
    if (!api) return
    await api.logout()
    setLoggedIn(false)
    setWxid('')
    setLoginMsg('')
    setContacts([])
    setSelectedContact(null)
    if (pollRef.current) clearInterval(pollRef.current)
    if (heartbeatRef.current) clearInterval(heartbeatRef.current)
  }, [])

  // 加载联系人
  const loadContacts = useCallback(async () => {
    if (!api) return
    setContactsLoading(true)
    try {
      const listRes = await api.getContactList()
      if (!listRes.success || !listRes.data?.length) {
        setContactsLoading(false)
        return
      }

      const wxids: string[] = listRes.data.filter(
        (id: string) => !id.startsWith('gh_') && id !== 'weixin' && id !== 'filehelper'
      )

      // 分批获取详情（每批20个）
      const allContacts: ContactItem[] = []
      for (let i = 0; i < wxids.length; i += 20) {
        const batch = wxids.slice(i, i + 20).join(',')
        const detailRes = await api.getContactDetail(batch)
        if (detailRes.success && detailRes.data?.ContactList) {
          for (const c of detailRes.data.ContactList) {
            const uid = c.UserName?.string || c.UserName?.String_ || ''
            const nick = c.NickName?.string || c.NickName?.String_ || ''
            const remark = c.Remark?.string || c.Remark?.String_ || ''
            const avatar = c.SmallHeadImgUrl || ''
            if (uid) {
              allContacts.push({ wxid: uid, nickname: nick, remark, avatar })
            }
          }
        }
      }
      setContacts(allContacts)
    } catch (e) {
      console.error('加载联系人失败', e)
    }
    setContactsLoading(false)
  }, [])

  // 登录成功后自动加载联系人
  useEffect(() => {
    if (loggedIn && api) loadContacts()
  }, [loggedIn])

  // 选择联系人
  const handleSelectContact = useCallback((contact: ContactItem) => {
    setSelectedContact(contact)
    setToWxid(contact.wxid)
  }, [])

  // 过滤联系人
  const filteredContacts = contacts.filter((c) => {
    if (!contactSearch) return true
    const q = contactSearch.toLowerCase()
    return c.nickname.toLowerCase().includes(q) ||
      c.remark.toLowerCase().includes(q) ||
      c.wxid.toLowerCase().includes(q)
  })

  // 发送消息
  const handleSend = useCallback(async () => {
    if (!api || !toWxid.trim() || !msgContent.trim() || sending) return
    setSending(true)
    setFeedback(null)

    const res = await api.sendText(toWxid.trim(), msgContent.trim())
    if (res.success) {
      setFeedback({ type: 'success', msg: '发送成功' })
      setMsgContent('')
      setTimeout(() => setFeedback(null), 3000)
    } else {
      setFeedback({ type: 'error', msg: res.error || '发送失败' })
    }
    setSending(false)
  }, [toWxid, msgContent, sending])

  return (
    <div className="ipad-page">
      <div className="ipad-header">
        <Smartphone size={22} />
        <h2>iPad 协议</h2>
        <span className={`status-badge ${serverOnline ? 'online' : 'offline'}`}>
          {serverOnline ? '已连接' : '未连接'}
        </span>
      </div>

      <div className="ipad-server-bar">
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="协议服务地址"
        />
        <button onClick={handleCheckServer}>检测连接</button>
      </div>

      {loginMsg && (
        <div className={`feedback ${loggedIn ? 'success' : serverOnline ? 'success' : 'error'}`}>
          {loginMsg}
        </div>
      )}

      <div className="ipad-content">
        {/* 左侧：登录 */}
        <div className="login-panel">
          <h3>{loggedIn ? '已登录' : '扫码登录'}</h3>

          {!loggedIn ? (
            <>
              <div className="qr-area">
                {qrImage ? (
                  <img src={qrImage} alt="QR Code" />
                ) : (
                  <div className="qr-placeholder">
                    <QrCode size={48} />
                  </div>
                )}
                {qrUuid && <div className="qr-tip">请用微信扫描上方二维码</div>}
              </div>
              <div className="login-actions">
                <button
                  className="btn-primary"
                  onClick={handleGetQR}
                  disabled={loginLoading || !serverOnline}
                >
                  {loginLoading ? '获取中...' : '获取二维码'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="login-info">
                <p>当前账号: <strong>{wxid}</strong></p>
              </div>
              <div className="login-actions">
                <button className="btn-danger" onClick={handleLogout}>
                  <LogOut size={14} style={{ marginRight: 4, verticalAlign: -2 }} />
                  退出登录
                </button>
              </div>
            </>
          )}
        </div>

        {/* 中间：联系人列表 */}
        {loggedIn && (
          <div className="contact-panel">
            <div className="contact-panel-header">
              <h3><Users size={16} style={{ marginRight: 4, verticalAlign: -2 }} />联系人</h3>
              <button
                className="refresh-btn"
                onClick={loadContacts}
                disabled={contactsLoading}
                title="刷新联系人"
              >
                <RefreshCw size={14} className={contactsLoading ? 'spinning' : ''} />
              </button>
            </div>
            <div className="contact-search">
              <Search size={14} />
              <input
                value={contactSearch}
                onChange={(e) => setContactSearch(e.target.value)}
                placeholder="搜索联系人..."
              />
            </div>
            <div className="contact-list">
              {contactsLoading && contacts.length === 0 ? (
                <div className="contact-empty">加载中...</div>
              ) : filteredContacts.length === 0 ? (
                <div className="contact-empty">
                  {contacts.length === 0 ? '暂无联系人' : '无匹配结果'}
                </div>
              ) : (
                filteredContacts.map((c) => (
                  <div
                    key={c.wxid}
                    className={`contact-item ${selectedContact?.wxid === c.wxid ? 'active' : ''}`}
                    onClick={() => handleSelectContact(c)}
                  >
                    <div className="contact-name">
                      {c.remark || c.nickname || c.wxid}
                    </div>
                    {c.remark && c.nickname && (
                      <div className="contact-nick">{c.nickname}</div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* 右侧：发消息 */}
        <div className="send-panel">
          <h3>发送文字消息</h3>

          {loggedIn ? (
            <div className="send-form">
              <label>收件人</label>
              <input
                value={toWxid}
                onChange={(e) => {
                  setToWxid(e.target.value)
                  if (selectedContact?.wxid !== e.target.value) setSelectedContact(null)
                }}
                placeholder="选择左侧联系人或手动输入 wxid"
              />
              {selectedContact && (
                <div className="selected-contact-tag">
                  {selectedContact.remark || selectedContact.nickname}
                </div>
              )}

              <label>消息内容</label>
              <textarea
                value={msgContent}
                onChange={(e) => setMsgContent(e.target.value)}
                placeholder="输入要发送的文字..."
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.ctrlKey) handleSend()
                }}
              />

              {feedback && (
                <div className={`feedback ${feedback.type}`}>{feedback.msg}</div>
              )}

              <button
                className="send-btn"
                onClick={handleSend}
                disabled={sending || !toWxid.trim() || !msgContent.trim()}
              >
                <Send size={14} style={{ marginRight: 4, verticalAlign: -2 }} />
                {sending ? '发送中...' : '发送 (Ctrl+Enter)'}
              </button>
            </div>
          ) : (
            <div className="send-disabled">请先扫码登录后再发送消息</div>
          )}
        </div>
      </div>
    </div>
  )
}

export default IpadPage
