/**
 * desktop/preload.mjs —— 最小 preload
 *
 * 只暴露只读的版本信息给页面，不做任何 Node 能力透传
 * （contextIsolation + sandbox 都开着，页面拿不到 require/process）。
 * 面板本身是纯前端 + 自己发 HTTP，不需要额外通道。
 */
import { contextBridge } from 'electron';

try {
  contextBridge.exposeInMainWorld('OCGW_DESKTOP', {
    isDesktop: true,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
  });
} catch {
  /* 页面未启用上下文隔离时忽略 */
}
