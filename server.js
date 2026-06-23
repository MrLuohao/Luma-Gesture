const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { WebSocketServer, WebSocket } = require("ws");
const { loadLocalEnv } = require("./local-env");

const rootDir = __dirname;
loadLocalEnv(rootDir);

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const model = process.env.DASHSCOPE_REALTIME_MODEL || "qwen3.5-omni-plus-realtime";
const dashScopeUrl = `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(model)}`;
const agentUrl = process.env.DASHSCOPE_RESPONSES_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1/responses";
const agentModel = process.env.DASHSCOPE_AGENT_MODEL || process.env.DASHSCOPE_AGENT_FAST_MODEL || "qwen3.7-plus";
const searchAgentModel = process.env.DASHSCOPE_AGENT_SEARCH_MODEL || "qwen3.6-flash";
const deepAgentModel = process.env.DASHSCOPE_AGENT_DEEP_MODEL || "qwen3.7-max-2026-06-08";
const agentFallbackModels = (process.env.DASHSCOPE_AGENT_FALLBACK_MODELS || "qwen3.6-flash")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const agentReasoningEffort = process.env.DASHSCOPE_AGENT_REASONING || "low";
const generatedVoicePath = path.join(rootDir, "generated-voice.json");

const realtimeInstructions = [
  "你是实时语音主模型。默认直接用自然、简洁、清晰的中文回答。",
  "不要为了寒暄、身份介绍、常识解释、简单闲聊、短创意表达调用 ask_agent。",
  "只有用户明确要求查找、联网、最新、今天、现在、读取网页、写代码、运行计算、复杂分析、深度方案或多步骤任务时，才调用 ask_agent。",
  "调用 ask_agent 时，最新/今天/现在/联网搜索使用 search；网页抽取、代码执行、准确计算、复杂分析和长任务使用 deep；其他工具问答使用 fast。",
  "如果不确定是否需要工具，先直接回答，不调用工具。",
  "拿到工具结果后，用适合朗读的中文总结给用户。回答要短，不要啰嗦。",
  "只输出干净的人声回复，不要背景音乐、环境声、音效、哼唱或拖长语气。"
].join("\n");

const agentInstructions = [
  "你是运行在语音网页背后的通用 Agent。",
  "使用简洁、直接、准确的中文回答。优先给结论，再给必要依据或步骤。",
  "可以使用联网搜索、网页抽取和代码解释器处理需要实时信息、计算、代码、资料整理或多步骤推理的任务。",
  "输出会被语音模型朗读，因此避免长表格、长代码和大段引用；必要时压缩为要点。",
  "如果信息不确定，明确说明不确定点，不要编造。"
].join("\n");

const agentTools = [
  { type: "web_search" },
  { type: "web_extractor" },
  { type: "code_interpreter" }
];

const searchAgentTools = [
  { type: "web_search" }
];

function normalizeAgentMode(mode) {
  if (mode === "search" || mode === "deep") return mode;
  return "fast";
}

function toolsForAgentMode(mode) {
  if (mode === "deep") return agentTools;
  if (mode === "search") return searchAgentTools;
  return [];
}

function reasoningEffortForMode(mode) {
  if (mode === "deep") return agentReasoningEffort;
  if (mode === "search") return "minimal";
  return "none";
}

function resolveDashScopeApiKey() {
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY;
  if (process.env.ALIYUN_DASHSCOPE_API_KEY) return process.env.ALIYUN_DASHSCOPE_API_KEY;
  return "";
}

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function respondJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("请求体过大。"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("请求体不是合法 JSON。"));
      }
    });

    req.on("error", reject);
  });
}

function extractAgentText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return sanitizeAgentText(payload.output_text);
  }

  const chunks = [];
  for (const item of payload.output || []) {
    if (!Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }
  return sanitizeAgentText(chunks.join(""));
}

