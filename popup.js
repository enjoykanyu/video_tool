// B站AI双语字幕 - Popup Script
document.addEventListener('DOMContentLoaded', async () => {
  const provider = document.getElementById('provider');
  const baseUrl = document.getElementById('baseUrl');
  const asrBaseUrl = document.getElementById('asrBaseUrl');
  const apiKey = document.getElementById('apiKey');
  const asrApiKey = document.getElementById('asrApiKey');
  const model = document.getElementById('model');
  const asrModel = document.getElementById('asrModel');
  const prompt = document.getElementById('prompt');
  const fontSize = document.getElementById('fontSize');
  const fontSizeValue = document.getElementById('fontSizeValue');
  const position = document.getElementById('position');
  const backgroundOpacity = document.getElementById('backgroundOpacity');
  const backgroundOpacityValue = document.getElementById('backgroundOpacityValue');
  const status = document.getElementById('status');
  const modelHint = document.getElementById('modelHint');
  const modelSummary = document.getElementById('modelSummary');
  const fontSummary = document.getElementById('fontSummary');

  function closeModals() {
    document.querySelectorAll('.modal.open').forEach(modal => modal.classList.remove('open'));
  }

  document.querySelectorAll('[data-open-modal]').forEach(button => {
    button.addEventListener('click', () => document.getElementById(button.dataset.openModal)?.classList.add('open'));
  });
  document.querySelectorAll('[data-close-modal]').forEach(button => button.addEventListener('click', closeModals));
  document.querySelectorAll('.modal').forEach(modal => modal.addEventListener('click', event => {
    if (event.target === modal) closeModals();
  }));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModals(); });
  
  const DEFAULT_PROMPT = `你是一位专业的视频字幕翻译专家。请根据以下要求翻译：

1. 上下文：这是整个视频的字幕全文，请利用全文语境确保翻译连贯准确
2. 格式：保持与原文相同的字幕分段和时间戳
3. 风格：口语化、自然流畅，符合视频内容语境
4. 对照：输出JSON格式，每条包含original(原文)和translation(译文)

全文语境参考：
{fullContext}

请翻译以下字幕（保持原顺序和分段）：
{subtitlesJson}

输出纯JSON数组，格式：
[
  {"from": 0.5, "to": 3.2, "content": "原文", "translation": "译文"},
  ...
]`;

  // 加载保存的配置
  const result = await chrome.storage.local.get([
    'apiKey', 'asrApiKey', 'baseUrl', 'asrBaseUrl', 'provider', 'model', 'asrModel', 'prompt', 'fontSize', 'position', 'backgroundOpacity'
  ]);
  
  if (result.provider) provider.value = result.provider;
  if (result.baseUrl) baseUrl.value = result.baseUrl;
  if (result.asrBaseUrl) asrBaseUrl.value = result.asrBaseUrl;
  if (result.apiKey) apiKey.value = result.apiKey;
  if (result.asrApiKey) asrApiKey.value = result.asrApiKey;
  if (result.model) model.value = result.model;
  asrModel.value = result.asrModel && !/^qwen(?:3-asr-flash|audio-3\.0-asr-flash)$/i.test(result.asrModel) ? result.asrModel : 'qwen-audio-3.1-asr-flash-filetrans';
  if (result.prompt) prompt.value = result.prompt;
  if (result.fontSize) fontSize.value = String(Math.max(14, Math.min(40, Number(result.fontSize))));
  if (result.position) position.value = result.position;
  if (result.backgroundOpacity) backgroundOpacity.value = String(Math.max(20, Math.min(90, Number(result.backgroundOpacity))));
  updateFontSizeLabel();
  updateBackgroundOpacityLabel();
  updateSummaries();

  fontSize.addEventListener('input', updateFontSizeLabel);
  backgroundOpacity.addEventListener('input', updateBackgroundOpacityLabel);
  model.addEventListener('input', updateSummaries);

  function updateFontSizeLabel() {
    fontSizeValue.textContent = `${fontSize.value}px`;
  }

  function updateBackgroundOpacityLabel() {
    backgroundOpacityValue.textContent = `${backgroundOpacity.value}%`;
  }

  function updateSummaries() {
    modelSummary.textContent = model.value.trim() || '未设置';
    fontSummary.textContent = `${fontSize.value}px`;
  }
  
  updateModelHint(provider.value);

  // 服务商变更时更新提示
  provider.addEventListener('change', (e) => {
    updateModelHint(e.target.value);
  });

  function updateModelHint(provider) {
    const hints = {
      bailian: '百炼推荐: qwen3.8-flash | qwen3.8-max | deepseek-v4.1-flash',
      openai: 'OpenAI推荐: gpt-4o-mini | gpt-4o'
    };
    modelHint.textContent = hints[provider] || hints.openai;
    
    // 自动填充默认模型
    const defaults = {
      bailian: 'qwen3.8-flash',
      openai: 'gpt-4o-mini'
    };
    if (!model.value || model.value === defaults[Object.keys(defaults).find(k => defaults[k] === model.value)]) {
      model.value = defaults[provider];
    }
  }

  // 测试连接
  document.getElementById('testBtn').addEventListener('click', async () => {
    showStatus('测试中...', 'info');
    
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'testConnection',
        config: {
          apiKey: apiKey.value,
          baseUrl: baseUrl.value,
          provider: provider.value,
          model: model.value
        }
      });
      
      if (response?.success) {
        showStatus('✓ 连接成功！API可用', 'success');
      } else {
        showStatus('✗ 连接失败: ' + (response?.error || '未知错误'), 'error');
      }
    } catch (error) {
      showStatus('✗ 测试失败: ' + error.message, 'error');
    }
  });
  document.getElementById('testQuickBtn').addEventListener('click', () => {
    document.getElementById('apiModal').classList.add('open');
    document.getElementById('testBtn').click();
  });

  // 恢复默认提示词
  document.getElementById('resetPrompt').addEventListener('click', () => {
    prompt.value = DEFAULT_PROMPT;
    showStatus('已恢复默认翻译提示词', 'success');
  });

  // 保存设置
  document.getElementById('saveBtn').addEventListener('click', async () => {
    try {
      await chrome.storage.local.set({
        apiKey: apiKey.value,
        asrApiKey: asrApiKey.value,
        baseUrl: baseUrl.value,
        asrBaseUrl: asrBaseUrl.value,
        provider: provider.value,
        model: model.value,
        asrModel: asrModel.value,
        prompt: prompt.value,
        fontSize: fontSize.value,
        position: position.value,
        backgroundOpacity: backgroundOpacity.value
      });
      
      // 通知content script更新配置
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url?.includes('bilibili.com')) {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'updateConfig',
          config: {
            fontSize: parseInt(fontSize.value),
            subtitlePosition: position.value,
            backgroundOpacity: parseInt(backgroundOpacity.value, 10) / 100
          }
        });
      }
      
      showStatus('✓ 设置已保存', 'success');
      closeModals();
    } catch (error) {
      showStatus('✗ 保存失败: ' + error.message, 'error');
    }
  });

  // 帮助链接
  document.getElementById('helpLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://github.com/your-repo/bilibili-ai-subtitle#readme' });
  });

  function showStatus(message, type) {
    status.textContent = message;
    status.className = 'status ' + type;
    if (type !== 'info') {
      setTimeout(() => {
        status.className = 'status';
      }, 3000);
    }
  }
});
