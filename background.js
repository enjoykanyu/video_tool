const API_CONFIG = {
  providers: {
    bailian: {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.8-flash',
      maxTokens: 6000,
    },
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      maxTokens: 4000,
    },
  },
  defaultProvider: 'bailian',
};


const BILI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Referer': 'https://www.bilibili.com/',
};

async function biliGet(url) {
  const response = await fetch(url, { credentials: 'include', headers: BILI_HEADERS });
  if (!response.ok) throw new Error(`请求失败 HTTP ${response.status}: ${url}`);
  return response.json();
}

function pickSubtitleTrack(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return list.find(item => /^en(?:[-_]|$)/i.test(item.lan || '') || /英文|英语|English/i.test(item.lan_doc || '')) || null;
}

async function fetchSubtitlesForVideo({ bvid, page }) {
  return await fetchOnlineSubtitles(bvid, page) || {
    subtitles: [],
    hint: '当前登录态未返回英文 CC 轨道。请确认播放器字幕菜单中确有英文轨道，并保持 B 站登录。',
  };
}

function normalizeSubtitleBody(data) {
  const body = Array.isArray(data?.body) ? data.body : Array.isArray(data?.data?.body) ? data.data.body : [];
  return body.filter(item => typeof item.content === 'string' && Number.isFinite(Number(item.from)) && Number.isFinite(Number(item.to)))
    .map(item => ({ from: Number(item.from), to: Number(item.to), content: item.content.trim() }))
    .filter(item => item.content && item.to >= item.from);
}

function isEnglishSubtitle(subtitles) {
  const sample = subtitles.slice(0, 120).map(item => item.content).join(' ');
  const latin = (sample.match(/[A-Za-z]/g) || []).length;
  const cjk = (sample.match(/[\u3400-\u9fff]/g) || []).length;
  return latin >= 20 && latin > cjk * 2;
}

async function fetchLoadedSubtitleCandidates(urls, duration) {
  const allowed = /^(?:[^.]+\.)*(?:hdslb\.com|bilibili\.com)$/i;
  const expectedDuration = Number(duration || 0);
  for (const value of Array.isArray(urls) ? urls.slice(0, 20) : []) {
    let url;
    try { url = new URL(value); } catch (_) { continue; }
    if (url.protocol !== 'https:' || !allowed.test(url.hostname)) continue;
    try {
      const data = await biliGet(url.href);
      const subtitles = normalizeSubtitleBody(data);
      if (!subtitles.length || !isEnglishSubtitle(subtitles)) continue;
      const end = subtitles.at(-1).to;
      // Full subtitle files normally end near the video duration; this rejects stale SPA resources.
      if (expectedDuration && (end > expectedDuration + 120 || end < expectedDuration * 0.65)) continue;
      return { subtitles, source: 'player-resource', resourceUrl: url.href };
    } catch (_) {}
  }
  return null;
}

