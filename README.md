# B站AI双语字幕 v1.2.0

为B站视频添加AI生成的中英文对照字幕，支持实时翻译与滚动显示。

## 主要改进 (v1.2.0)
- **修复 B 站字幕提取失败问题**：现在直接从页面 `__INITIAL_STATE__` 提取字幕，不依赖已失效的旧 API
- **WBI 签名备选**：当直接提取失败时，自动使用 WBI 签名 API 作为后备
- **支持 deepseek-v4-flash**：推荐模型已更新

## 使用方法

1. 打开 Chrome 的「扩展程序」页面（`chrome://extensions/`），开启「开发者模式」
2. 点击「加载已解压的扩展程序」，选择本文件夹
3. 点击扩展图标，配置 API：
   - **服务商**：选择「阿里云百炼」
   - **Base URL**：`https://dashscope.aliyuncs.com/compatible-mode/v1`
   - **API Key**：你的百炼 API Key
   - **推荐模型**：`deepseek-v4-flash`（或其他兼容模型）
4. 点击「测试连接」，成功后保存
5. 打开带字幕的 B 站视频，字幕会自动提取、翻译，并随播放进度滚动显示中英文

## 字幕来源
- 优先从 B 站视频页面的 `__INITIAL_STATE__` 直接提取（无需额外 API 请求）
- 备选使用 WBI 签名后的 `/x/player/wbi/v2` API
- 最后使用原始 `/x/player/v2` API

API Key 仅保存在浏览器本地 `chrome.storage.local`，不会上传。
