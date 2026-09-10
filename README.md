# Sub-Store 脚本集合

Surge / Loon / Egern 用的 **Sub-Store 节点检测脚本**，逐个节点检测服务可用性并给节点打标签。

| 脚本 | 用途 | 判定依据 |
| --- | --- | --- |
| [`gemini.js`](gemini.js) | Gemini 可用性 | 解析 `gemini.google.com` 页面里的落地区域码 |
| [`gpt.js`](gpt.js) | ChatGPT 可用性 | 请求 OpenAI 端点，检查响应体特征 |
| [`surge-panel/sub-info.js`](surge-panel/sub-info.js) | Surge 面板：订阅用量 / 到期时间 | 读取订阅的 `subscription-userinfo` 响应头 |

前两者结构一致，可**串在同一个订阅上**，得到 `[GPT⁺] [Gemini] 香港01` 这样的名称；第三个是 Surge 面板脚本，与订阅处理无关。

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

### 推荐配置（可直接复制）

**① ChatGPT**

```
https://raw.githubusercontent.com/vaeann/sub-store-scripts/main/gpt.js#timeout=1500&retries=1&retry_delay=500&concurrency=15&client=iOS&method=get&gpt_prefix=%5BGPT%5D%20&cache=true&keep_only_ok=true
```

**② Gemini**

```
https://raw.githubusercontent.com/vaeann/sub-store-scripts/main/gemini.js#timeout=6000&retries=0&concurrency=20&method=get&samples=3&gemini_prefix=%5BGemini%5D%20&cache=true&keep_only_ok=true
```

**为什么这么配**

| 选择 | 原因 |
| --- | --- |
| **两个都不写 `disable_failed_cache`** | 这是配合 `produce` + 缓存的关键：写了它，失败节点每次运行都要重测，缓存只省一半，Surge 仍会 `-1001` |
| Gemini `timeout=6000`、`retries=0` | 预检 + 采样已相当于重试；`retries` 只会让死节点多挂几秒 |
| Gemini `concurrency=20` | 单次载荷已从 2~3 次整页降到约 1.2 次，可以放开并发 |
| Gemini `samples=3` | 缓存热了之后基本不跑，精度可以放宽；要更保守用 `samples=5` |
| GPT `timeout=1500` | 端点只返回 77 字节，1.5 秒足够 |

**注意事项**

- **脚本操作顺序**：GPT 放前面、Gemini 放后面（GPT 几十毫秒，Gemini 要下载整页）。
- **`keep_only_ok=true` 的风险**：一旦某次运行所有节点都失败，订阅会变空。缓解办法：保持 `cache=true`（缓存 48 小时），或改用 `unavailable_prefix=%5BX-Gemini%5D%20` 只标记不删。
- **失败节点会被缓存**（不写 `disable_failed_cache` 的代价），默认 48 小时不重测。想让它更快恢复：在 Sub-Store 前端把缓存时长调成 6 小时（或设持久化变量 `sub-store-csr-expiration-time=21600000`），并让 `produce_cronexp` 跑得比它更频繁（如 `0 */2 * * *`）。

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
| `samples` | `3` | 非 ok 时的最大采样次数，取多数票（**建议奇数 3/5**，偶数无优势）|
| `early_exit_ok` | `true` | 首次采样即 ok 就停止（省一半流量）。首次不是 ok 则继续采样，避免抖动误杀 |
| `probe_url` | `https://www.google.com/generate_204` | 轻量预检地址（响应约 0KB）。预检失败或命中 Google 人机验证页就直接判死，跳过整页下载。设 `off` 关闭 |
| `probe_timeout` | `3000` | 预检超时（毫秒）|
| `probe_retries` | `0` | 预检重试次数 |
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
| `_gemini_status` | `ok` / `blocked` / `unknown` / `unreachable` / `captcha` / `failed` / `cached_failed`（`unreachable` = 预检不通；`captcha` = 出口被 Google 限流，返回人机验证页）|
| `_gemini_region` | 区域码（识别到才有），如 `USA` |
| `_gemini_latency` | 延迟（ms） |
| `_gemini_sampled` | 实际采样次数 |
| `_gemini_raw` | 每次采样看到的原始值（区域码优先），逗号分隔，用于排查抖动 |

---

### 性能：为什么它不再容易超时

Gemini 的判定必须下载**整页约 141KB（gzip 后）**，区域码标记位于页面 **94% 处**，服务器还会忽略 `Range` 请求（实测：请求前 60KB 仍返回全量），所以**没法只取一小段**。早期版本在此基础上每个节点还要采样 2~3 次 → 单节点 280~420KB，死节点还会一路挂到超时。

两处优化（默认开启）：

