(function() {
  'use strict';

  let subtitleContainer = null;
  let statusElement = null;
  let subtitles = [];
  let translatedSubtitles = [];
  let videoElement = null;
  let currentSubtitleIndex = -2;
  let animationFrameId = null;
  let isProcessing = false;
  let navigationPollId = null;

  const CONFIG = {
    fontSize: 18,
    subtitlePosition: 'bottom',
  };

  const CONTEXT_BEFORE = 2;
  const CONTEXT_AFTER = 3;

  async function init() {
    try {
      const video = await waitForVideo();
      if (!video) {
        showStatus('未找到播放器 / No video element found', 'error');
        return;
      }

      if (videoElement && videoElement !== video && animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }

      videoElement = video;
      createSubtitleContainer();
      clearSubtitle();

      const bvid = window.location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1];
      if (!bvid) {
        showStatus('无法从地址解析视频 BV 号 / Cannot parse BV id', 'error');
        return;
      }

      // Step 1: Extract subtitles from page __INITIAL_STATE__ (most reliable)
      showStatus('正在提取字幕 / Extracting subtitles\u2026', 'loading');
      let result = await extractSubtitlesFromPage();

      // Step 2: Fallback to background API
      if (!result) {
        const page = Number(new URLSearchParams(window.location.search).get('p') || 1);
        const apiResult = await chrome.runtime.sendMessage({ action: 'fetchSubtitles', bvid, page });
        if (apiResult?.success) {
          result = apiResult;
        }
      }

      if (!result || !Array.isArray(result.subtitles) || !result.subtitles.length) {
        const hint = result?.hint || '';
        showStatus(`\u5f53\u524d\u89c6\u9891\u6ca1\u6709\u53ef\u7528 CC \u5b57\u5e55 / No CC subtitles. ${hint}`, 'error');
        return;
      }

      subtitles = result.subtitles;
      if (!subtitles.length) {
        showStatus('\u5f53\u524d\u89c6\u9891\u6ca1\u6709\u53ef\u7528 CC \u5b57\u5e55 / No CC subtitles', 'error');
        return;
      }

      const lanText = result.lanDoc || result.lan || '';
      showStatus(`\u5df2\u63d0\u53d6 ${subtitles.length} \u6761\u5b57\u5e55\uff08${lanText}\uff09\uff0c\u7ffb\u8bd1\u4e2d / Translating\u2026`, 'loading');
      translatedSubtitles = [];
      renderWindow(-1);
      await requestTranslation(subtitles, result.direction || 'en2zh');
      hideStatus();
      bindVideoEvents();
      startSubtitleLoop();
      updateSubtitleForCurrentTime();
    } catch (error) {
      console.error('[B\u7ad9AI\u5b57\u5e55] \u521d\u59cb\u5316\u5931\u8d25:', error);
      showStatus(`\u63d0\u53d6\u5931\u8d25 / Failed: ${error.message}\uff08\u53ef\u70b9\u51fb\u6269\u5c55\u56fe\u6807\u91cd\u8bd5\uff09`, 'error');
    }
  }

  /**
   * Extract __INITIAL_STATE__ from Bilibili page HTML
   */
  function parseInitialState() {
    try {
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent || '';
        const match = text.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});\s*</);
        if (match) {
          try {
            return JSON.parse(match[1]);
          } catch (e) {
            // Try looser match
            const loose = text.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\});?\s*(?:\/\/|window|var|const|let|$)/);
            if (loose) {
              try { return JSON.parse(loose[1]); } catch (e2) {}
            }
          }
        }
      }
      // Try fetching from page source as fallback
      const html = document.documentElement.innerHTML;
      const htmlMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\});?\s*(?:<\/script>|window|var|const|let|$)/);
      if (htmlMatch) {
        try {
          return JSON.parse(htmlMatch[1]);
        } catch (e) {}
      }
    } catch (e) {
      console.warn('[B\u7ad9AI\u5b57\u5e55] \u89e3\u6790 __INITIAL_STATE__ \u5931\u8d25:', e);
    }
    return null;
  }

  /**
   * Extract subtitle data directly from page __INITIAL_STATE__
   */
  async function extractSubtitlesFromPage() {
    const state = parseInitialState();
    if (!state) return null;

    // Helper to find subtitles array in any nested structure
    const findSubtitles = (obj) => {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
      try {
        if (Array.isArray(obj.subtitles) && obj.subtitles.length > 0 &&
            obj.subtitles[0] && obj.subtitles[0].subtitle_url) {
          return obj.subtitles;
        }
      } catch (e) {}
      // Check videoData.subtitle.subtitles
      if (obj.videoData && obj.videoData.subtitle) {
        try {
          if (Array.isArray(obj.videoData.subtitle.subtitles) &&
              obj.videoData.subtitle.subtitles.length > 0) {
            return obj.videoData.subtitle.subtitles;
          }
        } catch (e) {}
      }
      return null;
    };

    let subtitlesList = findSubtitles(state);
    if (!subtitlesList) subtitlesList = findSubtitles({ videoData: state });
    if (!subtitlesList) subtitlesList = findSubtitles({ videoData: { subtitle: state } });
    // Try initState for SPA-loaded pages
    if (!subtitlesList && state.initState) {
      subtitlesList = findSubtitles(state.initState) ||
        findSubtitles({ videoData: state.initState }) ||
        findSubtitles({ videoData: { subtitle: state.initState } });
    }

    if (!subtitlesList || !subtitlesList.length) return null;

    // Pick best track: en > zh-CN > zh-Hans > ai-zh > first
    const track =
      subtitlesList.find(item => /^en$/i.test(item.lan || '')) ||
      subtitlesList.find(item => item.lan === 'zh-CN') ||
      subtitlesList.find(item => item.lan === 'zh-Hans') ||
      subtitlesList.find(item => /^ai-/i.test(item.lan)) ||
      subtitlesList[0];

    if (!track || !track.subtitle_url) return null;

    // Fetch subtitle JSON
    const subtitleUrl = track.subtitle_url.startsWith('http')
      ? track.subtitle_url
      : `https:${track.subtitle_url}`;
    const resp = await fetch(subtitleUrl, { credentials: 'include' });
    if (!resp.ok) {
      console.warn('[B\u7ad9AI\u5b57\u5e55] \u5b57\u5e55\u6587\u4ef6\u8bf7\u6c42\u5931\u8d25:', resp.status);
      return null;
    }

    const subtitleData = await resp.json();
    const items = (subtitleData.body || [])
      .filter(item => typeof item.content === 'string')
      .map(item => ({
        from: Number(item.from),
        to: Number(item.to),
        content: item.content.trim()
      }));

    if (!items.length) return null;

    const isChinese = /^zh/i.test(track.lan || '');
    const title = state.title || (state.videoData && state.videoData.title) || '';
    const videoDataTitle = state.videoData && state.videoData.title;

    return {
      subtitles: items,
      title: title || videoDataTitle || '',
      lan: track.lan,
      lanDoc: track.lan_doc,
      direction: isChinese ? 'zh2en' : 'en2zh',
      tracks: subtitlesList.map(item => ({ lan: item.lan, lan_doc: item.lan_doc })),
    };
  }

  function waitForVideo(timeout = 15000) {
    return new Promise(resolve => {
      const startedAt = Date.now();
      const check = () => {
        const video = document.querySelector('video.bpx-player-video') || document.querySelector('video');
        if (video) resolve(video);
        else if (Date.now() - startedAt > timeout) resolve(null);
        else setTimeout(check, 200);
      };
      check();
    });
  }

  async function requestTranslation(originalSubtitles, direction) {
    if (isProcessing) return;
    isProcessing = true;

    try {
      const fullContext = originalSubtitles.map(item => item.content).join('\n');
      const result = await chrome.runtime.sendMessage({
        action: 'translateSubtitles',
        subtitles: originalSubtitles,
        fullContext,
        direction,
      });

      if (!result?.success || !Array.isArray(result.translations)) {
        throw new Error(result?.error || '\u7ffb\u8bd1\u5931\u8d25');
      }
      translatedSubtitles = result.translations;
    } catch (error) {
      console.error('[B\u7ad9AI\u5b57\u5e55] \u7ffb\u8bd1\u5931\u8d25:', error);
      translatedSubtitles = originalSubtitles.map(item => ({ ...item, translation: item.content }));
      showStatus(`\u7ffb\u8bd1\u5931\u8d25\uff0c\u4ec5\u663e\u793a\u539f\u6587 / Translation failed: ${error.message}`, 'error');
      setTimeout(hideStatus, 6000);
    } finally {
      isProcessing = false;
    }
  }

  function createSubtitleContainer() {
    document.getElementById('ai-subtitle-container')?.remove();
    document.getElementById('ai-subtitle-status')?.remove();

    subtitleContainer = document.createElement('div');
    subtitleContainer.id = 'ai-subtitle-container';
    subtitleContainer.className = 'ai-subtitle-hidden';

    statusElement = document.createElement('div');
    statusElement.id = 'ai-subtitle-status';
    statusElement.className = 'ai-subtitle-status';
    statusElement.style.display = 'none';

    const player = document.querySelector('.bpx-player-container') || document.body;
    player.appendChild(statusElement);
    player.appendChild(subtitleContainer);
    applySubtitleConfig();
  }

  function bindVideoEvents() {
    videoElement.addEventListener('play', startSubtitleLoop);
    videoElement.addEventListener('pause', pauseSubtitleLoop);
    videoElement.addEventListener('seeked', updateSubtitleForCurrentTime);
    document.addEventListener('fullscreenchange', applySubtitleConfig);
  }

  function startSubtitleLoop() {
    if (animationFrameId) return;
    const loop = () => {
      updateSubtitleForCurrentTime();
      animationFrameId = requestAnimationFrame(loop);
    };
    animationFrameId = requestAnimationFrame(loop);
  }

  function pauseSubtitleLoop() {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
  }

  function findActiveIndex(list, time) {
    let active = -1;
    for (let index = 0; index < list.length; index++) {
      if (list[index].from > time) break;
      if (time <= list[index].to) { active = index; break; }
      active = index;
    }
    return active;
  }

  function updateSubtitleForCurrentTime() {
    if (!videoElement || !translatedSubtitles.length) return;
    const index = findActiveIndex(translatedSubtitles, videoElement.currentTime);

    if (index < 0) {
      if (!subtitleContainer.classList.contains('ai-subtitle-hidden')) {
        subtitleContainer.classList.add('ai-subtitle-hidden');
        currentSubtitleIndex = -2;
      }
      return;
    }

    if (index !== currentSubtitleIndex) {
      currentSubtitleIndex = index;
      renderWindow(index);
    }
  }

  function renderWindow(centerIndex) {
    if (!subtitleContainer) return;
    subtitleContainer.replaceChildren();

    if (centerIndex < 0 || !translatedSubtitles.length) {
      subtitleContainer.classList.add('ai-subtitle-hidden');
      return;
    }

    const start = Math.max(0, centerIndex - CONTEXT_BEFORE);
    const end = Math.min(translatedSubtitles.length - 1, centerIndex + CONTEXT_AFTER);

    for (let index = start; index <= end; index++) {
      const item = translatedSubtitles[index];
      const line = document.createElement('div');
      line.className = 'subtitle-line';
      if (index < centerIndex) line.classList.add('subtitle-past');
      if (index === centerIndex) line.classList.add('subtitle-current');

      const original = document.createElement('div');
      original.className = 'subtitle-original';
      original.textContent = item.content || '';

      const translation = document.createElement('div');
      translation.className = 'subtitle-translation';
      translation.textContent = item.translation || '';

      line.appendChild(original);
      line.appendChild(translation);
      subtitleContainer.appendChild(line);
    }

    subtitleContainer.classList.remove('ai-subtitle-hidden');
  }

  function clearSubtitle() {
    if (!subtitleContainer) return;
    subtitleContainer.replaceChildren();
    subtitleContainer.classList.add('ai-subtitle-hidden');
    currentSubtitleIndex = -2;
  }

  function applySubtitleConfig() {
    if (!subtitleContainer) return;
    subtitleContainer.style.fontSize = `${CONFIG.fontSize}px`;
    subtitleContainer.classList.toggle('ai-subtitle-top', CONFIG.subtitlePosition === 'top');
    subtitleContainer.classList.toggle('ai-subtitle-fullscreen', Boolean(document.fullscreenElement));
  }

  function showStatus(message, type) {
    if (!statusElement) return;
    statusElement.textContent = message;
    statusElement.dataset.type = type;
    statusElement.style.display = 'block';
  }

  function hideStatus() {
    if (statusElement) statusElement.style.display = 'none';
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'reloadSubtitles') {
      init();
      sendResponse({ success: true });
    } else if (request.action === 'updateConfig') {
      Object.assign(CONFIG, request.config);
      applySubtitleConfig();
      sendResponse({ success: true });
    }
    return true;
  });

  function watchNavigation() {
    let lastHref = window.location.href;
    navigationPollId = setInterval(async () => {
      if (window.location.href === lastHref) return;
      lastHref = window.location.href;
      if (!/\/(?:video|bangumi)\//.test(window.location.pathname)) return;

      pauseSubtitleLoop();
      subtitles = [];
      translatedSubtitles = [];
      await new Promise(resolve => setTimeout(resolve, 700));
      init();
    }, 1000);
  }

  const loadDisplayConfig = async () => {
    const result = await chrome.storage.local.get(['fontSize', 'position']);
    CONFIG.fontSize = Number(result.fontSize || 18);
    CONFIG.subtitlePosition = result.position || 'bottom';
    applySubtitleConfig();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', async () => {
      await loadDisplayConfig();
      init();
      watchNavigation();
    });
  } else {
    loadDisplayConfig().then(() => {
      init();
      watchNavigation();
    });
  }
})();