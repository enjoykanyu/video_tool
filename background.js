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
  const keys = ['apiKey', 'baseUrl', 'provider', 'model', 'prompt'];
  const result = await chrome.storage.local.get(keys);
  const provider = overrides.provider || result.provider || API_CONFIG.defaultProvider;
  const providerConfig = API_CONFIG.providers[provider] || API_CONFIG.providers.openai;

  return {
    apiKey: (overrides.apiKey !== undefined ? overrides.apiKey : (result.apiKey || '')).trim(),
    baseUrl: normalizeBaseUrl(overrides.baseUrl !== undefined ? overrides.baseUrl : (result.baseUrl || providerConfig.baseUrl)),
    provider,
    model: ((overrides.model !== undefined ? overrides.model : '') || result.model || providerConfig.model).trim(),
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
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('API 返回空内容');
  return content;
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
      }
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
  })();
  return true;
});
