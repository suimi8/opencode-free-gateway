/**
 * desktop/main.mjs —— Electron 桌面外壳
 *
 * 架构：本进程只做「窗口 + 托盘 + 生命周期」，真正的 HTTP 服务跑在**子进程**里
 *      （用 process.execPath 加 ELECTRON_RUN_AS_NODE=1 当作 node 用）。
 * 为什么不用 in-process import：
 *   1. 面板崩了不该把整个 GUI 带崩；
 *   2. server.mjs 里有 process.exit 分支，在主进程里调用会直接杀掉应用；
 *   3. 子进程能干净地 kill 掉，不留僵尸端口。
 *
 * 数据目录：一律写进 Electron 的 userData（app.asar / 安装目录通常只读）：
 *   panel.db / pool.db / mihomo 运行时（订阅缓存、池子状态）/ panel.log
 *
 * 前提：electron-builder 配置里 **asar: false**。asar 打包后子进程读不到
 *       内部的 .mjs（ELECTRON_RUN_AS_NODE 不认 asar），关掉最省事也最可靠。
 */
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// ⚠️ electron 是 CJS 模块，ESM 里**不能**具名导入
//    （会报 "does not provide an export named 'BrowserWindow'"），
//    必须走 createRequire 拿 module.exports 再解构。
const require = createRequire(import.meta.url);
const { app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog, clipboard } = require('electron');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PANEL_DIR = path.join(ROOT, '01-管理面板');
const SERVER = path.join(PANEL_DIR, 'server.mjs');
const IS_DEV = process.argv.includes('--dev');
const WANT_HEADLESS = process.argv.includes('--headless');

/* ── 单实例 ── */
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const DATA = app.getPath('userData');
const LOG_PATH = path.join(DATA, 'panel.log');
fs.mkdirSync(DATA, { recursive: true });

let win = null;
let tray = null;
let child = null;
let port = 0;
let quitting = false;
let serverReady = false;

const log = (...a) => { try { console.log('[gui]', ...a); } catch { /* 忽略 */ } };

/* ══════════════════════════════════════════════════ 端口与就绪探测 */
function tryListen(p) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(p, '127.0.0.1');
  });
}
async function pickPort() {
  const want = Number(process.env.OCGW_PORT || 0);
  if (want && await tryListen(want)) return want;
  if (await tryListen(8790)) return 8790;
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function probe(p, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: p, path: '/', timeout }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
async function waitReady(p, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (child && child.exitCode !== null) return false;
    if (await probe(p)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/* ══════════════════════════════════════════════════ 启动面板子进程 */
function startServer() {
  const out = fs.openSync(LOG_PATH, 'a');
  child = spawn(process.execPath, [SERVER], {
    cwd: PANEL_DIR,
    // ELECTRON_RUN_AS_NODE=1 让 Electron 二进制退化成纯 node
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PANEL_HOST: '127.0.0.1',
      PANEL_PORT: String(port),
      PANEL_DB: path.join(DATA, 'panel.db'),
      POOL_DB: path.join(DATA, 'pool.db'),
      MIHOMO_RUNTIME: path.join(DATA, 'mihomo'),
      NODE_ENV: 'production',
      // 桌面版默认不启用节点池（没装内核），用户装好后可在面板里开
      PANEL_NODE_POOL: process.env.PANEL_NODE_POOL || '0',
    },
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.on('exit', (code, sig) => {
    log('面板子进程退出', code, sig);
    if (!quitting && serverReady) {
      const tail = tailLog(20);
      dialog.showErrorBox('面板服务已退出', `退出码 ${code ?? sig}\n\n日志（${LOG_PATH}）：\n${tail}`);
    }
  });
  log('面板子进程已启动 pid=', child.pid, 'port=', port);
}
function tailLog(n = 30) {
  try { return fs.readFileSync(LOG_PATH, 'utf8').split('\n').slice(-n).join('\n'); } catch { return '(无日志)'; }
}

/* ══════════════════════════════════════════════════ 窗口 */
function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    title: 'OpenCode 免费层网关',
    backgroundColor: '#0f1115',
    show: false,
    autoHideMenuBar: false,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(HERE, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => { if (!WANT_HEADLESS) win.show(); });
  win.on('closed', () => { win = null; });

  // 外链一律交给系统浏览器，不在应用内开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) { e.preventDefault(); shell.openExternal(url); }
  });

  win.loadURL(`http://127.0.0.1:${port}/`);
  if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });
}

