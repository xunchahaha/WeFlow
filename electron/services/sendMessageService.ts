/**
 * 微信发消息服务（wx_send.dll 版）
 *
 * 原理：
 *  1. 通过 koffi 加载 wx_send.dll
 *  2. 调用 WxSendInject(pid, dllPath) 将 DLL 注入微信进程
 *     - 注入后 DLL 自动找到 Weixin.dll 内部发消息函数（偏移 0x15AA7A0）
 *     - 启动 Named Pipe 服务端（\\.\pipe\WeFlowSendMsg）
 *  3. 调用 WxSendTextMsg(toUsername, content) 通过 Pipe 发送消息
 *
 * IDA 逆向信息（Weixin.dll 基址 0x180000000）：
 *   发消息入口  sub_1815AA7A0  偏移 0x15AA7A0
 *   Manager全局 qword_18A0B3320 偏移 0xA0B3320
 */

import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'

class SendMessageService {
  private koffi: any = null
  private lib: any = null
  private initialized = false

  // 导出函数
  private WxSendInject: any = null
  private WxSendTextMsg: any = null
  private WxSendCleanup: any = null

  // Win32 API（用于查找微信 PID）
  private kernel32: any = null
  private user32: any = null
  private EnumWindows: any = null
  private GetWindowThreadProcessId: any = null
  private GetClassNameW: any = null
  private IsWindowVisible: any = null
  private WNDENUMPROC_PTR: any = null

  private getDllPath(): string {
    const isPackaged = app?.isPackaged ?? false
    const candidates = [
      process.env.WX_SEND_DLL_PATH,
      isPackaged
        ? join(process.resourcesPath, 'resources', 'wx_send.dll')
        : join(process.cwd(), 'resources', 'wx_send.dll'),
      isPackaged
        ? join(process.resourcesPath, 'wx_send.dll')
        : join(app?.getAppPath() ?? '', 'resources', 'wx_send.dll')
    ].filter(Boolean) as string[]

    return candidates.find(p => existsSync(p)) ?? candidates[0]
  }

  private ensureLoaded(): boolean {
    if (this.initialized) return true
    try {
      this.koffi = require('koffi')

      const dllPath = this.getDllPath()
      if (!existsSync(dllPath)) {
        console.error(`[SendMessageService] wx_send.dll 不存在: ${dllPath}`)
        return false
      }

      this.lib = this.koffi.load(dllPath)
      this.WxSendInject   = this.lib.func('bool WxSendInject(uint32 targetPid, uint16* dllPath)')
      this.WxSendTextMsg  = this.lib.func('bool WxSendTextMsg(str toUsername, str content, _Out_ char *errBuf, int errBufSize)')
      this.WxSendCleanup  = this.lib.func('bool WxSendCleanup()')

      // 加载 User32 用于查找微信窗口 PID
      this.user32   = this.koffi.load('user32.dll')
      const WNDENUMPROC = this.koffi.proto('bool __stdcall (void *hWnd, intptr_t lParam)')
      this.WNDENUMPROC_PTR = this.koffi.pointer(WNDENUMPROC)
      this.EnumWindows             = this.user32.func('EnumWindows', 'bool', [this.WNDENUMPROC_PTR, 'intptr_t'])
      this.GetWindowThreadProcessId = this.user32.func('GetWindowThreadProcessId', 'uint32', ['void*', this.koffi.out('uint32*')])
      this.GetClassNameW           = this.user32.func('GetClassNameW', 'int', ['void*', this.koffi.out('uint16*'), 'int'])
      this.IsWindowVisible         = this.user32.func('IsWindowVisible', 'bool', ['void*'])

      this.initialized = true
      return true
    } catch (e) {
      console.error('[SendMessageService] 加载失败:', e)
      return false
    }
  }

  /** 从 UTF-16LE Buffer 读取字符串 */
  private fromWide(buf: Buffer): string {
    const s = buf.toString('utf16le')
    const i = s.indexOf('\0')
    return i >= 0 ? s.slice(0, i) : s
  }

  /** 找到微信主窗口的进程 PID */
  private findWeChatPid(): number {
    let pid = 0
    const cb = this.koffi.register(
      (hwnd: any) => {
        if (!this.IsWindowVisible(hwnd)) return true
        const buf = Buffer.alloc(512)
        this.GetClassNameW(hwnd, buf, 256)
        const cls = this.fromWide(buf)
        if (cls === 'WeChatMainWndForPC') {
          const pidBuf = [0]
          this.GetWindowThreadProcessId(hwnd, pidBuf)
          pid = pidBuf[0]
          return false // 停止枚举
        }
        return true
      },
      this.koffi.proto('bool __stdcall (void *hWnd, intptr_t lParam)')
    )
    this.EnumWindows(cb, 0)
    this.koffi.unregister(cb)
    return pid
  }

  /**
   * 确保 DLL 已注入微信进程。
   * 每次调用都检查 Pipe 是否可用，不可用则重新注入。
   */
  private async ensureInjected(): Promise<{ success: boolean; error?: string }> {
    const pid = this.findWeChatPid()
    if (!pid) return { success: false, error: '未找到微信进程，请确保微信已启动并登录' }

    const dllPath = this.getDllPath()
    const dllPathBuf = Buffer.from(dllPath + '\0', 'utf16le')

    const ok = this.WxSendInject(pid, dllPathBuf)
    if (!ok) return { success: false, error: '注入 wx_send.dll 失败' }

    return { success: true }
  }

  /**
   * 向指定联系人发送文字消息
   * @param toUsername  收件人微信 ID（wxid_xxx 或备注名）
   * @param content     消息内容
   */
  async sendTextMessage(
    toUsername: string,
    content: string
  ): Promise<{ success: boolean; error?: string }> {
    if (process.platform !== 'win32') {
      return { success: false, error: '仅支持 Windows 平台' }
    }
    if (!toUsername || !content) {
      return { success: false, error: '联系人和消息内容不能为空' }
    }
    if (!this.ensureLoaded()) {
      return { success: false, error: 'wx_send.dll 未找到，请先编译 resources/wx_send/' }
    }

    // 确保已注入
    const injectResult = await this.ensureInjected()
    if (!injectResult.success) return injectResult

    // 发送消息
    const errBuf = Buffer.alloc(256)
    const ok = this.WxSendTextMsg(toUsername, content, errBuf, 256)
    if (!ok) {
      const errMsg = errBuf.toString('utf8').replace(/\0.*/, '').trim()
      return { success: false, error: errMsg || '发送失败' }
    }

    return { success: true }
  }

  cleanup(): void {
    if (this.initialized && this.WxSendCleanup) {
      try { this.WxSendCleanup() } catch {}
    }
  }
}

export const sendMessageService = new SendMessageService()