async function fetchOnlineSubtitles(bvid, page) {
  const view = await biliGet(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
  if (view.code !== 0) throw new Error(`视频信息接口错误: ${view.message || view.code}`);

  const pages = view.data?.pages || [];
  const targetPage = pages.find(item => Number(item.page) === Number(page));
  const aid = view.data?.aid;
  const cid = targetPage?.cid;
  if (!aid || !cid) throw new Error('无法解析视频的 aid/cid');

  const urls = [
    `https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${cid}&bvid=${encodeURIComponent(bvid)}`,
    `https://api.bilibili.com/x/player/wbi/v2?aid=${aid}&cid=${cid}&bvid=${encodeURIComponent(bvid)}`,
  ];
  let tracks = [];
  for (const url of urls) {
    const player = await biliGet(url);
    if (player.code === 0) tracks = player.data?.subtitle?.subtitles || [];
    if (tracks.length) break;
  }
  if (!tracks.length) return null;

  const track = pickSubtitleTrack(tracks);
  if (!track) return null;
  const rawUrl = track.subtitle_url || track.subtitleUrl || track.url || '';
  const subtitleUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : rawUrl.startsWith('//') ? `https:${rawUrl}` : '';
  if (!subtitleUrl) throw new Error('英文轨道存在，但字幕下载地址为空');
  const subtitleData = await biliGet(subtitleUrl);
  const subtitles = normalizeSubtitleBody(subtitleData);
  if (!subtitles.length) return null;

  return {
    subtitles,
    title: view.data?.title || '',
    lan: track.lan,
    lanDoc: track.lan_doc,
    direction: 'en2zh',
    aid,
    cid,
    page: Number(targetPage.page),
    duration: Number(targetPage.duration || 0),
    part: targetPage.part || '',
    source: 'online',
    tracks: tracks.map(item => ({ lan: item.lan, lan_doc: item.lan_doc })),
  };
}

async function getConfig(overrides = {}) {
  const keys = ['apiKey', 'asrApiKey', 'baseUrl', 'asrBaseUrl', 'provider', 'model', 'asrModel', 'prompt'];
  const result = await chrome.storage.local.get(keys);
  const provider = overrides.provider || result.provider || API_CONFIG.defaultProvider;
  const providerConfig = API_CONFIG.providers[provider] || API_CONFIG.providers.openai;

  return {
    apiKey: (overrides.apiKey !== undefined ? overrides.apiKey : (result.apiKey || '')).trim(),
    asrApiKey: (overrides.asrApiKey !== undefined ? overrides.asrApiKey : (result.asrApiKey || result.apiKey || '')).trim(),
    baseUrl: normalizeBaseUrl(overrides.baseUrl !== undefined ? overrides.baseUrl : (result.baseUrl || providerConfig.baseUrl)),
    asrBaseUrl: normalizeBaseUrl(overrides.asrBaseUrl !== undefined ? overrides.asrBaseUrl : (result.asrBaseUrl || result.baseUrl || providerConfig.baseUrl)),
    provider,
    model: ((overrides.model !== undefined ? overrides.model : '') || result.model || providerConfig.model).trim(),
    // qwen3-asr-flash is the current OpenAI-compatible ASR endpoint.
    asrModel: ((overrides.asrModel !== undefined ? overrides.asrModel : '') || (result.asrModel && !/^qwen(?:3-asr-flash|audio-3\.0-asr-flash)$/i.test(result.asrModel) ? result.asrModel : 'qwen-audio-3.1-asr-flash-filetrans')).trim(),
    prompt: overrides.prompt || result.prompt || getDefaultPrompt(),
  };
}

function normalizeBaseUrl(value) {
  return value.trim().replace(/\/+$/, '');
}

function getDefaultPrompt() {
  return `你是一位专业的视频字幕翻译专家。请根据以下要求翻译：

1. 利用全文语境确保翻译连贯准确
2. 保持与输入完全相同的顺序、from、to 和 content
3. 风格口语化、自然流畅
4. 只输出 JSON 数组，不要 Markdown、解释或额外字段

全文语境参考：
{fullContext}

请翻译以下字幕：
{subtitlesJson}

输出格式：
[
  {"from": 0.5, "to": 3.2, "content": "原文", "translation": "译文"},
  ...
]`;
}

function directionInstruction(direction) {
  return direction === 'zh2en'
    ? '请将每条的 content（中文）翻译为英文，写入 translation 字段。'
    : '请将每条的 content（英文）翻译为简体中文，写入 translation 字段。';
}

async function translateWithAI(subtitles, fullContext, direction, config) {
  if (!config.apiKey) throw new Error('未配置 API Key，请点击扩展图标在设置中填写');
  if (!config.baseUrl) throw new Error('未配置 Base URL，请在扩展设置中填写');
  if (!Array.isArray(subtitles) || subtitles.length === 0) return [];

  const batchSize = 40;
  const translations = [];

  for (let start = 0; start < subtitles.length; start += batchSize) {
    const batch = subtitles.slice(start, start + batchSize);
    // Supply adjacent context for every batch, including the end of long videos.
    const context = String(fullContext || subtitles.map(item => item.content).join(' ')).slice(0, 12000);
    const translated = await translateBatch(batch, context, direction, config);
    if (translated.length !== batch.length || translated.some(item => !item || typeof item.translation !== 'string')) {
      throw new Error(`模型返回数量或格式不正确（第 ${start + 1} 条起）`);
    }
    translations.push(...translated);
  }

  if (translations.length !== subtitles.length) {
    throw new Error(`模型返回数量不匹配：期望 ${subtitles.length} 条，实际 ${translations.length} 条`);
  }

  return subtitles.map((subtitle, index) => ({
    from: Number(subtitle.from),
    to: Number(subtitle.to),
    content: subtitle.content,
    translation: translations[index]?.translation || subtitle.content,
  }));
}

async function translateBatch(batch, fullContext, direction, config) {
  const subtitlesJson = JSON.stringify(batch.map(({ from, to, content }) => ({ from, to, content })));
  const finalPrompt = config.prompt
    .replace('{fullContext}', fullContext)
    .replace('{subtitlesJson}', subtitlesJson);

  const data = await callOpenAICompatible(`${finalPrompt}\n\n${directionInstruction(direction)}`, config);
  return normalizeTranslations(parseModelJson(data), batch);
}

async function callOpenAICompatible(prompt, config) {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: 'system',
          content: 'You are a professional subtitle translator. Output pure JSON only.',
        },
        { role: 'user', content: `${prompt}\n\n请只输出纯 JSON 数组。` },
      ],
      temperature: 0.2,
      max_tokens: API_CONFIG.providers[config.provider]?.maxTokens || 6000,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`API错误 ${response.status}: ${error.error?.message || response.statusText}`);
  }

  const data = await response.json();
  const rawContent = data.choices?.[0]?.message?.content;
  const content = Array.isArray(rawContent) ? rawContent.map(item => item.text || '').join('') : rawContent;
  if (!content) throw new Error('API 返回空内容');
  return content;
}

