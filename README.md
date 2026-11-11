# AI 自动混剪

仓库：https://github.com/white1star/ai-auto-remix ｜ 完整包：https://github.com/white1star/ai-auto-remix/releases/tag/v1.0.0

把「一行文案 = 一句话 = 一条字幕 = 一条配音」跑成一条 1080×1920 竖版成片：分镜、字幕特效、点睛音效、BGM 参考视频扒伴奏、封面与字幕导出，一个网页里全部做完。账号、素材、成片都在自己电脑上，不需要 WorkBuddy，不需要贴提示词。

运行环境：Windows 10/11 64 位。服务端是随包 Node.js，前端是原生 HTML/CSS/JS，没有构建步骤。

---

## 两种获取方式

| 方式 | 拿到什么 | 适合谁 | 首次要做什么 |
|---|---|---|---|
| **Release ZIP**（推荐） | 源码 + 完整 `runtime/`，解压即用 | 直接拿去用的人 | 解压 → 双击 `启动.bat` |
| **git clone 源码** | 源码 + `runtime/edge-tts/`，不含 3 个大 exe | 要改代码、要跟进更新的人 | `git clone` → 双击 `安装运行时.bat` → 双击 `启动.bat` |

`runtime/edge-tts/` 随源码仓库一起提交（约 31 MB，113 个小文件），所以两种方式的**免费系统音色都开箱可用**。

---

## 快速开始（Release ZIP）

1. 下载 `AI-Auto-Remix-v1.0.0-完整包.zip`，**解压到本地磁盘**（不要直接在 ZIP 里双击）。
2. 双击 `启动.bat`。首次会自动检测运行时，然后打开 `http://127.0.0.1:8765`。黑色窗口要一直开着，关掉就等于退出服务。
3. 网页上注册自己的账号，之后历史记录跟着这个账号走。
4. 双击 `体检.bat` 可只做环境自检、不启动服务。

## 快速开始（源码 clone）

1. `git clone <仓库地址>` 后进入目录，双击 `安装运行时.bat`。它下载 Node v22.22.2 与 ffmpeg/ffprobe 到 `runtime/`，约 150 MB，只装一次，不写注册表、不改系统 PATH。
2. 装完双击 `启动.bat`。`启动.bat` 自己也会在缺运行时的时候自动调这个安装脚本。
3. 想改端口或数据目录：把 `配置.example.json` 复制成 `配置.json`，改 `port` / `dataDir` / `role`。`配置.json` 已被 `.gitignore` 排除，不会被误提交。

---

## 配音音色

| 通道 | 数量 | 依赖 | 计费 |
|---|---|---|---|
| 云端音色 · 火山豆包语音合成模型 2.0 | 9 个（云舟 / 小天 / 刘飞 / 解说小明 / 磁性解说男声 / 大壹 / Vivi / 小何 / 清新女声） | 联网 + `VOLC_API_KEY` | 按量计费 |
| 系统音色 · edge-tts | 8 个（云健 / 云扬 / 云希 / 云夏 / 晓晓 / 晓伊 / 晓北 / 晓妮） | 联网，随包已带 | 免费 |

没配云端凭证时网页会写明缺什么，直接用免费系统音色也能出片。语速 0.70×–1.80×，默认 1.00×（实测约 5 字/秒），句间停顿 0.45 秒。点「效果试听」会先念文案第一句，听过再出片。

> 本机 F5 / GPT-SoVITS 克隆音色的**网页入口已移除**。`server/clone.mjs` 与 `connector/skills/voice-clone-dub/` 保留给命令行 / MCP 调试使用，普通用户不用管。

## 配置云端凭证（可选，且只在用 2.0 音色时需要）

