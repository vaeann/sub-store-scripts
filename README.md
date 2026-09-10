# Sub-Store 脚本集合

Surge / Loon / Egern 用的 **Sub-Store 节点检测脚本**，逐个节点检测服务可用性并给节点打标签。

| 脚本 | 用途 | 判定依据 |
| --- | --- | --- |
| [`gemini.js`](gemini.js) | Gemini 可用性 | 解析 `gemini.google.com` 页面里的落地区域码 |
| [`gpt.js`](gpt.js) | ChatGPT 可用性 | 请求 OpenAI 端点，检查响应体特征 |

两者结构一致，可**串在同一个订阅上**，得到 `[GPT⁺] [Gemini] 香港01` 这样的名称。

---

## 用法

在 Sub-Store 里给订阅添加**脚本操作**，脚本填对应文件的地址：

```
https://raw.githubusercontent.com/vaeann/sub-store-scripts/main/gemini.js
https://raw.githubusercontent.com/vaeann/sub-store-scripts/main/gpt.js
```

带参数用 `#` 追加（多个用 `&`），例如：

```
...gpt.js#mode=both&cache=true
...gemini.js#keep_only_ok=true&show_region=true
```

> URL 形式传参时，含空格/特殊字符的值需要 `encodeURIComponent`；在 Sub-Store 前端的可视化参数编辑器里填则不需要。

## 共同特性

- **并发池**（`concurrency`）、**重试**（`retries` / `retry_delay`）、**缓存**（`cache`，成功与失败分开缓存）
- 通过 Sub-Store 的 `policy-descriptor` 机制让请求**从指定节点出去**，实现逐节点检测
- 结果既写进**节点名前缀**（方便肉眼识别），也写进 `_xxx` 字段（方便后续脚本筛选）
- **布尔参数按语义解析**（`true/false/1/0/yes/no/on/off`）—— 避免 URL 传 `x=false` 被当成真值

---

## gemini.js — Gemini 可用性检测

### 原理

请求 `https://gemini.google.com`，从页面 bootstrap 数据里提取区域码：

```
,2,1,200,"XXX"        XXX = ISO 3166-1 alpha-3 区域码，如 USA / JPN / SGP / HKG / CHN
```

区域码**不在**不支持列表 → 可用；**在** → 地区不支持。

不支持地区（与上游一致）：`CHN RUS BLR CUB IRN PRK SYR HKG MAC`

