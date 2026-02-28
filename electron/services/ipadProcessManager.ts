/**
 * iPad 协议进程管理器
 * 自动启动/停止 Redis 和 main.exe（wechatipad860）
 */

import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import http from 'http'
import { app } from 'electron'

class IpadProcessManager {
  private redisProcess: ChildProcess | null = null
  private mainProcess: ChildProcess | null = null
  private started = false

  /** 获取 ipad-server 资源目录 */
  private getServerDir(): string {
    if (app.isPackaged) {
      // 打包后: <resourcesPath>/resources/ipad-server
      return path.join(process.resourcesPath, 'resources', 'ipad-server')
    }
    // 开发时: <projectRoot>/resources/ipad-server
    return path.join(app.getAppPath(), 'resources', 'ipad-server')
  }

  /** 检查文件是否存在 */
  private checkFiles(): { ok: boolean; missing: string[] } {
    const dir = this.getServerDir()
    const required = [
      path.join(dir, 'main.exe'),
      path.join(dir, 'conf', 'app.conf'),
      path.join(dir, '08sae.dat'),
      path.join(dir, 'redis', 'redis-server.exe'),
    ]
    const missing = required.filter(f => !fs.existsSync(f))
    return { ok: missing.length === 0, missing }
  }

  /** 启动 Redis */
  private startRedis(): Promise<void> {
    return new Promise((resolve, reject) => {
      const dir = this.getServerDir()
      const redisExe = path.join(dir, 'redis', 'redis-server.exe')
      const redisConf = path.join(dir, 'redis', 'redis.windows.conf')

      const args = fs.existsSync(redisConf) ? [redisConf] : []

      this.redisProcess = spawn(redisExe, args, {
        cwd: path.join(dir, 'redis'),
        stdio: 'pipe',
        windowsHide: true,
      })

      let resolved = false

      this.redisProcess.stdout?.on('data', (data: Buffer) => {
        const msg = data.toString()
        console.log('[Redis]', msg.trim())
        // Redis 就绪标志
        if (!resolved && msg.includes('Ready to accept connections')) {
          resolved = true
          resolve()
        }
      })

      this.redisProcess.stderr?.on('data', (data: Buffer) => {
        console.error('[Redis Error]', data.toString().trim())
      })

      this.redisProcess.on('error', (err) => {
        console.error('[Redis] 启动失败:', err.message)
        if (!resolved) { resolved = true; reject(err) }
      })

      this.redisProcess.on('exit', (code) => {
        console.log('[Redis] 进程退出, code:', code)
        this.redisProcess = null
      })

      // 超时兜底：2秒后认为已启动
      setTimeout(() => {
        if (!resolved) { resolved = true; resolve() }
      }, 2000)
    })
  }

  /** 启动 main.exe (wechatipad860) */
  private startMain(): Promise<void> {
    return new Promise((resolve, reject) => {
      const dir = this.getServerDir()
      const mainExe = path.join(dir, 'main.exe')

      this.mainProcess = spawn(mainExe, [], {
        cwd: dir,
        stdio: 'pipe',
        windowsHide: true,
      })

      let resolved = false

      this.mainProcess.stdout?.on('data', (data: Buffer) => {
        const msg = data.toString()
        console.log('[iPad Server]', msg.trim())
        if (!resolved && msg.includes('8058')) {
          resolved = true
          resolve()
        }
      })

      this.mainProcess.stderr?.on('data', (data: Buffer) => {
        console.error('[iPad Server Error]', data.toString().trim())
      })

      this.mainProcess.on('error', (err) => {
        console.error('[iPad Server] 启动失败:', err.message)
        if (!resolved) { resolved = true; reject(err) }
      })

      this.mainProcess.on('exit', (code) => {
        console.log('[iPad Server] 进程退出, code:', code)
        this.mainProcess = null
      })

      // 超时兜底：5秒后认为已启动
      setTimeout(() => {
        if (!resolved) { resolved = true; resolve() }
      }, 5000)
    })
  }

  /** HTTP 健康检查：确认 Beego 服务真正可用 */
  private async waitForReady(port = 8058, maxRetries = 15): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const req = http.request(
            { hostname: '127.0.0.1', port, path: '/', method: 'GET', timeout: 2000 },
            (res) => {
              res.resume() // drain response
              // 只要 HTTP 服务能响应就算就绪
              resolve()
            }
          )
          req.on('error', (e) => reject(e))
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
          req.end()
        })
        console.log(`[iPad] 健康检查通过 (第${i + 1}次)`)
        return
      } catch {
        console.log(`[iPad] 健康检查第${i + 1}次未通过，等待重试...`)
        await new Promise(r => setTimeout(r, 1000))
      }
    }
    console.warn('[iPad] 健康检查超时，继续执行')
  }

  /** 启动所有服务 */
  async start(): Promise<{ success: boolean; error?: string }> {
    if (this.started) return { success: true }

    const check = this.checkFiles()
    if (!check.ok) {
      return {
        success: false,
        error: `缺少文件: ${check.missing.join(', ')}`,
      }
    }

    try {
      console.log('[iPad] 正在启动 Redis...')
      await this.startRedis()
      console.log('[iPad] Redis 已启动')

      console.log('[iPad] 正在启动协议服务...')
      await this.startMain()
      console.log('[iPad] 协议服务进程已启动，等待 HTTP 就绪...')

      await this.waitForReady()
      console.log('[iPad] 协议服务已就绪')

      this.started = true
      return { success: true }
    } catch (e: any) {
      this.stop()
      return { success: false, error: e.message }
    }
  }

  /** 停止所有服务 */
  stop() {
    if (this.mainProcess) {
      try { this.mainProcess.kill() } catch {}
      this.mainProcess = null
    }
    if (this.redisProcess) {
      try { this.redisProcess.kill() } catch {}
      this.redisProcess = null
    }
    this.started = false
    console.log('[iPad] 所有服务已停止')
  }

  /** 是否已启动 */
  isRunning() {
    return this.started
  }
}

export const ipadProcessManager = new IpadProcessManager()
