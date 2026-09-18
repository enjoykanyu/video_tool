(function () {
  'use strict';

  const CACHE_PREFIX = 'subtitleCache:';
  const CONTEXT_RADIUS = 1;
  const state = {
    bvid: '', page: 1, cacheBase: '', video: null, subtitles: [], generation: 0,
    currentIndex: -2, frame: 0, panel: null, body: null, status: null, chooser: null,
    recordSelect: null, fileInput: null, dragPosition: null, size: null, resourceUrls: [],
  };
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text, title, onClick, className = '') => {
    const node = el('button', className, text);
    node.type = 'button'; node.title = title; node.addEventListener('click', onClick);
    return node;
  };
  const rememberResource = url => {
    if (!/(?:ai[_-]?subtitle|subtitle|caption|\/bfs\/)/i.test(url || '')) return;
    state.resourceUrls = [url, ...state.resourceUrls.filter(item => item !== url)].slice(0, 80);
  };
  performance.getEntriesByType('resource').forEach(entry => rememberResource(entry.name));
  try {
    new PerformanceObserver(list => list.getEntries().forEach(entry => rememberResource(entry.name))).observe({ type: 'resource', buffered: true });
  } catch (_) {}

  function videoIdentity() {
    const bvid = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1] || '';
    const page = Math.max(1, Number(new URLSearchParams(location.search).get('p') || 1));
    return { bvid, page, key: `${CACHE_PREFIX}${bvid}:p${page}:` };
  }

  async function init() {
    const run = ++state.generation;
    stopLoop();
    state.video = await waitForVideo();
    if (run !== state.generation || !state.video) return;
    const identity = videoIdentity();
    Object.assign(state, { ...identity, cacheBase: identity.key, subtitles: [], currentIndex: -2 });
    createUi();
    await refreshRecords();
    showChooser();
  }

  function waitForVideo(timeout = 15000) {
    return new Promise(resolve => {
      const started = Date.now();
      const poll = () => {
        const video = document.querySelector('video.bpx-player-video') || document.querySelector('video');
        if (video || Date.now() - started > timeout) resolve(video || null);
        else setTimeout(poll, 200);
      };
      poll();
    });
  }

  function createUi() {
    document.getElementById('ai-subtitle-container')?.remove();
    document.getElementById('ai-subtitle-status')?.remove();
    document.getElementById('ai-subtitle-chooser')?.remove();
    state.chooser = el('div', 'ai-subtitle-chooser');
    state.chooser.id = 'ai-subtitle-chooser';
    state.recordSelect = el('select', 'ai-record-select');
    state.recordSelect.title = '当前视频分P的本地字幕记录';
    state.fileInput = el('input');
    state.fileInput.type = 'file'; state.fileInput.accept = '.srt,application/x-subrip,text/plain'; state.fileInput.hidden = true;
    state.fileInput.addEventListener('change', importSrt);
    state.chooser.append(
      el('span', 'ai-source-title', `字幕来源 · P${state.page}`),
      button('导入 SRT', '从本机导入，直接播放，不调用模型', () => state.fileInput.click()),
      state.recordSelect,
      button('加载记录', '直接播放缓存，不调用模型', loadSelectedRecord),
      button('提取英文并翻译', '读取当前分P英文 CC 并翻译', extractOnline),
      button('×', '关闭来源选择', () => { state.chooser.hidden = true; }, 'icon-button'),
      state.fileInput
    );

    state.panel = el('div', 'ai-subtitle-hidden'); state.panel.id = 'ai-subtitle-container';
    const toolbar = el('div', 'ai-subtitle-toolbar');
    const handle = el('span', 'ai-subtitle-handle', '⋮⋮'); handle.title = '拖动字幕'; handle.addEventListener('pointerdown', startDrag);
    toolbar.append(handle, button('来源', '重新选择字幕来源', showChooser), button('TXT ↓', '下载 TXT', () => download('txt')),
      button('SRT ↓', '下载 SRT', () => download('srt')), button('×', '关闭字幕', hidePanel, 'icon-button'));
    state.body = el('div', 'ai-subtitle-body');
    state.panel.append(toolbar, state.body);
    state.status = el('div'); state.status.id = 'ai-subtitle-status'; state.status.hidden = true;
    document.body.append(state.chooser, state.panel, state.status);
    state.panel.style.fontSize = `${state.fontSize || 16}px`;
    applyGeometry(); bindVideo();
    new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (!rect || state.panel.classList.contains('ai-subtitle-hidden')) return;
      state.size = { width: Math.round(rect.width), height: Math.round(rect.height) };
      chrome.storage.local.set({ subtitleSize: state.size });
    }).observe(state.panel);
  }

  async function refreshRecords() {
    const stored = await chrome.storage.local.get(null);
    const records = Object.entries(stored).filter(([key, record]) => key.startsWith(state.cacheBase) && validRecord(record)).sort((a, b) => b[1].savedAt - a[1].savedAt);
    state.recordSelect.replaceChildren();
    if (!records.length) {
      const option = el('option', '', '无当前分P记录'); option.disabled = true; option.selected = true; state.recordSelect.append(option); return;
    }
    for (const [key, record] of records) {
      const option = el('option', '', `${record.source === 'import' ? '导入' : '在线'} · ${record.fileName || record.part || ''} · ${record.subtitles.length} 条`);
      option.value = key; state.recordSelect.append(option);
    }
  }

  function validRecord(record) {
    if (!record || record.bvid !== state.bvid || Number(record.page) !== state.page || !Array.isArray(record.subtitles) || !record.subtitles.length) return false;
    const end = Number(record.subtitles.at(-1)?.to || 0);
    const duration = Number(state.video?.duration || record.duration || 0);
    return !duration || end <= duration + 120;
  }

  async function loadSelectedRecord() {
    if (!state.recordSelect.value) return showStatus('当前分P没有可用的本地记录', 'error');
    const key = state.recordSelect.value;
    const record = (await chrome.storage.local.get(key))[key];
    if (!validRecord(record)) return showStatus('记录与当前视频不匹配，已拒绝加载', 'error');
    activate(record.subtitles, `已加载本地记录，共 ${record.subtitles.length} 条`);
  }

  async function importSrt(event) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    try {
      const parsed = parseSrt(await file.text());
      if (!parsed.length) throw new Error('没有识别到有效时间轴');
      const end = Number(parsed.at(-1).to);
      if (state.video.duration && end > state.video.duration + 120) throw new Error(`字幕时长 ${Math.round(end)} 秒与当前视频 ${Math.round(state.video.duration)} 秒不匹配`);
      const key = `${state.cacheBase}import:${Date.now()}`;
      await chrome.storage.local.set({ [key]: makeRecord(parsed, 'import', { fileName: file.name }) });
      await refreshRecords(); activate(parsed, `已导入 ${file.name}，共 ${parsed.length} 条`);
    } catch (error) { showStatus(`导入失败：${error.message}`, 'error'); }
  }

  function parseSrt(text) {
    return String(text).replace(/^\uFEFF/, '').split(/\r?\n\s*\r?\n/).flatMap(block => {
      const lines = block.trim().split(/\r?\n/); const timing = lines.findIndex(line => line.includes('-->'));
      const match = timing >= 0 && lines[timing].match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
      if (!match) return [];
      const seconds = values => Number(values[0]) * 3600 + Number(values[1]) * 60 + Number(values[2]) + Number(values[3].padEnd(3, '0').slice(0, 3)) / 1000;
      const subtitleLines = lines.slice(timing + 1).map(line => line.trim()).filter(Boolean);
      if (!subtitleLines.length) return [];
      const translationIndex = subtitleLines.findIndex((line, index) => index > 0 && /[\u3400-\u9fff]/.test(line));
      const content = (translationIndex > 0 ? subtitleLines.slice(0, translationIndex) : subtitleLines).join('\n');
      const translation = translationIndex > 0 ? subtitleLines.slice(translationIndex).join('\n') : '';
      return [{ from: seconds(match.slice(1, 5)), to: seconds(match.slice(5, 9)), content, translation }];
    }).filter(item => Number.isFinite(item.from) && item.to >= item.from).sort((a, b) => a.from - b.from);
  }

  async function extractOnline() {
    const run = state.generation; showStatus('正在读取当前分P的英文 CC 字幕…', 'loading');
    try {
      let result = await chrome.runtime.sendMessage({ action: 'fetchSubtitles', bvid: state.bvid, page: state.page });
      if (run !== state.generation) return;
      if (!result?.success || !result.subtitles?.length) {
        const directError = result?.error || result?.hint || '字幕元数据没有下载地址';
        showStatus('元数据地址不可用，正在读取播放器已加载的英文字幕…', 'loading');
        result = await findPlayerLoadedSubtitles();
        if (!result?.subtitles?.length) throw new Error(`${directError}；播放器资源中也未找到完整英文字幕`);
      }
      if (result.page !== undefined && Number(result.page) !== state.page) throw new Error('接口返回了其他分P，已拒绝加载');
      const duration = Number(result.duration || state.video.duration || 0), end = Number(result.subtitles.at(-1)?.to || 0);
      if (duration && end > duration + 120) throw new Error('英文轨道时长与当前分P不匹配');
      state.subtitles = result.subtitles.map(item => ({ ...item, translation: '' }));
      activate(state.subtitles, `已提取英文 ${state.subtitles.length} 条，开始翻译…`, false);
      await translateAll(result, run);
    } catch (error) { showStatus(`英文字幕提取失败：${error.message}`, 'error'); }
  }

  async function findPlayerLoadedSubtitles() {
    for (let attempt = 0; attempt < 4; attempt++) {
      const urls = performance.getEntriesByType('resource')
        .filter(entry => /(?:ai[_-]?subtitle|subtitle|caption|\/bfs\/)/i.test(entry.name))
        .sort((a, b) => b.startTime - a.startTime)
        .map(entry => entry.name);
      const result = await chrome.runtime.sendMessage({
        action: 'fetchLoadedSubtitleCandidates',
        urls: [...new Set([...state.resourceUrls, ...urls])],
        duration: Number(state.video.duration || 0),
      });
      if (result?.success && result.subtitles?.length) {
        return { ...result, page: state.page, duration: Number(state.video.duration || 0), part: `P${state.page}` };
      }
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    return null;
  }

  async function translateAll(meta, run) {
    for (let start = 0; start < state.subtitles.length; start += 40) {
      if (run !== state.generation) return;
      const context = state.subtitles.slice(Math.max(0, start - 40), Math.min(state.subtitles.length, start + 80)).map(item => item.content).join('\n');
      const response = await chrome.runtime.sendMessage({ action: 'translateSubtitles', direction: 'en2zh', fullContext: context, subtitles: state.subtitles.slice(start, start + 40) });
      if (!response?.success || response.translations?.length !== Math.min(40, state.subtitles.length - start)) {
        await chrome.storage.local.set({ [`${state.cacheBase}online`]: makeRecord(state.subtitles, 'online', meta) });
        throw new Error(response?.error || '翻译返回数量不正确');
      }
      state.subtitles.splice(start, response.translations.length, ...response.translations);
      state.currentIndex = -2; update(); showStatus(`翻译中 ${Math.min(start + 40, state.subtitles.length)} / ${state.subtitles.length}`, 'loading');
      await chrome.storage.local.set({ [`${state.cacheBase}online`]: makeRecord(state.subtitles, 'online', meta) });
    }
    await refreshRecords(); showStatus(`英文提取与翻译完成，共 ${state.subtitles.length} 条`, 'success');
  }

  function makeRecord(subtitles, source, meta = {}) {
    return { schema: 2, bvid: state.bvid, page: state.page, cid: meta.cid || null, part: meta.part || '', fileName: meta.fileName || '', duration: Number(meta.duration || state.video.duration || 0), source, savedAt: Date.now(), subtitles };
  }

  function activate(subtitles, message, hideChooser = true) {
    state.subtitles = subtitles; state.currentIndex = -2; state.panel.classList.remove('ai-subtitle-hidden');
    if (hideChooser) state.chooser.hidden = true; startLoop(); update(); showStatus(message, 'success');
  }

  function bindVideo() {
    state.video.addEventListener('play', startLoop); state.video.addEventListener('pause', stopLoop); state.video.addEventListener('seeked', update);
    document.removeEventListener('fullscreenchange', attachRoot); document.addEventListener('fullscreenchange', attachRoot);
  }
  function attachRoot() { (document.fullscreenElement || document.body).append(state.chooser, state.panel, state.status); applyGeometry(); }
  function startLoop() { if (state.frame) return; const loop = () => { update(); state.frame = requestAnimationFrame(loop); }; state.frame = requestAnimationFrame(loop); }
  function stopLoop() { if (state.frame) cancelAnimationFrame(state.frame); state.frame = 0; }

  function update() {
    if (!state.video || !state.subtitles.length) return;
    const time = state.video.currentTime; let low = 0, high = state.subtitles.length - 1, index = -1;
    while (low <= high) { const mid = (low + high) >> 1; if (state.subtitles[mid].from <= time) { index = mid; low = mid + 1; } else high = mid - 1; }
    if (index >= 0 && time > state.subtitles[index].to) index = -1;
    if (index !== state.currentIndex) { state.currentIndex = index; render(index); }
  }

  function render(center) {
    state.body.replaceChildren();
    if (center < 0) return state.panel.classList.add('ai-subtitle-no-cue');
    state.panel.classList.remove('ai-subtitle-no-cue', 'ai-subtitle-hidden');
    const start = Math.max(0, center - CONTEXT_RADIUS), end = Math.min(state.subtitles.length - 1, center + CONTEXT_RADIUS);
    for (let i = start; i <= end; i++) {
      const item = state.subtitles[i], line = el('div', `subtitle-line${i === center ? ' subtitle-current' : ''}`);
      line.append(el('div', 'subtitle-original', item.content || ''));
      if (item.translation) line.append(el('div', 'subtitle-translation', item.translation));
      state.body.append(line);
    }
  }

  function showChooser() { state.chooser.hidden = false; }
  function hidePanel() { state.panel.classList.add('ai-subtitle-hidden'); stopLoop(); }
  function showStatus(message, type) {
    state.status.textContent = message; state.status.dataset.type = type; state.status.hidden = false; clearTimeout(showStatus.timer);
    if (type !== 'loading' && type !== 'error') showStatus.timer = setTimeout(() => { state.status.hidden = true; }, 3500);
  }

  function startDrag(event) {
    if (event.button !== 0) return; event.preventDefault();
    const rect = state.panel.getBoundingClientRect(), dx = event.clientX - rect.left, dy = event.clientY - rect.top;
    const move = e => { state.dragPosition = { x: Math.max(0, Math.min(innerWidth - rect.width, e.clientX - dx)), y: Math.max(0, Math.min(innerHeight - rect.height, e.clientY - dy)) }; applyGeometry(); };
    const end = () => { removeEventListener('pointermove', move); chrome.storage.local.set({ subtitleCoordinates: state.dragPosition }); };
    addEventListener('pointermove', move); addEventListener('pointerup', end, { once: true });
  }

  function applyGeometry() {
    if (!state.panel) return;
    if (state.dragPosition) {
      state.panel.style.left = `${Math.max(0, Math.min(state.dragPosition.x, innerWidth - 240))}px`;
      state.panel.style.top = `${Math.max(0, Math.min(state.dragPosition.y, innerHeight - 120))}px`;
      state.panel.style.bottom = 'auto'; state.panel.style.transform = 'none';
    }
    if (state.size) { state.panel.style.width = `${state.size.width}px`; state.panel.style.height = `${state.size.height}px`; }
  }

  function download(format) {
    if (!state.subtitles.length) return;
    const stamp = seconds => { const ms = Math.round(Number(seconds) * 1000); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
    const text = state.subtitles.map((item, index) => { const body = [item.content, item.translation].filter(Boolean).join('\n'); return format === 'srt' ? `${index + 1}\n${stamp(item.from)} --> ${stamp(item.to)}\n${body}` : body; }).join('\n\n') + '\n';
    const url = URL.createObjectURL(new Blob(['\uFEFF', text], { type: 'text/plain;charset=utf-8' })), link = el('a');
    link.href = url; link.download = `${state.bvid}-p${state.page}-subtitles.${format}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (request.action === 'reloadSubtitles') { init(); respond({ success: true }); }
    else if (request.action === 'updateConfig') {
      if (request.config?.fontSize && state.panel) state.panel.style.fontSize = `${request.config.fontSize}px`;
      respond({ success: true });
    }
    return true;
  });
  async function loadPreferences() {
    const stored = await chrome.storage.local.get(['subtitleCoordinates', 'subtitleSize', 'fontSize']);
    state.dragPosition = stored.subtitleCoordinates || null; state.size = stored.subtitleSize || null;
    state.fontSize = Number(stored.fontSize || 16);
  }
  let lastUrl = location.href;
  setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; if (/\/video\//.test(location.pathname)) setTimeout(init, 700); } }, 700);
  const begin = async () => { await loadPreferences(); await init(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin, { once: true }); else begin();
})();
