# Luma Gesture

## 启动

```bash
npm install
npm start
```

浏览器打开：

```text
http://127.0.0.1:8787
```

同一 Wi-Fi 下要用手机访问时，用局域网监听启动：

```bash
HOST=0.0.0.0 npm start
```

然后在手机打开 `http://你的电脑局域网IP:8787`。不要把这个服务暴露到公网，避免别人消耗你的 DashScope Key。

点击底部 `开始` 后，浏览器会请求麦克风权限。授权后页面会把麦克风 PCM 音频发到本地 Node 服务，由服务端转发给 DashScope Realtime，模型返回的 PCM 音频会在网页里直接播放。

## 透明桌面模式

```bash
npm run desktop
```

桌面模式会打开一个透明、无边框、置顶的 Electron 窗口，直接覆盖在桌面上显示粒子和语音 UI，不需要浏览器窗口。普通浏览器版本不受影响。默认不拦截鼠标点击，所以不会挡住桌面。

快捷键：

- `Cmd/Ctrl + Shift + T`：切换交互模式。打开后可点击语音、形态、关闭按钮；再按一次恢复不挡桌面。
- `Cmd/Ctrl + Shift + H`：启动手势识别。
- `Cmd/Ctrl + Shift + Q`：退出桌面模式。

进入交互模式后，顶部 18px 透明区域可拖动窗口。

## 生成科幻女机器人音色

```bash
npm run create:voice
```

脚本会保存：

- `scifi-yujie-robot-preview.wav`：声音设计预览音频
- `generated-voice.json`：当前网页使用的 Omni Realtime 音色 ID

生成后重启 `npm start`，网页会自动使用 `generated-voice.json` 里的音色。

## 混合 Agent 模式

网页端仍然使用 DashScope Realtime 处理麦克风、打断、语音输出和自定义音色。普通聊天由 Realtime 直接回答，避免无谓延迟。需要工具时，服务端按三档路由：

- `fast`：普通工具问答，关闭思考，不挂工具。
- `search`：最新、今天、现在、联网搜索，只挂 `web_search`。
- `deep`：网页抽取、代码执行、准确计算、复杂分析和长任务，使用 Max 与完整工具。

默认快 Agent 模型：

```text
qwen3.7-plus
```

默认搜索模型：

```text
qwen3.6-flash
```

深度任务模型：

```text
qwen3.7-max-2026-06-08
```

可通过环境变量覆盖：

```bash
DASHSCOPE_AGENT_MODEL=qwen3.7-max npm start
DASHSCOPE_AGENT_SEARCH_MODEL=qwen3.6-flash npm start
DASHSCOPE_AGENT_DEEP_MODEL=qwen3.7-max-2026-06-08 npm start
```

本地测试 Agent：

```bash
curl -X POST http://127.0.0.1:8787/agent \
  -H 'Content-Type: application/json' \
  -d '{"query":"用一句话介绍你能做什么"}'
```

测试搜索模式：

```bash
curl -X POST http://127.0.0.1:8787/agent \
  -H 'Content-Type: application/json' \
  -d '{"query":"查一下今天人工智能行业有什么重要新闻，用一句话回答","mode":"search"}'
```

测试深度模式：

```bash
curl -X POST http://127.0.0.1:8787/agent \
  -H 'Content-Type: application/json' \
  -d '{"query":"分析一下实时语音 Agent 架构怎么降低延迟","mode":"deep"}'
```

## Key 来源

服务端会优先读取：

1. `DASHSCOPE_API_KEY`
2. `ALIYUN_DASHSCOPE_API_KEY`

可以在项目根目录创建本地 `.env`：

```bash
DASHSCOPE_API_KEY=你的DashScopeKey
```

`.env` 已被 `.gitignore` 排除，不会提交到仓库。key 不会写入前端 HTML。