async function cropScreenshot(dataUrl, crop, viewport) {
  if (!crop || !viewport?.width || !viewport?.height) return dataUrl;
  const response = await fetch(dataUrl);
  const bitmap = await createImageBitmap(await response.blob());
  const scaleX = bitmap.width / Number(viewport.width), scaleY = bitmap.height / Number(viewport.height);
  const sx = Math.max(0, Math.round(Number(crop.x) * scaleX)), sy = Math.max(0, Math.round(Number(crop.y) * scaleY));
  const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(Number(crop.width) * scaleX)));
  const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(Number(crop.height) * scaleY)));
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh); bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' }), bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return `data:image/png;base64,${btoa(binary)}`;
}

async function ocrSubtitleFrame(timestamp, sender, crop, viewport) {
  const config = await getConfig();
  if (!config.apiKey) throw new Error('未配置翻译 API Key，请在扩展设置中填写');
  if (!sender?.tab?.windowId) throw new Error('无法定位当前视频标签页');
  const screenshot = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
  const image = await cropScreenshot(screenshot, crop, viewport);
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: 'You are a subtitle OCR engine. Output pure JSON only.' },
        { role: 'user', content: [
          { type: 'text', text: `识别这块已经裁剪好的字幕区域。只返回 JSON，不要解释：{"english":"英文字幕原文，没有则为空","chinese":"对应的简体中文，没有则为空"}。不要猜测图片外的文字；如果没有清晰字幕就返回空字符串。当前视频时间约 ${Number(timestamp || 0).toFixed(1)} 秒。` },
          { type: 'image_url', image_url: { url: image } },
        ] },
      ],
      temperature: 0,
      max_tokens: 500,
    }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`OCR API错误 ${response.status}: ${error.error?.message || response.statusText}`);
  }
  const data = await response.json();
  const rawContent = data.choices?.[0]?.message?.content;
  const content = Array.isArray(rawContent) ? rawContent.map(item => item.text || '').join('') : rawContent;
  if (!content) throw new Error('OCR 返回空内容，请确认模型支持图片输入');
  const parsed = parseModelJson(content);
  return { english: parsed?.english || '', chinese: parsed?.chinese || '' };
}

