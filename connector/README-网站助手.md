# 网站是唯一入口

网页填文案、选音色、选素材，点「生成视频」就出片。**配音在这台机器上合成，不需要 WorkBuddy、不需要 MCP、不需要任何令牌。**

双击 `启动.bat` → 浏览器打开 `http://127.0.0.1:8765` → 注册或登录 → 干活。

## 配音的三条路

音色下拉里选什么，决定走哪条：

| 音色下拉选的 | 发声方式 | 274 字耗时 | 是不是参考片原声 |
|---|---|---|---|
| 系统音色（云健、云扬、晓晓…） | 网站自己调 edge-tts | 约 10 秒 | 不是 |
| 我的克隆音色（如「萤石矿·男声」） | 服务端跑 F5 克隆 | 约 12 分钟 | **是** |
| 都不选，也不上传配音 | 包里自带的参考原声 | 秒级 | 是（固定那条） |

克隆音色在下拉里单独一组，标注「本机合成」。选它点生成，任务日志里能看到逐段进度：

```
克隆配音：274 字 / 5 段 · 音色「萤石矿·男声（抖音参考片）」· 1.2×
配音 1/5 完成（43 字，覆盖率 100%，段首 100%）
…
质检：1.00/1.00 1.00/1.00 0.96/1.00 0.98/1.00 1.00/1.00 全部达标
```

## 克隆音色需要准备什么

三样，缺一不可：

| 依赖 | 位置 / 怎么来 |
|---|---|
| F5 权重（约 1.4GB） | 放到 `weights/f5/`，含 `model_1250000.safetensors` + `vocab.txt` + `vocos/`；或设 `F5_HOME` |
| Python 3.12（torch、f5-tts） | 设 `PY312` 指向解释器 |
| Python 3.13（faster-whisper、pypinyin） | 设 `PY313` 指向解释器 |

FFmpeg 已随包带在 `runtime/`，不用管。

**验证是否齐了**：登录后打开网页，音色下拉里如果克隆音色那组标着「需装 F5」，说明缺东西，把鼠标停在选项上能看到缺什么。也可以命令行查：

```bash
node connector/skills/voice-clone-dub/scripts/dub.mjs --doctor
```

## 新增一个克隆音色

音色档案存在两个地方，按顺序找：`<数据目录>/voices/<key>/`，然后 `~/.workbuddy/voices/<key>/`。一个档案包含：

```
ref.wav      12 秒干净人声（音色来源）
ref.txt      这段人声说的话（必须是逐字准确的文本）
bgm.mp3      从原片分离出的伴奏
meta.json    名称、来源链接、时长、refTextVerified
```

最省事的建法是用配音技能跑一次（会自动取片、分离、挑参考段、转写，并存成档案）：

```bash
node connector/skills/voice-clone-dub/scripts/dub.mjs "https://v.douyin.com/xxxx/" 文案.txt --speed 1.2
```

跑完刷新网页，克隆音色那组就多一项。`ref.txt` 建议听一遍再手工改准，转写草稿的同音字会毁音色。

## 附：旧的后台助手方式（可选，一般不用）

如果这台机器装不了 F5 / Python，可以让 WorkBuddy 代跑配音：网页点「生成配音与 BGM」派单，WorkBuddy 那边领单出声再回填。这条路要配 MCP 令牌，且网站和 WorkBuddy 必须在同一台电脑。

- `wait_audio_request({request_id, wait_seconds:0})`：按任务号领取，返回 request 和 claim_token
- `finish_audio_request({request_id, claim_token, note})`：报进度
- `finish_audio_request({request_id, claim_token, vo_file, bgm_file})`：回填真实音频
- `finish_audio_request({request_id, claim_token, error})`：回报失败

音频回填后网页自动继续渲染。这条路的代码还在（`server/audio-requests.mjs`、`server/mcp.mjs`），不配也不影响本地渲染。

## 已实测

| 项 | 结果 |
|---|---|
| 本地克隆出片 | 36 字 / 1 段 / 4.83 秒成片 / 1080×1920 / 6.7MB，全程未连 WorkBuddy |
| 274 字整片克隆 | 5 段质检 1.00/1.00 · 1.00/1.00 · 0.96/1.00 · 0.98/1.00 · 1.00/1.00 全部达标，35.41 秒 |
| 系统音色 edge-tts | 单句 20 字 2.05 秒 |