| 优化 | 做法 | 效果 |
| --- | --- | --- |
| **轻量预检** | 先请求 `www.google.com/generate_204`（约 0KB）。连 Google 都不通、或命中 Google 人机验证页（`/sorry/`）的节点，直接判死，**不再下载整页** | 死节点/被限流节点从「141KB × 2~3 次、每次挂满超时」降到「1 次约 0KB、约 3 秒」 |
| **`early_exit_ok`** | 首次采样即 ok 就定论；首次不是 ok 才继续采样 | 可用节点只需 **1 次**整页请求 |

按实测抖动率 1/8 模拟（40 可用 / 7 被封 / 3 死节点）：

| 方案 | 假阴性率 | 平均每节点整页请求 | 平均流量 |
| --- | --- | --- | --- |
| 旧版 `samples=3` | 4.29% | 2.22 次 | 约 313KB |
| **新版 `samples=3`** | **2.93%** | **1.23 次** | **约 173KB** |
| 新版 `samples=5` | 0.97% | 1.41 次 | 约 199KB |

**新版同时做到了更快和更准** —— 因为"首次不是 ok 就必须再确认一次"，等于对每个可疑结果都做了复核。所以现在**推荐 `samples=5`**：比旧版的 `samples=3` 更准（0.97% vs 4.29%），请求数还更少。

> 实测依据：本机采样中，同一节点多次请求会命中**不同的出口 IP**（同一节点同时测到 `103.172.182.27` / `103.151.172.93` / IPv6 三个地址），这正是抖动的来源——轮换出口的节点，不同出口被 Google 判定的地区可能不同。

### 配合 Surge：避免拉订阅时报 `-1001`

`sub.store/download/xxx` 这类链接是**每次请求时实时跑脚本链**的。节点一多，生成一次就很慢——Sub-Store 前端不受超时限制（所以那边看着正常），但 **Surge 拉订阅的超时更短，会直接报 `-1001`**（NSURLErrorTimedOut）。Surge 侧没有可配的订阅超时，正确做法是**让 Sub-Store 提前算好，Surge 拉到缓存**。

**启用 Sub-Store 的「定时处理订阅」(produce)** —— 官方描述：*"一般用于定时处理耗时较长的订阅，以更新缓存。这样 Surge 中拉取的时候就能用到缓存，不至于总是超时。"*

Surge 模块里（模块 → Sub-Store → 编辑参数）：

| 参数 | 默认 | 改成 |
| --- | --- | --- |
| `produce` | `# Sub-Store Produce`（`#` 开头 = **关闭**）| `Sub-Store Produce`（**去掉 `#` 即启用**）|
| `produce_sub` | `sub1,sub2` | **你的订阅 name**（是 name，不是显示名；多个用 `,`）|
| `produce_cronexp` | `50 */6 * * *` | `0 */4 * * *`（建议比缓存有效期更频繁）|

Docker 自建后端用环境变量等价实现：

```
SUB_STORE_PRODUCE_CRON=0 */4 * * *,sub,你的订阅name
```

**必须同时满足**：脚本参数开 `cache=true`，且**不要用 `disable_failed_cache=true`** —— 那个参数会让失败节点每次运行都重新检测，缓存只省一半，"缓存加速"基本失效。

**改完参数后记得更新外部资源**：`script-path` 指向 GitHub releases 上的 `sub-store-1.min.js` / `cron-sync-artifacts.min.js`，Surge 会缓存这些远程脚本。到 **Surge 配置列表里的「外部资源」** 点一次更新，否则可能还在跑旧版本。

**三个容易踩的坑**：

1. ⚠️ **Surge 脚本的 `timeout` 默认只有 5 秒**。如果不用模块参数、而是自己手写 cron 脚本行，**必须显式写 `timeout=900`**，否则任务跑 5 秒就被杀掉。官方模块里是 `timeout={{{timeout}}}`（默认 900），走模块参数则不用管。
2. `produce_sub` / `produce_col` 填的是订阅的 **name，不是显示名（displayName）**；名称若需 `encodeURIComponent` 编码，**编码后再用 `,` 连接**。执行顺序是：先并发跑完所有单条订阅（`sub`），再并发跑组合订阅（`col`）——所以 Gemini 脚本挂在组合订阅上时要填 `produce_col`。
3. 不要在**模块参数**和**手写脚本行**里同时加，会跑两次。

**备选：手写 cron 脚本行**（模块参数里找不到 `produce` 时用；放进自己配置／本地模块的 `[Script]` 段）：

```
Produce = type=cron,cronexp="0 */4 * * *",timeout=900,wake-system=1,script-path=https://github.com/sub-store-org/Sub-Store/releases/latest/download/cron-sync-artifacts.min.js,argument="sub=你的订阅name"
```

