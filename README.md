# Gemini 节点可用性检测脚本

一个 Surge / Loon / Egern 的 **Sub-Store 脚本**，逐个节点检测 **Gemini 是否可用**，并给可用节点打标签。

写法与 [xream/scripts 的 gpt.js](https://github.com/xream/scripts/blob/main/surge/modules/sub-store-scripts/check/gpt.js) 保持一致，可直接和 GPT 检测串联使用。

---

## 检测原理

通过**指定节点**请求 `https://gemini.google.com`，从页面 bootstrap 数据中提取**区域码**：

```
,2,1,200,"XXX"        ← XXX 为 ISO 3166-1 alpha-3 区域码，如 USA / JPN / SGP / HKG / CHN
```

- 区域码**不在**不支持列表 → ✅ 可用
- 区域码**在**不支持列表 → ❌ 地区不支持
- 拿不到区域码 → 页面异常或请求失败

当前不支持地区（与上游一致）：

```
CHN  RUS  BLR  CUB  IRN  PRK  SYR  HKG  MAC
```

> 这是 [clash-verge-rev](https://github.com/clash-verge-rev/clash-verge-rev) 与 subs-check 等主流工具使用的**标准做法**
> （源码位置：`crates/clash-verge-media-unlock/src/gemini.rs`），比"抓网页关键词"可靠得多 —— 见文末对比。

---

## 用法

### 1. 接入 Sub-Store

在 Sub-Store 里给订阅添加一个**脚本操作**（筛选 / 处理），脚本填本仓库 `gemini.js` 的地址，例如：

```
https://raw.githubusercontent.com/<你的用户名>/<仓库名>/main/gemini.js
```

带参数时用 `#` 追加（多个参数用 `&` 连接）：

```
https://raw.githubusercontent.com/<你的用户名>/<仓库名>/main/gemini.js#cache=true&show_region=true
```

### 2. 常见组合

| 需求 | 参数 |
| --- | --- |
| 只打标签，不改节点顺序 | （默认） |
| 只保留能用 Gemini 的节点 | `#keep_only_ok=true` |
| 标签里带上落地地区码 | `#show_region=true` |
| 给不可用节点也打标 | `#unavailable_prefix=[X-Gemini] ` |
| 开启缓存（降低请求量） | `#cache=true` |

> 参数里若含空格 / 特殊字符，在 URL 形式中需 `encodeURIComponent`；直接在 Sub-Store 前端的可视化参数编辑器里填则不需要。

---

## 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `timeout` | `5000` | 请求超时（毫秒） |
| `retries` | `1` | 重试次数 |
| `retry_delay` | `1000` | 重试延时（毫秒） |
| `concurrency` | `10` | 并发数 |
| `method` | `get` | 请求方法 |
| `url` | `https://gemini.google.com` | 检测地址 |
| `ua` | macOS Chrome | 请求头 User-Agent（与上游一致） |
| `gemini_prefix` | `[Gemini] ` | 可用节点显示前缀 |
| `show_region` | `false` | 开启后前缀变为 `[Gemini USA] ` |
| `unavailable_prefix` | — | 给不可用节点加前缀，如 `[X-Gemini] ` |
| `keep_only_ok` | `false` | 只保留可用节点 |
| `include_unsupported_proxy` | `false` | 传递给运行环境时包含官方/商店版不支持的协议 |
| `cache` | `false` | 使用缓存 |
| `disable_failed_cache` / `ignore_failed_error` | `false` | 不缓存失败结果 |

## 写入的节点字段

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `_gemini` | `true` / `false` | 是否可用，可用于后续脚本筛选 |
| `_gemini_status` | `ok` / `blocked` / `unknown` / `failed` / `cached_failed` | 判定结果 |
| `_gemini_region` | 如 `USA` | 识别到的区域码（有则写入） |
| `_gemini_latency` | 数字（ms） | 实际请求时的延迟 |

---

## 与 gpt.js 的差异

| | gpt.js | 本脚本 |
| --- | --- | --- |
| 判定依据 | 请求 `ios.chat.openai.com`，看状态码 403 且不含 `unsupported_country` | 请求 `gemini.google.com`，解析页面区域码 |
| 附加字段 | `_gpt`、`_gpt_latency` | `_gemini`、`_gemini_status`、`_gemini_region`、`_gemini_latency` |
| 额外能力 | — | 可按地区码打标 / 只保留可用节点 |

两者结构完全一致，可同时挂在同一个订阅上，得到 `[GPT] [Gemini] 香港01` 这样的名称。

---

## 附：为什么"抓网页关键词"不可靠

有些面板脚本（例如 `Ai-Check.js`）用"请求 `gemini.google.com/app` 后，在 HTML 里搜 `unavailable` / `country` / `不可用` 等关键词"来判断 Gemini 可用性。这种做法问题明显：

1. **关键词过于宽泛**：`country`、`region`、`unsupported`、`不可用` 这类词在 Google 的正常页面、i18n 资源、内联 JS 里大量出现，极易**误报**。
2. **页面是 SPA**：`/app` 的初始 HTML 只是外壳，真正内容靠前端动态加载，关键词命中与否和"地区是否支持"没有稳定关系。
3. **无法区分"入口可达"和"真的能用"**：该脚本自己也只能输出"入口可达"，实际信息量接近于零。
4. **架构不同**：它是 Surge 面板脚本（`$httpClient`），只能检测**当前策略**，无法逐节点批量检测。

而"解析区域码"是**结构化判定**：Google 会在页面里明确写出识别到的地区码，直接读它即可，准确且能顺带得到落地地区。

> 注意：区域码法判断的是 **Gemini 网页端在服务端是否对你的出口地区放行**。它不检查登录态、账号资格（如 Google AI Pro 订阅）等信息 —— 这类信息无法在不登录的情况下探测。

---

## 致谢 / 参考

- 检测方法与不支持地区列表参考 [clash-verge-rev](https://github.com/clash-verge-rev/clash-verge-rev)（GPL-3.0）的媒体解锁检测模块
- Sub-Store 脚本结构参考 [xream/scripts](https://github.com/xream/scripts) 的 `sub-store-scripts/check/`

## License

MIT