这是 [clash-verge-rev](https://github.com/clash-verge-rev/clash-verge-rev)（`crates/clash-verge-media-unlock/src/gemini.rs`）与 subs-check 采用的标准做法。

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `timeout` | `5000` | 请求超时（毫秒） |
| `retries` | `1` | 重试次数 |
| `retry_delay` | `1000` | 重试延时（毫秒） |
| `concurrency` | `10` | 并发数 |
| `method` | `get` | 请求方法 |
| `samples` | `3` | 每个节点采样次数，取多数票（**建议奇数 3/5**，偶数无优势）|
| `url` | `https://gemini.google.com` | 检测地址 |
| `ua` | macOS Chrome | User-Agent（与上游一致） |
| `gemini_prefix` | `[Gemini] ` | 可用节点前缀 |
| `show_region` | `false` | 开启后前缀变为 `[Gemini USA] ` |
| `unavailable_prefix` | — | 给不可用节点也加前缀，如 `[X-Gemini] ` |
| `keep_only_ok` | `false` | 只保留可用节点 |
| `include_unsupported_proxy` | `false` | 传递节点时包含官方/商店版不支持的协议 |
| `cache` | `false` | 使用缓存 |
| `disable_failed_cache` / `ignore_failed_error` | `false` | 不缓存失败结果 |

### 写入的字段

| 字段 | 说明 |
| --- | --- |
| `_gemini` | `true` / `false` 是否可用 |
| `_gemini_status` | `ok` / `blocked` / `unknown` / `failed` / `cached_failed` |
| `_gemini_region` | 区域码（识别到才有），如 `USA` |
| `_gemini_latency` | 延迟（ms） |
| `_gemini_sampled` | 实际采样次数 |
| `_gemini_raw` | 每次采样看到的原始值（区域码优先），逗号分隔，用于排查抖动 |

---

## 实测：这个判定有多可靠？（2026-09-10，66 个样本 / 9 个地区）

借手机 Surge 的共享代理出口，让同一台机器逐节点采样实测：

| 地区 | 出口 ISP | Gemini 区域码 | 判定 | 采样稳定性 |
| --- | --- | --- | --- | --- |
| 🇯🇵 日本 | Ikuuu Network | `JPN` | ✅ 可用 | 7/8（1 次抖成 `HKG`）|
| 🇸🇬 新加坡 | Akari Networks | `SGP` | ✅ 可用 | 7/8（1 次抖成 `USA`，同为可用）|
| 🇺🇸 美国 | Back Waves | `USA` | ✅ 可用 | 3/3 稳定 |
| 🇨🇳 中国台湾 | Akari Networks | `TWN` | ✅ 可用 | 7/7 稳定 |
| 🇭🇰 中国香港 | — | `HKG` | ❌ 不支持 | 7/7 稳定 |
| 🇬🇧 英国 | M247 Europe Infra | `CHN` | ❌ 不支持 | 14/14 稳定 |
| 🇦🇷 阿根廷 | Amazon AWS | `CHN` | ❌ 不支持 | 7/7 稳定 |
| 🇹🇷 土耳其 | G-Core Labs | `CHN` | ❌ 不支持 | 3/3 稳定 |
| 🇨🇦 加拿大 | Datacamp | `CHN` | ❌ 不支持 | 6/6 稳定 |

**三条结论**：

1. **单次采样有约 1/8 的偶发抖动**（同一节点偶尔给出别的区域码），会产生假阴性。所以脚本默认 `samples=3` 取多数票：假阴性率从 12.4% 降到 4.3%（`samples=5` 为 1.6%）。
2. **多个机房 / VPN 供应商的 IP 段会被 Gemini 拒绝服务，区域码回落为 `CHN`**。注意这**不代表 Google 认为你在国内**——同一 IP 下 Google 主站完全正常。这类节点"标称地区"看着没问题（英国、阿根廷、土耳其、加拿大），**实际用不了 Gemini**。
   → 所以**判断 Gemini 可用性不能看节点标称地区，只能实测**。
3. 顺带一个排查坑：`chat.openai.com/cdn-cgi/trace` 这类探针会因为 **HTTP 连接复用**而滞后——切到香港节点后，它的出口 IP 还显示上一个日本节点。**要判断节点身份，只认 Gemini 的区域码。**

---

## gpt.js — ChatGPT 检测（改进版）

结构沿用 [xream/scripts 的 gpt.js](https://github.com/xream/scripts/blob/main/surge/modules/sub-store-scripts/check/gpt.js)，判定标准对齐 clash-verge-rev 与 subs-check。

### 相比原版的三处改进

**1. 判定不再依赖状态码与 JSON 字段路径**

原版：

```js
status == 403 && !/unsupported_country/.test(body?.error?.code || body?.error?.error_type || body?.cf_details)
```

两个隐患：

- 三个字段用 `||` 短路，**只取第一个有值的**。若 `error.code` 有值（如 `api_key_invalid`）而 `unsupported_country` 恰恰出现在 `cf_details` 里，就取不到 → **把"地区被封"的节点误判成可用**。
- 状态码**硬编码 `403`**，上游行为一变就会整体误判。

新版：直接对整个响应体做 `/unsupported_country/i` 匹配，只排除 5xx 与空响应，与 `clash-verge-rev chatgpt.rs`、`subs-check openai.go` 完全一致。

**2. 支持双端点，区分「App 可用」与「Web 可用」**

| 端点 | 地址 |
| --- | --- |
| app | `https://ios.chat.openai.com`（Android 客户端为 `android.chat.openai.com`） |
| web | `https://api.openai.com/compliance/cookie_requirements` |

两者都通过 → `[GPT⁺]`；只过一个也各自标记。这正是 subs-check 要分 `GPT⁺` / `GPT` 两级标签的原因。

**3. 请求头与真机对齐**

请求 `ios/android.chat.openai.com` 时带上 ChatGPT App 的 UA 与 `X-Requested-With: com.openai.chatgpt` 等头部（与 subs-check 一致），而不是原版的 Safari UA。可用 `ua` 参数改回。

另新增 `reject_vpn`（默认 `true`，与 subs-check 一致）：响应体命中 `vpn` 关键词时判为不可用。

### 注意事项

- **如果所有节点都被判为不可用**，先试 `reject_vpn=false`（`vpn` 关键词匹配是保守策略）。
- `mode=both` 时 App 与 Web 两次请求**各自独立兜底**：其中一个超时/报错不会影响另一个的检测结果。

### 实测记录（2026-09-10，借手机 Surge 共享代理出网，日本节点）

三个端点全部抓到了真实响应，脚本里的函数直接跑通：

| 端点 | 真实响应 | 脚本判定 |
| --- | --- | --- |
| `gemini.google.com` | 837KB 页面，含 `,2,1,200,"JPN",null,null,"269","658",1,n` | 提取区域码 `JPN` → `ok` ✅ |
| `ios.chat.openai.com` | `403` + `{"cf_details":"Request is not allowed. Please try again later.", "type":"dc"}` | `ok` ✅，并记录 `_gpt_cf_type=dc` |
| `api.openai.com/compliance/cookie_requirements` | `200` + `{"cookie_consent_required":false}` | `ok` ✅ |

**由此确认的两件事**：

1. **区域码法成立** —— 2026 年的 Gemini 页面里该标记依然存在，位置就在 `AF_initDataCallback` 数据中。
2. **发现第三种信号 `type: dc`**（datacenter）——机房 IP 会被 OpenAI 标记。**原版 gpt.js 忽略它，本脚本默认也只记录不判定**。
   ✅ **已验证：该标记不影响可用性。** 机房节点虽然返回 `type: dc`，但实际使用 ChatGPT 完全正常。所以默认 `reject_dc=false` 是对的，不需要按它筛选。

> 对比：**Gemini 侧的同类现象严重得多** —— 部分机房 IP 会被 Gemini *直接拒绝服务*（区域码回落为 `CHN`），见上一节的实测表。同样是"机房 IP 被区别对待"，两边后果完全不同。

### 模式与标签

| `mode` | 检测内容 | 结果标签 |
| --- | --- | --- |
| `app`（默认，同原版） | 仅 App 端点 | `[GPT] ` |
| `web` | 仅 Web 端点 | `[GPT-Web] ` |
| `both` | 两个端点 | 都过 `[GPT⁺] `；仅 App `[GPT] `；仅 Web `[GPT-Web] ` |

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `app` | `app` / `web` / `both` |
| `client` | `iOS` | `iOS` / `Android`（决定 app 端点与 UA） |
| `timeout` / `retries` / `retry_delay` / `concurrency` / `method` | 同 gemini | — |
| `ua` | ChatGPT iOS App UA | app 端点 User-Agent |
| `web_ua` | macOS Chrome | web 端点 User-Agent |
| `app_url` / `web_url` | 见上表 | 自定义端点 |
| `gpt_prefix` | `[GPT] ` | App 可用前缀 |
| `gpt_web_prefix` | `[GPT-Web] ` | 仅 Web 可用前缀 |
| `gpt_plus_prefix` | `[GPT⁺] ` | 两者都可用前缀 |
| `unusable_prefix` | — | 给不可用节点加前缀 |
| `reject_vpn` | `true` | 命中 `vpn` 关键词即判不可用 |
| `reject_dc` | `false` | 命中 CF 的 `type=dc`（机房 IP）即判不可用 |
| `keep_only_ok` | `false` | 只保留可用节点 |
| `include_unsupported_proxy` / `cache` / `disable_failed_cache` | 同上 | — |

### 写入的字段

| 字段 | 说明 |
| --- | --- |
| `_gpt` | App 可用 |
| `_gpt_web` | Web 可用 |
| `_gpt_plus` | 两者都可用 |
| `_gpt_status` | `ok` / `unsupported_country` / `vpn` / `datacenter` / `http_xxx` / `app_failed` / `web_failed` / `failed` / `cached_failed` |
| `_gpt_cf_type` | CF 标记的来源类型（如 `dc` = 机房）。仅 app 端点返回该字段时才有 |
| `_gpt_cf_details` | CF 的原始说明文本 |
| `_gpt_latency` / `_gpt_web_latency` | 对应延迟 |

---

## 附：为什么"抓网页关键词"不可靠

有些面板脚本用"请求 `gemini.google.com/app` 后在 HTML 里搜 `unavailable` / `country` / `不可用` 等关键词"来判断可用性。问题很明显：

1. **关键词过于宽泛**：`country`、`region`、`unsupported`、`不可用` 这类词在 Google 正常页面、i18n 资源、内联 JS 里大量出现，极易误报。
2. **页面是 SPA**：初始 HTML 只是外壳，真正内容靠前端动态加载，命中与否和"地区是否支持"没有稳定关系。
3. **无法区分"入口可达"和"真的能用"**：这类脚本自己也只能输出"入口可达"。
4. **架构不同**：`$httpClient` 面板脚本只能检测**当前策略**，无法逐节点批量检测。

相比之下，"解析区域码"是**结构化判定**：Google 会在页面里明确写出识别到的地区码，直接读它即可，准确且能顺带得到落地地区。

> 注意：区域码法判断的是 **Gemini 网页端在服务端是否对你的出口地区放行**，不检查登录态与账号资格（如 Google AI Pro 订阅）——这类信息无法在不登录的情况下探测。

---

## 致谢 / 参考

- 检测方法与阻断地区列表参考 [clash-verge-rev](https://github.com/clash-verge-rev/clash-verge-rev) 的媒体解锁检测模块
- GPT 脚本结构与端点参考 [xream/scripts](https://github.com/xream/scripts) 的 `sub-store-scripts/check/gpt.js`
- 平台检测思路参考 subs-check 系列项目

## 许可证

本仓库脚本的骨架（并发池、重试、缓存写法）衍生自 [xream/scripts](https://github.com/xream/scripts)（**GPL-3.0**），因此本仓库同样以 **GPL-3.0** 发布，全文见 [LICENSE](LICENSE)。