**备选：Gist 同步（最稳，但有延迟）** —— 让 Sub-Store 定时把处理好的订阅上传到**自己的私有 Gist**，Surge 直接订阅那个 Gist 的 raw 链接。这样 Surge 拉到的是**静态文件，完全不跑脚本**，永远不会超时。代价是节点更新有延迟（取决于同步周期）。

### 怎么判断缓存到底有没有生效

**方法 1：看运行日志（最直接）。** 每次运行结束会输出一行统计：

```
[gemini] 完成: 共 6 个节点 | 命中成功缓存 4, 命中失败缓存 2, 实际检测 0
```

- **`实际检测 0`** → 全部命中缓存，**一个请求都没发**，说明缓存生效 ✅
- **`实际检测` = 节点总数** → 缓存完全没生效 ❌，检查 `cache=true` 与 Sub-Store 的缓存时长
- 单节点也会有 `[节点名] 使用成功缓存` / `使用失败缓存` 的日志

**方法 2：看耗时。** 在 Sub-Store 前端点该订阅的「预览」：命中缓存会**秒出**；没命中会卡很久（几十秒到几分钟）。所以"第一次慢、后面快"就是缓存生效了。

**方法 3：看 Surge 侧。** 编辑该订阅点「更新」，能正常完成不再 `-1001`，且更新很快。

> **缓存时长不用你自己设** —— Sub-Store 有三层缓存，各有默认值：
>
> | 缓存 | 管什么 | 默认时长 |
> | --- | --- | --- |
> | 远程订阅缓存（`resourceCache`）| 上游机场订阅内容（key = url + UA）| **1 小时** |
> | HTTP 头缓存（`headersResourceCache`）| 流量信息 | 1 分钟 |
> | **脚本缓存（`scriptResourceCache`）** | **本脚本的各节点检测结果 ← 瓶颈在这里** | **48 小时** |
>
> 所以脚本缓存默认有 **48 小时**，produce 每 4~6 小时跑一次完全够用。想改默认时长可设置持久化变量 `sub-store-csr-expiration-time`（单位毫秒，默认 `172800000`）。
>
> **远程链接上的缓存参数**（直接写在上游订阅 URL 的 `#` 后面，单位**秒**）：
>
> | 参数 | 作用 |
> | --- | --- |
> | `#cacheTtl=3600` | 自定义**远程订阅缓存**时长 |
> | `#headersCacheTtl=60` | 自定义流量头缓存时长 |
> | `#noCache` | 禁用缓存读取（⚠️ 每次都会重新拉，不要用在慢的链路上）|
> | `#cacheKey=mykey` | 启用独立的"乐观缓存"命名空间（先返回旧值、后台刷新、失败回退）|
>
> ⚠️ **重要**：缓存是**被动过期**的 —— Sub-Store 没有"到点自动重拉"的内部定时器，只在你**请求订阅时**才检查是否过期。而且 **produce 只负责"把处理过程挪到后台跑"，它不会强制重测**：缓存没过期就照样读缓存。
> 因此 **produce 周期必须小于脚本缓存 TTL**，才能保证"缓存一过期就有人在后台重跑"，App 拉取时才总能命中缓存。
>
> 推荐组合：脚本缓存 TTL **6 小时**（`sub-store-csr-expiration-time=21600000`）+ produce **每 2 小时**（`produce_cronexp=0 */2 * * *`）。
>
> ⚠️ **三件事别做**：
> 1. **不要在脚本前面加 `scriptResourceCache._cleanup(undefined, 3600*1000)`** —— 那是"只保留 1 小时缓存"，会白白破坏 produce 的效果。
> 2. **不要给订阅链接加 `noCache`**（`?noCache=true` 或内部链接 `#noCache`）—— 会让每次拉取都重新检测，必然超时。
> 3. **不要用 `scriptResourceCache.revokeAll()`** —— 会清空全部脚本缓存，下次全部重跑。
>
> 若确实不想用失败缓存（怕节点被误判后长期不重测），就把 `produce_cronexp` 调密一些（如每 1~2 小时），用刷新频率换新鲜度。

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

1. **单次采样有约 1/8 的偶发抖动**（同一节点偶尔给出别的区域码），会产生假阴性。
   → 因此脚本默认 `samples=3` 并对可疑结果复核；开启 `early_exit_ok` 后：`samples=3` 假阴性 **2.9%**、`samples=5` 为 **1.0%**（单次采样是 12.5%）。
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

## surge-panel/sub-info.js — Surge 面板：订阅用量 / 到期

