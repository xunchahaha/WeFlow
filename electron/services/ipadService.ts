/**
 * iPad 协议服务（Android Pad 模式）
 *
 * 通过 HTTP 调用 wechatipad860 的 REST API 实现微信消息发送。
 * 默认地址: http://127.0.0.1:8058
 *
 * 流程：
 *  1. LoginGetQRPad  → 获取安卓 Pad 二维码 + UUID
 *  2. LoginCheckQR   → 轮询扫码状态
 *  3. SendTxt        → 发送文字消息
 */

import http from 'http'

const DEFAULT_BASE = 'http://127.0.0.1:8058'

interface ApiResponse {
  Code: number
  Success: boolean
  Message: string
  Data: any
}

class IpadService {
  private baseUrl = DEFAULT_BASE
  private loggedInWxid = ''

  setBaseUrl(url: string) {
    this.baseUrl = url.replace(/\/+$/, '')
  }

  getBaseUrl() {
    return this.baseUrl
  }

  getLoggedInWxid() {
    return this.loggedInWxid
  }

  /** 通用 POST 请求 */
  private request(path: string, body?: any): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl)
      const postData = body ? JSON.stringify(body) : ''

      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          },
          timeout: 30000
        },
        (res) => {
          let data = ''
          res.on('data', (chunk) => (data += chunk))
          res.on('end', () => {
            try {
              // 检测 Beego 返回的 HTML 错误页面
              if (data.trimStart().startsWith('<') || data.includes('<!DOCTYPE') || data.includes('beego')) {
                reject(new Error('服务尚未就绪，请稍后重试'))
                return
              }
              resolve(JSON.parse(data))
            } catch {
              reject(new Error(`解析响应失败: ${data.slice(0, 200)}`))
            }
          })
        }
      )

      req.on('error', (e) => reject(new Error(`请求失败: ${e.message}`)))
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('请求超时'))
      })

      req.write(postData)
      req.end()
    })
  }

  /** 检测 iPad 协议服务是否在线 */
  async checkConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      // 随便请求一个接口看看能不能通
      await this.request('/api/Login/LoginGetQRCar', { Proxy: {} })
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  /** 获取安卓 Pad 二维码 */
  async getQRCode(proxy?: string): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
            const res = await this.request('/api/Login/LoginGetQRCar', {
        Proxy: proxy ? { ProxyIp: proxy } : {}
      })
      if (res.Success) {
        return { success: true, data: res.Data }
      }
      return { success: false, error: res.Message }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  /** 检测二维码扫描状态 */
  async checkQR(uuid: string): Promise<{ success: boolean; data?: any; error?: string; status?: number }> {
    try {
      const res = await this.request(`/api/Login/LoginCheckQR?uuid=${encodeURIComponent(uuid)}`)
      if (res.Success && res.Data) {
        // 登录成功时记录 wxid（protobuf JSON: acctSectResp.userName）
        const wxid =
          res.Data.acctSectResp?.userName ||
          res.Data.AcctSectResp?.UserName ||
          res.Data.wxid ||
          res.Data.Wxid ||
          ''
        if (wxid) {
          this.loggedInWxid = wxid
        }
      }
      return { success: res.Success, data: res.Data, message: res.Message, error: res.Message, status: res.Code }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  /** 二次登录 */
  async twiceLogin(wxid: string): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      const res = await this.request(`/api/Login/LoginTwiceAutoAuth?wxid=${encodeURIComponent(wxid)}`)
      if (res.Success) {
        this.loggedInWxid = wxid
        return { success: true, data: res.Data }
      }
      return { success: false, error: res.Message }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  /** 发送文字消息 */
  async sendTextMessage(
    toWxid: string,
    content: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    if (!this.loggedInWxid) {
      return { success: false, error: '未登录，请先扫码登录' }
    }
    if (!toWxid || !content) {
      return { success: false, error: '收件人和消息内容不能为空' }
    }

    try {
      const res = await this.request('/api/Msg/SendTxt', {
        Wxid: this.loggedInWxid,
        ToWxid: toWxid,
        Content: content,
        Type: 1
      })
      if (res.Success) {
        return { success: true, data: res.Data }
      }
      return { success: false, error: res.Message }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  /** 获取通讯录列表（返回 wxid 列表） */
  async getContactList(): Promise<{ success: boolean; data?: string[]; error?: string }> {
    if (!this.loggedInWxid) return { success: false, error: '未登录' }
    try {
      const allUsernames: string[] = []
      let wxSeq = 0
      let roomSeq = 0

      // 分页拉取
      for (let i = 0; i < 50; i++) {
        const res = await this.request('/api/Friend/GetContractList', {
          Wxid: this.loggedInWxid,
          CurrentWxcontactSeq: wxSeq,
          CurrentChatRoomContactSeq: roomSeq
        })
        if (!res.Success) return { success: false, error: res.Message }

        const list: string[] = res.Data?.ContactUsernameList || []
        allUsernames.push(...list)

        wxSeq = res.Data?.CurrentWxcontactSeq || 0
        roomSeq = res.Data?.CurrentChatRoomContactSeq || 0

        if (!res.Data?.CountinueFlag) break
      }

      return { success: true, data: allUsernames }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  /** 获取联系人详情（最多20个，逗号分隔） */
  async getContactDetail(towxids: string): Promise<{ success: boolean; data?: any; error?: string }> {
    if (!this.loggedInWxid) return { success: false, error: '未登录' }
    try {
      const res = await this.request('/api/Friend/GetContractDetail', {
        Wxid: this.loggedInWxid,
        Towxids: towxids,
        ChatRoom: ''
      })
      if (res.Success) {
        return { success: true, data: res.Data }
      }
      return { success: false, error: res.Message }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  /** 心跳保活 */
  async heartbeat(): Promise<{ success: boolean; error?: string }> {
    if (!this.loggedInWxid) return { success: false, error: '未登录' }
    try {
      const res = await this.request(`/api/Login/HeartBeat?wxid=${encodeURIComponent(this.loggedInWxid)}`)
      return { success: res.Success, error: res.Message }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  /** 登出 */
  logout() {
    this.loggedInWxid = ''
  }
}

export const ipadService = new IpadService()