function iconPath() {
  for (const n of ['icon.png', 'icon.ico', 'icon.icns']) {
    for (const p of [path.join(ROOT, 'build', n), path.join(HERE, n), path.join(app.getAppPath(), 'build', n)]) {
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

/* ══════════════════════════════════════════════════ 托盘 */
function createTray() {
  const ip = iconPath();
  if (!ip) return;
  try {
    let img = nativeImage.createFromPath(ip);
    if (img.isEmpty()) return;
    // Windows/Linux 托盘用小图标
    if (process.platform !== 'darwin') img = img.resize({ width: 20, height: 20 });
    tray = new Tray(img);
    tray.setToolTip('OpenCode 免费层网关');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: showWindow },
      { label: `打开地址  http://127.0.0.1:${port}/`, click: () => shell.openExternal(`http://127.0.0.1:${port}/`) },
      { type: 'separator' },
      { label: '打开数据目录', click: () => shell.openPath(DATA) },
      { label: '查看运行日志', click: () => shell.openPath(LOG_PATH) },
      { type: 'separator' },
      { label: '退出', click: () => quitApp() },
    ]));
    tray.on('click', showWindow);
  } catch (e) {
    log('托盘创建失败（部分 Linux 桌面环境不支持）', String(e.message));
  }
}
function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ══════════════════════════════════════════════════ 菜单 */
function createMenu() {
  const tpl = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: '应用',
      submenu: [
        { label: '在浏览器中打开', click: () => shell.openExternal(`http://127.0.0.1:${port}/`) },
        { label: '复制访问地址', click: () => { clipboard.writeText(`http://127.0.0.1:${port}/`); } },
        { type: 'separator' },
        { label: '打开数据目录', click: () => shell.openPath(DATA) },
        { label: '查看运行日志', click: () => shell.openPath(LOG_PATH) },
        { type: 'separator' },
        { label: '重启面板服务', click: () => restartServer() },
        ...(process.platform !== 'darwin' ? [{ type: 'separator' }, { label: '退出', accelerator: 'Alt+F4', click: () => quitApp() }] : []),
      ],
    },
    { label: '视图', role: 'viewMenu' },
    {
      label: '帮助',
      submenu: [
        { label: '项目主页', click: () => shell.openExternal('https://github.com/suimi8/opencode-free-gateway') },
        {
          label: '关于',
          click: () => dialog.showMessageBox(win ?? undefined, {
            type: 'info',
            title: '关于',
            message: 'OpenCode 免费层网关',
            detail: `版本 ${app.getVersion()}\nElectron ${process.versions.electron} · Node ${process.versions.node}\n\n服务地址 http://127.0.0.1:${port}/\n数据目录 ${DATA}\n\nMIT License`,
            buttons: ['好'],
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

async function restartServer() {
  if (!child) return;
  quitting = true;
  await stopServer();
  quitting = false;
  serverReady = false;
  startServer();
  const ok = await waitReady(port);
  serverReady = ok;
  if (win) win.loadURL(`http://127.0.0.1:${port}/`);
}

function stopServer() {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const done = () => resolve();
    child.once('exit', done);
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
      else child.kill('SIGTERM');
    } catch { /* 忽略 */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 忽略 */ } resolve(); }, 3000);
  });
}

function quitApp() {
  quitting = true;
  stopServer().finally(() => { try { tray?.destroy(); } catch { /* 忽略 */ } app.quit(); });
}

/* ══════════════════════════════════════════════════ 入口 */
app.on('second-instance', () => showWindow());
app.on('window-all-closed', () => {
  // macOS 习惯是关窗口不退应用；其它平台直接退
  if (process.platform !== 'darwin') quitApp();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) showWindow(); });
app.on('before-quit', () => { quitting = true; });

app.whenReady().then(async () => {
  log('data=', DATA, 'root=', ROOT, 'dev=', IS_DEV);

  if (!fs.existsSync(SERVER)) {
    dialog.showErrorBox('文件缺失', `找不到面板服务：\n${SERVER}\n\n安装包不完整，请重新下载。`);
    app.quit();
    return;
  }

  port = await pickPort();
  process.env.OCGW_URL = `http://127.0.0.1:${port}/`;
  log('port=', port);

  startServer();
  const ready = await waitReady(port);
  serverReady = ready;

  if (!ready) {
    dialog.showErrorBox('面板服务启动失败', `30 秒内未能监听 127.0.0.1:${port}\n\n日志（${LOG_PATH}）：\n${tailLog(25)}`);
    app.quit();
    return;
  }

  createWindow();
  createMenu();
  createTray();

  if (WANT_HEADLESS) {
    log('headless 模式：不开窗口，服务在', `http://127.0.0.1:${port}/`);
    try { shell.openExternal(`http://127.0.0.1:${port}/`); } catch { /* 忽略 */ }
  }
}).catch((e) => {
  dialog.showErrorBox('启动异常', String(e && e.stack || e));
  app.quit();
});