async function transcribeAudio(audio, config) {
  if (!config.asrApiKey) throw new Error('未配置语音 API Key，请在扩展设置中填写');
  if (!config.asrBaseUrl) throw new Error('未配置语音识别 URL，请在扩展设置中填写');
  if (/filetrans$/i.test(config.asrModel)) {
    return transcribeAudioWithFiletrans(audio, config);
  }
  if (/^qwen3-asr-flash(?:-[a-z0-9-]+)?$/i.test(config.asrModel)) {
    return transcribeAudioWithQwen3Compatible(audio, config);
  }
  if (/qwen-audio-3\.0-asr-flash/i.test(config.asrModel)) {
    if (!/maas\.aliyuncs\.com|dashscope\.aliyuncs\.com/i.test(config.asrBaseUrl)) {
      throw new Error(`语音识别 URL 不支持 Qwen ASR：${config.asrBaseUrl}。请在“语音识别 URL”中填写 env.md 的百炼工作区地址`);
    }
    return transcribeAudioWithQwen(audio, config);
  }
  if (/maas\.aliyuncs\.com|dashscope\.aliyuncs\.com/i.test(config.asrBaseUrl)) return transcribeAudioWithQwen(audio, config);
  const model = config.asrModel || (config.provider === 'openai' ? 'whisper-1' : 'qwen-audio-turbo');
  const bytes = await audioBytes(audio);
  assertWav(bytes);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'video-audio.wav');
  form.append('model', model); form.append('language', 'en'); form.append('response_format', 'verbose_json');
  const response = await fetch(`${config.asrBaseUrl}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${config.asrApiKey}` }, body: form });
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(`语音识别 API错误 ${response.status}: ${error.error?.message || response.statusText}`); }
  const data = await response.json();
  const segments = Array.isArray(data.segments) ? data.segments : [];
  if (!segments.length) throw new Error('语音识别没有返回带时间轴的英文片段');
  return segments.map(item => ({ from: Number(item.start), to: Number(item.end), content: String(item.text || '').trim(), translation: '' })).filter(item => item.content && item.to > item.from);
}

function qwenFiletransSubmitUrl(baseUrl) {
  const url = new URL(baseUrl);
  return `${url.origin}/api/v1/services/audio/asr/transcription`;
}

function qwenTaskUrl(baseUrl, taskId) {
  const url = new URL(baseUrl);
  return `${url.origin}/api/v1/tasks/${encodeURIComponent(taskId)}`;
}

async function dashScopeError(response, prefix) {
  const text = await response.text().catch(() => '');
  let message = '';
  try { const data = text ? JSON.parse(text) : {}; message = data.message || data.error?.message || data.code || ''; } catch (_) {}
  return `${prefix} ${response.status}${message ? `：${message}` : text ? `：${text.slice(0, 240)}` : ''}`;
}

