# DSH Desktop

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web UI 包装成桌面应用：**双击即用**，自动在后台启动 `dsh web` 服务器并在原生窗口中打开界面，无需打开终端、无需手动跑 npx、无需再开浏览器。

## 特性

- **零依赖**：应用内置独立的 Node.js 运行时和完整的 `@deepseek-ai/dsh` 依赖树，**不需要**在系统中安装 Node.js / npm / dsh，也不改动 PATH。
- **启动快**：打开应用 → 显示加载页 → 后台拉起 `dsh web` → 就绪后自动跳转界面。
- **智能复用**：如果目标端口已经有一个 DSH 服务器（比如你终端里开着 `dsh web`），直接复用并展示它，不会重复启动；退出应用时只关闭**自己**启动的服务器，复用的服务器不受影响。端口被其他程序占用时自动在 3081–3180 之间换一个空闲端口。
- **配置共享**：API key、模型、会话等配置与命令行完全共享，沿用 `~/.dsh`（Windows 为 `%USERPROFILE%\.dsh`），在 Web UI 里配好一次即可。
- **健壮性**：服务器异常退出会显示错误页，提供「重试」和「打开日志」；日志位于：
  - macOS：`~/Library/Application Support/DSH/logs/dsh-desktop.log`
  - Windows：`%APPDATA%\DSH\logs\dsh-desktop.log`

## 下载与安装

从 [Releases](../../releases) 页面下载对应平台的最新版本：

| 平台 | 文件 | 说明 |
|---|---|---|
| macOS (Apple Silicon) | `DSH-<version>-arm64.dmg` | 打开 dmg，把 **DSH** 拖入 Applications |
| Windows (x64) | `DSH Setup <version>.exe` | 安装向导，可自选安装目录 |
| Windows (x64) | `DSH <version>.exe` | 免安装便携版，双击直接运行 |

### 关于 Windows 用户是否要装 Node / dsh

**不需要。** Windows 安装包和便携版都内置了 `node.exe`（Windows x64 版）与完整的 dsh 依赖（含 node-pty、koffi、sharp 等原生模块的 Windows 二进制）。安装过程只是解压文件，不会向系统安装 Node.js，也不会污染 PATH。这是与 macOS 版同一套「随包携带运行时」的方案，因此任何没有开发环境的 Windows 机器都能直接使用。

### 未签名提示

本应用未使用代码签名证书：

- macOS：本机编译直接运行没有提示；从别处拷贝的 dmg 首次打开时可能需要在 app 上**右键 → 打开**。
- Windows：SmartScreen 可能提示「未知发布者」，点「更多信息 → 仍要运行」即可。

## 使用

1. 启动 DSH，等待加载页跳转。
2. 首次使用在 **设置 → 模型** 中填入 DeepSeek API key（与网页版操作一致）。
3. 选择工作区，开始对话。

关窗或 Cmd+Q 退出应用时，自己拉起的服务器会被优雅关闭（会话数据持久化在 `~/.dsh`，重开无损）。

### 环境变量（可选）

| 变量 | 作用 |
|---|---|
| `DSH_DESKTOP_PORT` | 强制使用指定端口（默认 3080） |
| `DSH_DESKTOP_USER_DATA` | 覆盖应用数据目录（日志等），默认系统标准位置 |

## 工作原理

```
DSH.app / DSH.exe (Electron)
├── 主进程 main.js：探测端口 → 拉起 dsh web → 就绪检测 → 打开窗口 → 退出时回收子进程
└── Resources/runtime/node/   内置 Node 26 运行时（CI 按平台下载）
└── Resources/app/node_modules 内置 @deepseek-ai/dsh 及其全部依赖
```

dsh 依赖 sharp、node-pty、koffi 等按 Node ABI 编译的原生模块，因此**打包运行时与安装依赖必须使用同一 Node 版本**（当前为 26.3.0）。这也是为什么不用 Electron 内置 Node 直接跑 dsh——ABI 不匹配。

## 从源码构建

要求：Node.js **26.3.0**（与内置运行时一致）与 npm。

```sh
git clone <this repo>
cd dsh-desktop
npm ci                      # 安装依赖（含 @deepseek-ai/dsh）
npm run fetch-runtime       # 下载当前平台的内置 Node 运行时
npm start                   # 开发模式运行

# 打包
npm run icon                # 重新生成图标（可选，仓库已附带生成好的图标）
npm run dist                # macOS：产出 dist/DSH-<version>-arm64.dmg
npm run dist:win            # Windows：产出 dist/DSH Setup <version>.exe 与便携版
```

> `npm ci` 时若 npm 提示 install scripts 未经批准，请运行 `npm approve-scripts koffi node-pty @deepseek-ai/dsh-subprocess-local protobufjs` 后重装（这些脚本负责获取原生模块的预编译二进制，必不可少）。

## 发布流程（GitHub Actions）

`.github/workflows/release.yml` 在推送 `v*` tag 时自动：

- **macOS runner（arm64）**：下载 darwin-arm64 Node 运行时 → 打包 → 产出 `.dmg`
- **Windows runner（x64）**：下载 win-x64 Node 运行时 → 打包 → 产出 NSIS 安装包 `.exe` 与便携版 `.exe`
- 两个平台的产物统一上传到同名 tag 的 Release

本地发布：

```sh
npm version patch            # 或手动改 package.json 版本
git push origin main
git tag v0.0.1 && git push origin v0.0.1   # 触发构建与 Release
```

## 目录结构

```
main.js                   Electron 主进程：服务器生命周期、就绪探测、窗口、日志
preload.js                加载/错误页用到的少量 IPC 桥
loading.html / error.html 启动页与错误页
scripts/fetch-runtime.mjs 按平台下载内置 Node 运行时（CI 与本地共用）
scripts/make-icon.js      用 Electron 渲染生成应用图标
build/                    图标资源（icon.icns / icon.png，已提交，CI 直接使用）
.github/workflows/release.yml  多平台 Release 构建
```

## License

[MIT](LICENSE)
