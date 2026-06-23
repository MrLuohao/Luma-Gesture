const fs = require("node:fs");
const path = require("node:path");
const { loadLocalEnv } = require("./local-env");

const rootDir = __dirname;
loadLocalEnv(rootDir);

const customizationUrl = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization";
let ttsDesignModel = "qwen3-tts-vd-2026-01-26";
const realtimeTargetModel = process.env.DASHSCOPE_REALTIME_MODEL || "qwen3.5-omni-plus-realtime";
const previewAudioPath = path.join(rootDir, "scifi-yujie-robot-preview.wav");
const voiceInfoPath = path.join(rootDir, "generated-voice.json");

const voicePrompt = [
  "成熟女性声音，30岁左右，低中音，冷静、克制、有磁性。",
  "带轻微科幻女机器人质感，声音干净透明，边缘有细腻电子合成感，但不要机械噪声、不要背景音乐、不要环境声、不要音效。",
  "语速中等偏慢，吐字清晰，情绪稳定，有高级感和距离感，适合作为未来主义语音助手。"
].join("");

const previewText = [
  "你好，我是你的实时语音助手。",
  "我会用简洁、冷静、清晰的方式回应你。",
  "当前系统已经进入待命状态，你可以直接说出你的问题。"
].join("");

function resolveDashScopeApiKey() {
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY;
  if (process.env.ALIYUN_DASHSCOPE_API_KEY) return process.env.ALIYUN_DASHSCOPE_API_KEY;
  return "";
}

async function postJson(url, payload, apiKey) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`请求失败 ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function decodePreviewAudio(previewAudio) {
  const value = previewAudio && typeof previewAudio.data === "string" ? previewAudio.data : "";
  if (!value) return null;
  const base64 = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  return Buffer.from(base64, "base64");
}

async function main() {
  const apiKey = resolveDashScopeApiKey();
  if (!apiKey) {
    throw new Error("未找到 DashScope API Key。请设置 DASHSCOPE_API_KEY 或 ALIYUN_DASHSCOPE_API_KEY。");
  }

  let designProvider = "qwen-voice-design";
  let ttsDesignVoice = "existing-preview-audio";
  let previewAudio = null;

  if (fs.existsSync(previewAudioPath) && process.env.FORCE_VOICE_DESIGN !== "1") {
    console.log(`1/2 复用已有预览音频: ${previewAudioPath}`);
    designProvider = "existing-preview-audio";
    previewAudio = fs.readFileSync(previewAudioPath);
  } else {
    console.log("1/2 创建声音设计音色...");
    let designResult;
    try {
      designResult = await postJson(customizationUrl, {
        model: "qwen-voice-design",
        input: {
          action: "create",
          target_model: ttsDesignModel,
          preferred_name: "scifirobotseed",
          voice_prompt: voicePrompt,
          preview_text: previewText
        },
        parameters: {
          sample_rate: 24000,
          response_format: "wav"
        }
      }, apiKey);
    } catch (error) {
      console.log("Qwen-TTS 声音设计不可用，改用 CosyVoice 声音设计...");
      console.log(error instanceof Error ? error.message : String(error));
      designProvider = "cosyvoice-design";
      ttsDesignModel = "cosyvoice-v3.5-plus";
      designResult = await postJson(customizationUrl, {
        model: "voice-enrollment",
        input: {
          action: "create_voice",
          target_model: ttsDesignModel,
          voice_prompt: voicePrompt,
          preview_text: previewText,
          prefix: "scifirobo"
        },
        parameters: {
          sample_rate: 24000,
          response_format: "wav"
        }
      }, apiKey);
    }

    const output = designResult.output || {};
    ttsDesignVoice = output.voice || output.voice_id || output.voiceID;
    previewAudio = decodePreviewAudio(designResult.output && designResult.output.preview_audio);
    if (!ttsDesignVoice) {
      throw new Error(`声音设计响应缺少 voice 字段: ${JSON.stringify(designResult)}`);
    }
    if (!previewAudio || previewAudio.length < 1024) {
      throw new Error("声音设计响应缺少可用的 preview_audio。");
    }
    fs.writeFileSync(previewAudioPath, previewAudio);
    console.log(`预览音频已保存: ${previewAudioPath}`);
  }

  console.log("2/2 注册为 Qwen-Omni Realtime 可用音色...");
  const enrollmentResult = await postJson(customizationUrl, {
    model: "qwen-voice-enrollment",
    input: {
      action: "create",
      target_model: realtimeTargetModel,
      preferred_name: "scifirobot",
      audio: {
        data: `data:audio/wav;base64,${previewAudio.toString("base64")}`
      }
    }
  }, apiKey);

  const omniRealtimeVoice = enrollmentResult.output && enrollmentResult.output.voice;
  if (!omniRealtimeVoice) {
    throw new Error(`声音注册响应缺少 output.voice: ${JSON.stringify(enrollmentResult)}`);
  }

  const voiceInfo = {
    createdAt: new Date().toISOString(),
    name: "scifi-yujie-robot",
    description: "科幻色彩的成熟女性机器人音色，低中音，冷静克制，轻微电子合成质感。",
    designProvider,
    ttsDesignModel,
    ttsDesignVoice,
    realtimeTargetModel,
    omniRealtimeVoice,
    previewAudioPath: path.basename(previewAudioPath),
    voicePrompt,
    previewText
  };
  fs.writeFileSync(voiceInfoPath, `${JSON.stringify(voiceInfo, null, 2)}\n`);

  console.log(`Omni Realtime 音色已生成并保存: ${voiceInfoPath}`);
  console.log(`voice=${omniRealtimeVoice}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