基于 [cc63/Surge](https://github.com/cc63/Surge) 的 `Sub-info.js` 修改而来，读取订阅的 `subscription-userinfo` 响应头，在 Surge 面板上显示用量与到期时间。

### 安装

```ini
[Script]
SubInfo = type=generic,script-path=https://raw.githubusercontent.com/vaeann/sub-store-scripts/main/surge-panel/sub-info.js,timeout=15,argument="url=你的订阅链接&title=订阅信息&seconds=true"

[Panel]
SubInfo = title="订阅信息",content="加载中…",style=info,script-name=SubInfo,update-interval=60
```

⚠️ **`argument` 里的 url 必须 URL 编码**，否则订阅链接自带的 `&` 会把参数切断：

```
https://airport.com/sub?token=abc&flag=clash
→ url=https%3A%2F%2Fairport.com%2Fsub%3Ftoken%3Dabc%26flag%3Dclash
```

（用浏览器控制台跑 `encodeURIComponent('你的订阅链接')` 直接生成即可）

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `url` | — | **必填**，订阅链接（URL 编码后）|
| `title` | `订阅信息` | 面板标题 |
| `icon` / `color` | `tornado` / `#DF4688` | 图标与颜色 |
| `reset_day` | — | 流量重置日 1~31（响应头带 `reset_day` 时可省略）|
| `expire` | — | 手动指定到期时间，覆盖响应头 |
| `seconds` | `true` | **到期时间是否精确到秒**；设 `false` 只显示日期 |
| `ua` | `Quantumult X` | 请求头（用于让机场返回流量信息）|

### 相比上游的改动

**修掉 2 个真 bug**

1. **`formatTime` 里给 `const date` 重新赋值** → `expire` 是日期字符串时抛 `TypeError: Assignment to constant variable`，被外层 catch 吞掉，整块面板变成"订阅信息获取失败"。改成 `let`。
2. **`total=0`（不限量套餐）** → `(used/total)*100` 得到 `Infinity`，面板显示"流量已使用Infinity%"。现在显示"用量：X / 不限量"。

**功能增强**

- **到期时间精确到秒**：`2027-03-05 14:23:45`（上游只到"日"）
- 剩余时间分级显示：`175天22小时` / `1小时32分` / `1分32秒`
- 取不到流量信息时**显示失败原因**，不再静默 `$done({})`
- `getArgs` 改用 `indexOf("=")` 切分，参数值里含 `=` 也不会被截断
- 头解析改用标准 `;` 分隔，`expire` 为日期字符串时不再被截成 NaN
- 支持从响应头读取 `reset_day`；新增 `ua` 参数；`bytesToSize` 增加 NaN 保护

### ⚠️ 许可证

上游 `cc63/Surge` **未声明许可证**（license 字段为 null），本文件属于其修改版，**仅用于自用**，请不要再次分发或公开发布。

---

## 附：节点改名（去掉名字里的某个字符）

比如机场把节点命名成 `日本 A09`，想把那个大写 `A` 去掉。**这跟检测脚本无关**，用 Sub-Store 的节点操作即可，不要动脚本。

**方式一：UI 正则操作（推荐）**

在该订阅的「节点操作」里加一条 **正则删除**（或正则重命名）：

| 字段 | 填 |
| --- | --- |
| 正则 | `\bA(?=\d)` |
| 替换为 | 空 |

→ `日本 A09` 变成 `日本 09`。

> 为什么不用直接删 `A`？因为那样会误伤 `AWS`、`LA`、`USA` 这类名字。`\bA(?=\d)` 的含义是"**独立成词、且后面紧跟数字的 A**"，只命中节点编号前缀。

**方式二：脚本操作（不想点 UI 时）**

加一段脚本操作，**放在检测脚本之前**：

```js
async function operator(proxies = []) {
  proxies.forEach(p => { p.name = p.name.replace(/\bA(?=\d)/g, '') })
  return proxies
}
```

⚠️ **改名会改变节点名**：如果 Surge 的策略组是按精确名称列成员，改完要同步调整；用 `policy-regex-filter` 按正则筛节点的话不受影响。

---

## 致谢 / 参考

- 检测方法与阻断地区列表参考 [clash-verge-rev](https://github.com/clash-verge-rev/clash-verge-rev) 的媒体解锁检测模块
- GPT 脚本结构与端点参考 [xream/scripts](https://github.com/xream/scripts) 的 `sub-store-scripts/check/gpt.js`
- 平台检测思路参考 subs-check 系列项目

## 许可证

本仓库脚本的骨架（并发池、重试、缓存写法）衍生自 [xream/scripts](https://github.com/xream/scripts)（**GPL-3.0**），因此本仓库同样以 **GPL-3.0** 发布，全文见 [LICENSE](LICENSE)。