function sanitizeAgentText(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function shouldTryFallback(error) {
  const status = Number(error.status || 0);
  if (status === 400 || status === 404 || status === 422) return true;
  const message = String(error.message || "").toLowerCase();
  return message.includes("model") && (message.includes("not") || message.includes("unsupported") || message.includes("invalid"));
}

function agentModelCandidates(mode = "fast") {
  const normalizedMode = normalizeAgentMode(mode);
  const primary = normalizedMode === "deep" ? deepAgentModel : normalizedMode === "search" ? searchAgentModel : agentModel;
  const secondary = normalizedMode === "deep" ? agentModel : deepAgentModel;
  return [primary, ...agentFallbackModels, secondary].filter((item, index, list) => item && list.indexOf(item) === index);
}

async function postAgentRequest(apiKey, modelName, query, previousResponseId, mode = "fast") {
  const normalizedMode = normalizeAgentMode(mode);
  const body = {
    model: modelName,
    input: query,
    instructions: agentInstructions,
    tools: toolsForAgentMode(normalizedMode),
    reasoning: {
      effort: reasoningEffortForMode(normalizedMode)
    },
    enable_thinking: normalizedMode !== "fast"
  };

  if (previousResponseId) {
    body.previous_response_id = previousResponseId;
  }

  const response = await fetch(agentUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "x-dashscope-session-cache": "enable"
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error?.message || payload.message || response.statusText || "Agent 请求失败。";
    const error = new Error(detail);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  const text = extractAgentText(payload);
  if (!text) {
    const error = new Error("Agent 没有返回可朗读文本。");
    error.status = 502;
    error.payload = payload;
    throw error;
  }

  return {
    model: modelName,
    text,
    responseId: payload.id || null,
    usage: payload.usage || null
  };
}

async function callAgent(apiKey, query, previousResponseId = null, mode = "fast") {
  const text = String(query || "").trim();
  if (!text) {
    throw new Error("Agent 查询内容为空。");
  }

  const normalizedMode = normalizeAgentMode(mode);
  const models = agentModelCandidates(normalizedMode);
  let lastError = null;

  for (const modelName of models) {
    try {
      return await postAgentRequest(apiKey, modelName, text, previousResponseId, normalizedMode);
    } catch (error) {
      lastError = error;
      if (!shouldTryFallback(error)) break;
    }
  }

  throw lastError || new Error("Agent 调用失败。");
}

function resolveRealtimeVoice() {
  if (process.env.DASHSCOPE_REALTIME_VOICE) return process.env.DASHSCOPE_REALTIME_VOICE;

  try {
    const voiceInfo = JSON.parse(fs.readFileSync(generatedVoicePath, "utf8"));
    if (voiceInfo && typeof voiceInfo.omniRealtimeVoice === "string") {
      return voiceInfo.omniRealtimeVoice;
    }
  } catch {
    // Fall back to the voice used by the reference project.
  }

  return "qwen-omni-vc-huangshang-voice-20260613234954714-e558";
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

  if (url.pathname === "/agent") {
    if (req.method !== "POST") {
      respondJson(res, 405, { error: "Method Not Allowed" });
      return;
    }

    const apiKey = resolveDashScopeApiKey();
    if (!apiKey) {
      respondJson(res, 500, { error: "未找到 DashScope API Key。" });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const result = await callAgent(apiKey, body.query, null, body.mode);
      respondJson(res, 200, result);
    } catch (error) {
      respondJson(res, error.status || 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  const filePath = path.resolve(rootDir, `.${pathname}`);
  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  if (url.pathname !== "/voice") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (clientSocket) => {
    wss.emit("connection", clientSocket, req);
  });
});

wss.on("connection", (clientSocket) => {
  let dashSocket = null;
  let dashReady = false;
  let audioSequence = 0;
  let agentPreviousResponseId = null;

  const closeDash = (reason = "client-close") => {
    const socket = dashSocket;
    dashSocket = null;
    dashReady = false;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close(1000, reason);
    } else if (socket && socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
  };

  const apiKey = resolveDashScopeApiKey();
  if (!apiKey) {
    sendJson(clientSocket, {
      type: "error",
      message: "未找到 DashScope API Key。请设置 DASHSCOPE_API_KEY 或 ALIYUN_DASHSCOPE_API_KEY。"
    });
    clientSocket.close(1011, "missing-api-key");
    return;
  }

  sendJson(clientSocket, { type: "status", status: "connecting", detail: model });

  dashSocket = new WebSocket(dashScopeUrl, {
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  const connectTimeout = setTimeout(() => {
    sendJson(clientSocket, { type: "error", message: "实时语音连接超时。" });
    closeDash("connect-timeout");
  }, 15000);

  dashSocket.on("open", () => {
    sendJson(clientSocket, { type: "status", status: "connected", detail: model });
    dashSocket.send(JSON.stringify({
      event_id: "gesture_field_session_update",
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: resolveRealtimeVoice(),
        input_audio_format: "pcm",
        output_audio_format: "pcm",
        input_audio_transcription: {
          model: "qwen3-asr-flash-realtime"
        },
        instructions: realtimeInstructions,
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 220,
          silence_duration_ms: 480,
          create_response: true,
          interrupt_response: true
        },
        enable_search: false,
        tools: [
          {
            type: "function",
            function: {
              name: "ask_agent",
              description: "仅在用户明确需要联网、最新信息、网页读取、代码、计算、复杂分析或多步骤任务时使用。普通聊天、寒暄、常识解释不要调用。",
              parameters: {
                type: "object",
                properties: {
                  query: {
                    type: "string",
                    description: "用户完整问题或任务，保留关键信息和上下文。"
                  },
                  mode: {
                    type: "string",
                    enum: ["fast", "search", "deep"],
                    description: "fast 用于普通工具问答；search 用于最新、今天、现在、联网搜索；deep 用于网页抽取、代码执行、准确计算、复杂分析、长任务或严肃决策。"
                  }
                },
                required: ["query"]
              }
            }
          }
        ],
        temperature: 0.7,
        max_tokens: 160
      }
    }));
  });

  async function handleAgentToolCall(event) {
    if (event.name !== "ask_agent") return;

    let args = {};
    try {
      args = JSON.parse(String(event.arguments || "{}"));
    } catch {
      args = { query: String(event.arguments || "") };
    }

    const agentMode = normalizeAgentMode(args.mode);
    sendJson(clientSocket, {
      type: "status",
      status: "thinking",
      detail: agentMode === "deep" ? deepAgentModel : agentMode === "search" ? searchAgentModel : agentModel
    });

    let output = "";
    try {
      const result = await callAgent(apiKey, args.query, agentPreviousResponseId, agentMode);
      agentPreviousResponseId = result.responseId || agentPreviousResponseId;
      output = result.text;
      sendJson(clientSocket, {
        type: "status",
        status: "thinking",
        detail: `agent:${result.model}`
      });
    } catch (error) {
      output = `我调用通用 Agent 失败了：${error instanceof Error ? error.message : String(error)}`;
      sendJson(clientSocket, {
        type: "error",
        message: output
      });
    }

    if (dashSocket?.readyState !== WebSocket.OPEN) return;

    dashSocket.send(JSON.stringify({
      event_id: `gesture_field_agent_output_${Date.now()}`,
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: event.call_id,
        output
      }
    }));

    dashSocket.send(JSON.stringify({
      event_id: `gesture_field_agent_response_${Date.now()}`,
      type: "response.create"
    }));
  }

  dashSocket.on("message", (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }

    if (event.type === "session.updated") {
      clearTimeout(connectTimeout);
      dashReady = true;
      sendJson(clientSocket, { type: "status", status: "listening", detail: model });
    }

    if (event.type === "error") {
      sendJson(clientSocket, {
        type: "error",
        message: event.error?.message || "实时语音服务返回错误。",
        detail: event.error
      });
    }

    if (event.type === "response.function_call_arguments.done") {
      void handleAgentToolCall(event);
    }

    sendJson(clientSocket, { type: "server", event });
  });

  dashSocket.on("error", (error) => {
    clearTimeout(connectTimeout);
    sendJson(clientSocket, {
      type: "error",
      message: error instanceof Error ? error.message : String(error)
    });
  });

  dashSocket.on("close", () => {
    clearTimeout(connectTimeout);
    dashReady = false;
    sendJson(clientSocket, { type: "status", status: "idle", detail: "closed" });
  });

  clientSocket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }

    if (message.type === "audio" && typeof message.audio === "string" && dashReady && dashSocket?.readyState === WebSocket.OPEN) {
      dashSocket.send(JSON.stringify({
        event_id: `gesture_field_audio_${Date.now()}_${audioSequence++}`,
        type: "input_audio_buffer.append",
        audio: message.audio
      }));
    }

    if (message.type === "interrupt" && dashSocket?.readyState === WebSocket.OPEN) {
      dashSocket.send(JSON.stringify({
        event_id: `gesture_field_cancel_${Date.now()}`,
        type: "response.cancel"
      }));
      sendJson(clientSocket, { type: "status", status: "listening", detail: "interrupted" });
    }
  });

  clientSocket.on("close", () => closeDash());
  clientSocket.on("error", () => closeDash("client-error"));
});

function startServer(listenHost = host, listenPort = port) {
  if (server.listening) return Promise.resolve(server);

  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const visibleHost = listenHost === "0.0.0.0" ? "127.0.0.1" : listenHost;
      console.log(`Gesture voice demo: http://${visibleHost}:${listenPort}`);
      resolve(server);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(listenPort, listenHost);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  port,
  host,
  server,
  startServer
};