在 `%USERPROFILE%\.workbuddy\voices\` 下新建 `.cloud-key.json`，照 `cloud-key.example.json` 填：

```json
{
  "VOLC_API_KEY": "火山新版控制台的 X-Api-Key",
  "VOLC_APPID": "",
  "VOLC_TOKEN": ""
}
```

新版控制台只认 `X-Api-Key`；`VOLC_APPID` + `VOLC_TOKEN` 是旧版鉴权才用。**这个文件在用户目录里，不随包分发、绝不提交到 GitHub、不要发给别人**，按量计费的额度算配置者本人。

---

## 数据与隐私

- 默认数据目录：`%LOCALAPPDATA%\AiAutoRemix\data`。账号、上传素材、成片库、任务记录全在本机。
- 项目管理（文案 / 标题 / 音色 / 语速 / 更多设置 / 素材选择 / 成片结果）存在浏览器 `localStorage`，按登录账号隔离，换电脑或清浏览器数据不会带过去。
- 本仓库**不含**任何人的账号数据库、MCP 令牌、真实 API Key、测试音频、运行日志或历史成片；这些都由 `.gitignore` 排除。
- 服务默认只监听 `127.0.0.1`，不往办公网暴露。多人使用请把完整包发给每个人各自跑，数据、素材、火山额度各自独立。
- 「新建项目」会把文案、标题、音色、语速、BGM 链接、字幕特效、成片保存位置、封面、素材选择、预览和成片下载栏全部清回空白初始态；切回旧项目会恢复当时保存的内容。服务端已上传的文件不会因此被删除。

---

## 为什么三个大 exe 不在 git 仓库里

GitHub 普通仓库单文件硬上限 100 MB，实测这两个 ffmpeg 可执行文件刚好越线，直接 `git push` 会被拒。

| 文件 | 实测字节 | 源码仓库 | Release ZIP |
|---|---:|---|---|
| `runtime/node.exe` | 87,074,816 | 不含，安装脚本下载 | 含 |
| `runtime/ffmpeg.exe` | 105,423,872 | **不含**（超 100 MB） | 含 |
| `runtime/ffprobe.exe` | 105,221,120 | **不含**（超 100 MB） | 含 |
| `runtime/edge-tts/`（113 个文件，最大 6,945,272） | 约 31 MB | 含 | 含 |

源码仓库约 34 MB（首次提交 181 个文件）；完整 ZIP 含上述运行时，实测 188 个文件 / 316.8 MB 原始内容压缩为 **123.2 MB**（Release 单资产上限 2 GB，不受 100 MB 限制）。

---

## 目录结构

```
├─ index.html / admin.html      网页主界面 / 管理后台
├─ assets/                     前端增强层（项目管理、云端音色、试听）
├─ server/                     HTTP API、渲染管线、鉴权、云端配音
├─ launcher/                   启动器与运行时安装脚本
├─ connector/                  配套技能与命令行脚本（云端 TTS 适配层在此）
├─ defaults/                   内置示例音轨、字幕、4 个点睛音效
├─ runtime/edge-tts/           免费系统音色（随仓库提交）
├─ 启动.bat / 体检.bat / 安装运行时.bat
├─ 使用说明.txt                 给最终用户的完整说明
├─ 配置.example.json / cloud-key.example.json
└─ 启动-中央.bat               可选的 central + local 分布式部署入口
```

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 网页报「接口不存在」 | 后端 Node 进程是旧代码起的。关掉黑窗口，重新双击 `启动.bat`；静态页刷新不会重读已加载的 `server/*.mjs` |
| 云端音色下拉是空的 | 没配 `VOLC_API_KEY`。用免费系统音色，或按上文配置凭证后重启服务 |
| 成片每句尾字被吞 | 已在 `TRIM_TAIL` 用 `start_silence=0.03` 修掉，别改回 `start_duration=0.12` |
| 双击 `.bat` 闪退 / `goto` 异常 | 换行符问题。`.gitattributes` 已强制 `.bat` 为 CRLF，重新 clone 一次即可 |
| 想让同事用局域网地址打开 | 不支持作为正式分发方式。请发完整包给每人各自运行 |

---

## GitHub 仓库与 Release

| 项 | 地址 |
|---|---|
| 源码仓库 | https://github.com/white1star/ai-auto-remix |
| 最新完整包 | https://github.com/white1star/ai-auto-remix/releases/tag/v1.0.0 |
| Release 资产 | `AI-Auto-Remix-v1.0.0-完整包.zip`（解压即用） |

源码在 `main` 分支。日常维护：

```bash
git remote -v                              # 应指向 white1star/ai-auto-remix
git add -A && git commit -m "..." && git push
```

换新版完整包：在 Release 页面删掉旧 ZIP、重新上传同名文件即可（网页直接拖进去也行）。
源码仓库里**不要**放 `runtime/node.exe`、`runtime/ffmpeg.exe`、`runtime/ffprobe.exe`，
它们超过 GitHub 普通仓库 100 MB 单文件上限，只能走 Release 资产。

推送前请再确认一次：仓库里没有 `配置.json`、没有 `.cloud-key.json`、没有 `data/` 目录、没有真实 Key。

## 许可证

见 `LICENSE`。当前未选择开源协议，保留所有权利；若要公开开源，请先自行确认并替换为合适的许可证。
