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


// ======== B站 WBI 签名工具 (备用字幕API) ========
const mixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 37, 12, 52, 56, 7,
  0, 16, 38, 11, 13, 51, 6, 22, 57, 54, 17, 40, 39, 48, 30, 26,
  34, 20, 24, 4, 1, 25, 44, 55, 41, 59, 36
];

function getMixinKey(orig) {
  let result = '';
  for (let i = 0; i < mixinKeyEncTab.length; i++) {
    result += orig[mixinKeyEncTab[i]] || '';
  }
  return result.slice(0, 32);
}

async function getWbiKeys() {
  const resp = await biliGet('https://api.bilibili.com/x/web-interface/nav');
  const data = resp?.data;
  if (!data?.wbi_img) throw new Error('无法获取 WBI key');
  const imgUrl = data.wbi_img.img_url;
  const subUrl = data.wbi_img.sub_url;
  const imgKey = imgUrl.match(/\/([^/]+)\./)?.[1] || '';
  const subKey = subUrl.match(/\/([^/]+)\./)?.[1] || '';
  return { imgKey, subKey };
}

function encryptWbi(params, imgKey, subKey) {
  const mixinKey = getMixinKey(imgKey + subKey);
  const sorted = Object.keys(params).sort();
  const query = sorted.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  const wts = Math.floor(Date.now() / 1000);
  const signStr = query + mixinKey + wts;
  // Simple hash using SHA-256 via Web Crypto API
  let wRid = '';
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(signStr);
    return crypto.subtle.digest('SHA-256', data).then(hash => {
      const hex = Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      return { wts: String(wts), wRid: hex, query };
    });
  } catch (e) {
    throw new Error('WBI 签名失败: ' + e.message);
  }
}

async function fetchSubtitlesWithWbi(aid, cid, bvid) {
  const keys = await getWbiKeys();
  const signed = await encryptWbi({ aid, cid }, keys.imgKey, keys.subKey);
  const url = `https://api.bilibili.com/x/player/wbi/v2?aid=${aid}&cid=${cid}&wts=${signed.wts}&w_rid=${signed.wRid}`;
  const player = await biliGet(url);
  const tracks = player?.data?.subtitle?.subtitles || [];
  if (!tracks.length) {
    return { subtitles: [], tracks: [], hint: 'WBI 接口也未返回字幕数据' };
  }
  return { tracks };
}


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
  return (
    list.find(item => /^en/i.test(item.lan)) ||
    list.find(item => ['zh-CN', 'zh-Hans'].includes(item.lan)) ||
    list[0]
  );
}

async function fetchSubtitlesForVideo({ bvid, page }) {
  const view = await biliGet(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
  if (view.code !== 0) throw new Error(`视频信息接口错误: ${view.message || view.code}`);

  const pages = view.data?.pages || [];
  const targetPage = pages.find(item => item.page === page) || pages[0];
  const aid = view.data?.aid;
  const cid = targetPage?.cid || view.data?.cid;
  if (!aid || !cid) throw new Error('无法解析视频的 aid/cid');

  const player = await biliGet(
    `https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${cid}&bvid=${encodeURIComponent(bvid)}`
  );
  if (player.code !== 0) throw new Error(`字幕元数据错误: ${player.message || player.code}`);

  const tracks = player.data?.subtitle?.subtitles || [];
  if (!tracks.length) {
    // Fallback: try WBI-signed API
    try {
      const wbiResult = await fetchSubtitlesWithWbi(aid, cid, bvid);
      if (wbiResult.tracks.length) {
        const track = pickSubtitleTrack(wbiResult.tracks);
        if (track && track.subtitle_url) {
          const subtitleUrl = track.subtitle_url.startsWith('http') ? track.subtitle_url : 'https:' + track.subtitle_url;
          const subtitleData = await biliGet(subtitleUrl);
          const subtitles = (subtitleData.body || [])
            .filter(item => typeof item.content === 'string')
            .map(item => ({ from: Number(item.from), to: Number(item.to), content: item.content }));
          if (subtitles.length) {
            const isChinese = /^zh/i.test(track.lan || '');
            return {
              subtitles,
              title: view.data?.title || '',
              lan: track.lan,
              lanDoc: track.lan_doc,
              direction: isChinese ? 'zh2en' : 'en2zh',
              tracks: wbiResult.tracks.map(item => ({ lan: item.lan, lan_doc: item.lan_doc })),
            };
          }
        }
      }
    } catch (wbiErr) {
      console.warn('[B站AI字幕] WBI fallback also failed:', wbiErr.message);
    }
    return {
      subtitles: [],
      tracks: [],
      title: view.data?.title || '',
      hint: '接口返回空字幕列表。B 站 CC/AI 字幕通常需要登录后才能读取，请确认浏览器已登录 B 站账号。',
    };
  }

  const track = pickSubtitleTrack(tracks);
  const subtitleUrl = track.subtitle_url.startsWith('http') ? track.subtitle_url : `https:${track.subtitle_url}`;
  const subtitleData = await biliGet(subtitleUrl);
  const subtitles = (subtitleData.body || [])
    .filter(item => typeof item.content === 'string')
    .map(item => ({ from: Number(item.from), to: Number(item.to), content: item.content }));
  if (!subtitles.length) throw new Error('字幕文件下载成功，但内容为空');

  const isChinese = /^zh/i.test(track.lan || '');
  return {
    subtitles,
    title: view.data?.title || '',
    lan: track.lan,
    lanDoc: track.lan_doc,
    direction: isChinese ? 'zh2en' : 'en2zh',
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

  const fullText = String(fullContext || subtitles.map(item => item.content).join(' ')).slice(0, 8000);
  const batchSize = 40;
  const translations = [];

  for (let start = 0; start < subtitles.length; start += batchSize) {
    const batch = subtitles.slice(start, start + batchSize);
    translations.push(...await translateBatch(batch, fullText, direction, config));
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