async function transcribeAudioWithFiletrans(audio, config) {
  const bytes = await audioBytes(audio);
  assertWav(bytes);
  const model = config.asrModel;
  const policyResponse = await fetch(`https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${config.asrApiKey}`, 'Content-Type': 'application/json' },
  });
  if (!policyResponse.ok) throw new Error(await dashScopeError(policyResponse, '百炼文件上传凭证错误'));
  const policy = (await policyResponse.json()).data;
  if (!policy?.upload_host || !policy?.upload_dir) throw new Error('百炼没有返回文件上传凭证');
  const fileName = `subtitle-${Date.now()}.wav`, key = `${policy.upload_dir}/${fileName}`;
  const form = new FormData();
  for (const [name, value] of Object.entries({ OSSAccessKeyId: policy.oss_access_key_id, Signature: policy.signature, policy: policy.policy, 'x-oss-object-acl': policy.x_oss_object_acl, 'x-oss-forbid-overwrite': policy.x_oss_forbid_overwrite, key, success_action_status: '200' })) form.append(name, value);
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), fileName);
  const uploadResponse = await fetch(policy.upload_host, { method: 'POST', body: form });
  if (!uploadResponse.ok) throw new Error(await dashScopeError(uploadResponse, '百炼音频上传错误'));
  const fileUrl = `oss://${key}`;
  const submitResponse = await fetch(qwenFiletransSubmitUrl(config.asrBaseUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.asrApiKey}`, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable', 'X-DashScope-OssResourceResolve': 'enable' },
    body: JSON.stringify({ model, input: { file_urls: [fileUrl] }, parameters: { channel_id: [0], language_hints: ['en'] } }),
  });
  if (!submitResponse.ok) throw new Error(await dashScopeError(submitResponse, '百炼文件转写提交错误'));
  const submitted = await submitResponse.json(), taskId = submitted.output?.task_id;
  if (!taskId) throw new Error('百炼文件转写没有返回任务 ID');
  let result;
  for (let attempt = 0; attempt < 90; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const pollResponse = await fetch(qwenTaskUrl(config.asrBaseUrl, taskId), { headers: { Authorization: `Bearer ${config.asrApiKey}`, 'X-DashScope-OssResourceResolve': 'enable' } });
    if (!pollResponse.ok) throw new Error(await dashScopeError(pollResponse, '百炼文件转写查询错误'));
    result = await pollResponse.json();
    const status = result.output?.task_status || result.task_status;
    if (status === 'SUCCEEDED' || status === 'FAILED') break;
  }
  const status = result?.output?.task_status || result?.task_status;
  if (status !== 'SUCCEEDED') throw new Error(result?.output?.message || result?.message || `百炼文件转写失败（${status || '超时'}）`);
  const transcriptionUrl = result.output?.results?.[0]?.transcription_url || result.output?.transcription_url;
  if (!transcriptionUrl) throw new Error('百炼文件转写完成但没有结果地址');
  const transcriptionResponse = await fetch(transcriptionUrl);
  if (!transcriptionResponse.ok) throw new Error('无法下载百炼文件转写结果');
  const transcription = await transcriptionResponse.json();
  const sentences = (transcription.transcripts || []).flatMap(item => item.sentences || []);
  return sentences.map(item => ({ from: Number(item.begin_time) / 1000, to: Number(item.end_time) / 1000, content: String(item.text || '').trim(), translation: '' })).filter(item => item.content && item.to > item.from);
}

async function audioBytes(audio) {
  if (typeof audio === 'string') {
    const encoded = audio.includes(',') ? audio.slice(audio.indexOf(',') + 1) : audio;
    try {
      const binary = atob(encoded), bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      return bytes;
    } catch (_) {
      throw new Error('音频 Base64 数据损坏，请刷新 B 站页面后重试');
    }
  }
  if (audio instanceof Blob) return new Uint8Array(await audio.arrayBuffer());
  if (audio instanceof ArrayBuffer) return new Uint8Array(audio);
  if (ArrayBuffer.isView(audio)) return new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
  // Keep compatibility with runtimes that serialize a byte array as {type,data}.
  if (audio && audio.type === 'Buffer' && Array.isArray(audio.data)) return Uint8Array.from(audio.data);
  if (Array.isArray(audio)) return Uint8Array.from(audio);
  throw new Error('音频数据未正确传到后台，请刷新 B 站页面后重试');
}

function assertWav(bytes) {
  const header = String.fromCharCode(...bytes.subarray(0, 12));
  if (bytes.byteLength < 44 || !header.startsWith('RIFF') || header.slice(8, 12) !== 'WAVE') {
    throw new Error('生成的音频不是有效 WAV，请刷新 B 站页面后重试');
  }
}

function qwenNativeUrl(baseUrl) {
  const url = new URL(baseUrl);
  return `${url.origin}/api/v1/services/aigc/multimodal-generation/generation`;
}

function qwenCompatibleUrl(baseUrl) {
  const url = new URL(baseUrl);
  return `${url.origin}/compatible-mode/v1/chat/completions`;
}

async function responseError(response, prefix) {
  const text = await response.text().catch(() => '');
  let message = '';
  try {
    const data = text ? JSON.parse(text) : {};
    message = data.error?.message || data.message || data.code || '';
  } catch (_) {}
  if (!message && text && text !== '{}') message = text.slice(0, 240);
  return `${prefix} ${response.status}${message ? `：${message}` : '（服务端未返回详细错误；请检查模型、URL 和语音 Key）'}`;
}

async function transcribeAudioWithQwen3Compatible(audio, config) {
  const bytes = await audioBytes(audio);
  assertWav(bytes);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  const response = await fetch(qwenCompatibleUrl(config.asrBaseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.asrApiKey}` },
    body: JSON.stringify({
      model: config.asrModel,
      messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${btoa(binary)}` } }] }],
      stream: false,
      asr_options: { language: 'en', enable_itn: false },
    }),
  });
  if (!response.ok) throw new Error(await responseError(response, '百炼 Qwen3 ASR API 错误'));
  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;
  const content = Array.isArray(raw) ? raw.map(item => item.text || '').join('') : raw;
  if (!content || !String(content).trim()) throw new Error('百炼 Qwen3 ASR 返回空内容');
  return timedSegments(String(content).trim(), Number(config.segmentDuration || 10));
}

function timedSegments(text, duration) {
  const parts = String(text || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  if (!parts.length) return [];
  const total = parts.reduce((sum, part) => sum + part.length, 0) || 1;
  let cursor = 0;
  return parts.map((content, index) => {
    const from = cursor;
    cursor += Number(duration || 0) * content.length / total;
    return { from, to: index === parts.length - 1 ? Number(duration || 0) : cursor, content, translation: '' };
  }).filter(item => item.to > item.from);
}

async function transcribeAudioWithQwen(audio, config) {
  const bytes = await audioBytes(audio);
  assertWav(bytes);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  const response = await fetch(qwenNativeUrl(config.asrBaseUrl), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.asrApiKey}`, 'X-DashScope-SSE': 'disable' },
    body: JSON.stringify({
      model: config.asrModel || 'qwen-audio-3.0-asr-flash',
      input: { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${btoa(binary)}` } }] }] },
      parameters: { format: 'wav', sample_rate: '16000', language_hints: ['en'] },
    }),
  });
  if (!response.ok) throw new Error(await responseError(response, '百炼 Qwen-Audio ASR API 错误'));
  const data = await response.json();
  const raw = data.output?.choices?.[0]?.message?.content || data.choices?.[0]?.message?.content;
  const content = Array.isArray(raw) ? raw.map(item => item.text || '').join('') : raw;
  if (!content) throw new Error('百炼语音识别返回空内容');
  let parsed = null;
  try { parsed = parseModelJson(content); } catch (_) {}
  const segments = Array.isArray(parsed) ? parsed : parsed?.segments;
  if (Array.isArray(segments)) return segments.map(item => ({ from: Number(item.from ?? item.start), to: Number(item.to ?? item.end), content: String(item.content || item.text || '').trim(), translation: '' })).filter(item => item.content && Number.isFinite(item.from) && Number.isFinite(item.to) && item.to > item.from);
  return timedSegments(content, Number(config.segmentDuration || 10));
}

function parseModelJson(content) {
  const cleaned = String(content)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('翻译结果不是有效 JSON');
  }
}

function normalizeTranslations(result, batch) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.subtitles)) return result.subtitles;
  if (Array.isArray(result?.translations)) return result.translations;
  if (Array.isArray(result?.data)) return result.data;
  throw new Error(`模型未返回字幕数组（收到 ${batch.length} 条请求）`);
}

async function testConnection(config) {
  const data = await callOpenAICompatible('只回复 OK', config);
  if (!String(data).includes('OK')) throw new Error('接口已连接，但返回内容异常');
  return true;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    try {
      if (request.action === 'fetchSubtitles') {
        sendResponse({ success: true, ...(await fetchSubtitlesForVideo(request)) });
      } else if (request.action === 'fetchLoadedSubtitleCandidates') {
        const result = await fetchLoadedSubtitleCandidates(request.urls, request.duration);
        sendResponse({ success: true, ...(result || { subtitles: [] }) });
      } else if (request.action === 'translateSubtitles') {
        const config = await getConfig();
        const translations = await translateWithAI(
          request.subtitles, request.fullContext, request.direction || 'en2zh', config
        );
        sendResponse({ success: true, translations });
      } else if (request.action === 'getConfig') {
        sendResponse({ success: true, config: await getConfig() });
      } else if (request.action === 'saveConfig') {
        await chrome.storage.local.set(request.config);
        sendResponse({ success: true });
      } else if (request.action === 'testConnection') {
        sendResponse({ success: await testConnection(await getConfig(request.config || {})) });
      } else if (request.action === 'ocrSubtitleFrame') {
        sendResponse({ success: true, ...(await ocrSubtitleFrame(request.timestamp, sender, request.crop, request.viewport)) });
      } else if (request.action === 'transcribeAudio') {
        const config = await getConfig();
        config.segmentDuration = Number(request.duration || 10);
        sendResponse({ success: true, subtitles: await transcribeAudio(request.audioBase64 || request.audio, config) });
      }
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
  })();
  return true;
});
