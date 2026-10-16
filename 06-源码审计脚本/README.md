# 06-源码审计脚本

对解包出来的 **38 MB 引擎 bundle**（`out/main/chunks/node-ibnNxpSl.js`）做静态审计的 grep / 结构提取脚本。
用途是回答「客户端到底怎么算免费额度、怎么选模型、怎么构造请求」。

> 结论见 [`../03-分析报告/07-local-server-path.md`](../03-分析报告/07-local-server-path.md)
> 与 [`../03-分析报告/08-upstream-auth.md`](../03-分析报告/08-upstream-auth.md)。

## 依赖

这些脚本**全部依赖** [`../99-解包产物与运行时残留/OpenCode-Desktop-1.19.2-解包/`](../99-解包产物与运行时残留/)。
该目录被删除后本目录所有脚本都跑不了。路径已写成自相对路径（`__dirname` + `..`），
所以只要保持目录结构，整个树可以任意搬移。

## `find_*.js` — 定位引擎里的某个机制

| 脚本 | 找什么 |
|------|--------|
| `find_connected.js` | 引擎如何计算 `GET /provider` 返回的 `connected` 列表 |
| `find_conn_store.js` | 连接/凭据的存储位置 |
| `find_dispatcher.js` | HTTP dispatcher 的构造（用来验证是否有自定义 undici agent） |
| `find_envconn.js` | 环境变量驱动的连接注入 |
| `find_fetch.js` | 引擎里 `fetch` 的包装/注入点 |
| `find_lowerer.js` / `find_lowerer2.js` | 请求「降级器」（把内部请求转成上游 HTTP 的那一层） |
| `find_plugin.js` | 插件系统入口（本目录里最常用来验证「bundle 是否可读」的一个） |

## `dump_*.js` — 把片段原样打印出来

| 脚本 | 说明 |
|------|------|
| `dump_integration.js` | dump 集成层相关片段 |
| `dump_plugin.js` / `dump_ocplugin.js` / `dump_ocplugin2.js` / `dump_ocplugin3.js` / `dump_ocplugin4.js` | 逐轮细化 dump opencode 插件实现（编号越大范围越窄） |

## 数据库与配置

| 脚本 | 说明 |
|------|------|
| `db_success_check.js` | 直接读用户本机 `%USERPROFILE%\.local\share\opencode\opencode.db`，统计成功调用与 token 用量（**只读**） |
| `cfg_hunt.ps1` / `cfg_hunt2.ps1` | 拉全量 `/config`、找自定义 provider 配置文件、在 bundle 里 grep `/provider connected` |

## 用法

```powershell
cd "06-源码审计脚本"
node find_plugin.js        # 验证 99 目录下的 38 MB bundle 可读且能命中
node db_success_check.js   # 只读统计本机 opencode.db 的 token 用量
```

## 注意

- `db_success_check.js` 读的是**用户自己真实的** OpenCode 数据库，只做 `SELECT`，不写入。
- 这些脚本是**取证工具**，不是生产代码；输出的片段仅供人工比对。
