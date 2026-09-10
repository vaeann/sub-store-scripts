/**
 * GPT 检测(改进版)
 *
 * 结构沿用 xream/scripts 的 sub-store-scripts/check/gpt.js (GPL-3.0)
 * 判定标准对齐 clash-verge-rev 与 subs-check 的公开实现
 *
 * ── 相比原版 gpt.js 的三处改进 ────────────────────────────
 *
 * 1) 判定不再依赖状态码与 JSON 字段路径
 *
 *    原版:  status == 403 && !/unsupported_country/.test(body?.error?.code || body?.error?.error_type || body?.cf_details)
 *
 *    两个隐患:
 *      a. 三个字段用 `||` 短路 —— 只取"第一个存在且为真"的那个。
 *         如果响应里 error.code 有值(如 api_key_invalid), 而 unsupported_country
 *         出现在 cf_details 里, 就会取不到 -> 把"地区被封"的节点误判成「可用」。
 *      b. 状态码硬编码 403。上游(CF/OpenAI)一旦改成别的状态码, 所有节点会被整体误判。
 *
 *    新版:  直接对整个响应体做 /unsupported_country/i 匹配, 仅排除 5xx 与空响应。
 *          (与 clash-verge-rev chatgpt.rs、subs-check openai.go 完全一致)
 *
 * 2) 支持双端点, 可区分「App 可用」与「Web/API 可用」
 *
 *    app -> https://ios.chat.openai.com                        (原版端点)
 *    web -> https://api.openai.com/compliance/cookie_requirements
 *
 *    两个都通过 => [GPT⁺], 便于筛出"最完整"的节点; 只过一个也能各自标出。
 *    (这就是 subs-check 打 GPT⁺ / GPT 两级标签的原因)
 *
 * 3) 请求头与真机对齐: 请求 ios/android.chat.openai.com 时带上 ChatGPT App 的 UA
 *    与 X-Requested-With: com.openai.chatgpt 等头部(与 subs-check 一致), 而非原版的
 *    Safari UA。可用 ua 参数改回原版行为。
 *
 * 另新增可选的 reject_vpn: 响应体命中 vpn 关键词时判为不可用。
 * 默认开启(与 subs-check 一致), 可用 reject_vpn=false 关闭。
 *
 * 另修正原版的一处隐性问题: 参数布尔值解析。
 * 原版直接 `!!$arguments.x`, 当从 URL query 传 `x=false` 时, 得到的是字符串 "false",
 * `!!"false"` === true —— 开关会失效(例如 cache=false 反而开了缓存)。
 * 本脚本用 bool() 统一解析 true/false/1/0/yes/no/on/off。
 *
 * ── 参数 ─────────────────────────────────────────────────
 * - [mode] 检测模式. app | web | both. 默认 app (与原版行为一致)
 * - [client] app 端点的客户端类型. iOS | Android. 默认 iOS
 * - [timeout] 请求超时(单位: 毫秒) 默认 5000
 * - [retries] 重试次数 默认 1
 * - [retry_delay] 重试延时(单位: 毫秒) 默认 1000
 * - [concurrency] 并发数 默认 10
 * - [method] 请求方法. 默认 get
 * - [ua] app 端点 User-Agent. 默认 ChatGPT iOS App UA
 * - [web_ua] web 端点 User-Agent. 默认 macOS Chrome
 * - [app_url] / [web_url] 自定义端点地址
 * - [gpt_prefix] App 可用时的前缀. 默认 "[GPT] "
 * - [gpt_web_prefix] 仅 Web 可用时的前缀. 默认 "[GPT-Web] "
 * - [gpt_plus_prefix] 两者都可用时的前缀. 默认 "[GPT⁺] "
 * - [unusable_prefix] 给不可用节点也加前缀. 默认不加
 * - [reject_vpn] 命中 vpn 关键词即判不可用. 默认 true (与 subs-check 一致)
 *   若发现所有节点都被判为不可用, 把该项设为 false 再试(reject_vpn=false)
 *
 * 注: mode=both 时, app 与 web 两次请求各自独立兜底 —— 其中一个超时/报错
 *     不会影响另一个的检测结果。
 * - [keep_only_ok] 只保留可用节点. 默认 false
 * - [include_unsupported_proxy] 传递给运行环境时, 包含官方/商店版不支持的协议. 默认不包含
 * - [cache] 使用缓存, 默认不使用缓存
 * - [disable_failed_cache/ignore_failed_error] 禁用失败缓存. 即不缓存失败结果
 *
 * 节点字段(可用于脚本筛选):
 *   _gpt          App 可用
 *   _gpt_web      Web/API 可用
 *   _gpt_plus     两者都可用
 *   _gpt_status   判定结果: ok / unsupported_country / vpn / http_xxx / app_failed / web_failed / failed / cached_failed
 *   _gpt_latency / _gpt_web_latency  对应延迟
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const { isLoon, isSurge, isEgern } = $.env
  if (!isLoon && !isSurge && !isEgern) throw new Error('仅支持 Loon、Surge 和 Egern')

  const mode = ($arguments.mode || 'app').toLowerCase()
  if (mode !== 'app' && mode !== 'web' && mode !== 'both') throw new Error('mode 仅支持 app / web / both')

  const includeUnsupportedProxy = bool($arguments.include_unsupported_proxy, false)
  const cacheEnabled = bool($arguments.cache, false)
  const disableFailedCache =
    bool($arguments.disable_failed_cache, false) || bool($arguments.ignore_failed_error, false)
  const cache = scriptResourceCache

  const gptPrefix = $arguments.gpt_prefix ?? '[GPT] '
  const gptWebPrefix = $arguments.gpt_web_prefix ?? '[GPT-Web] '
  const gptPlusPrefix = $arguments.gpt_plus_prefix ?? '[GPT⁺] '
  const unusablePrefix = $arguments.unusable_prefix
  const rejectVpn = bool($arguments.reject_vpn, true)
  const keepOnlyOk = bool($arguments.keep_only_ok, false)
  const method = $arguments.method || 'get'

  const client = ($arguments.client || 'iOS').toLowerCase() === 'android' ? 'Android' : 'iOS'
  const IOS_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_0 like Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Mobile/16G29 ChatGPT/3.0'
  const ANDROID_UA =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36'
  const CHROME_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

  const appUrl = decode(
    $arguments.app_url || (client === 'Android' ? 'https://android.chat.openai.com' : 'https://ios.chat.openai.com')
  )
  const webUrl = decode($arguments.web_url || 'https://api.openai.com/compliance/cookie_requirements')
  const ua = decode($arguments.ua || (client === 'Android' ? ANDROID_UA : IOS_UA))
  const webUa = decode($arguments.web_ua || CHROME_UA)

  const target = isLoon ? 'Loon' : isEgern ? 'Egern' : isSurge ? 'Surge' : undefined
  const concurrency = parseInt($arguments.concurrency || 10)

  await executeAsyncTasks(
    proxies.map(proxy => () => check(proxy)),
    { concurrency }
  )

  if (keepOnlyOk) return proxies.filter(p => p._gpt || p._gpt_web)

  return proxies

  async function check(proxy) {
    const id = cacheEnabled
      ? `gpt:${mode}:${appUrl}:${webUrl}:${JSON.stringify(
          Object.fromEntries(
            Object.entries(proxy).filter(([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key))
          )
        )}`
      : undefined
    try {
      let node
      if (isEgern) {
        node = JSON.stringify(
          ProxyUtils.produce([proxy], target, 'internal', {
            'include-unsupported-proxy': includeUnsupportedProxy,
          })[0]
        )
      } else {
        node = ProxyUtils.produce([proxy], target, undefined, {
          'include-unsupported-proxy': includeUnsupportedProxy,
        })
      }
      if (!node) return

      if (cacheEnabled) {
        const cached = cache.get(id)
        if (cached) {
          if (cached.ok) {
            applyResult(proxy, cached.app, cached.web, cached.app_latency, cached.web_latency)
            proxy._gpt_status = 'ok'
            $.info(`[${proxy.name}] 使用成功缓存`)
            return
          } else if (disableFailedCache) {
            $.info(`[${proxy.name}] 不使用失败缓存`)
          } else {
            proxy._gpt = false
            proxy._gpt_web = false
            proxy._gpt_status = 'cached_failed'
            if (unusablePrefix) proxy.name = `${unusablePrefix}${proxy.name}`
            $.info(`[${proxy.name}] 使用失败缓存`)
            return
          }
        }
      }

      let appOk = false
      let webOk = false
      let appLatency
      let webLatency
      let reason = null

      if (mode === 'app' || mode === 'both') {
        // 单独兜住异常: 否则 app 请求超时/报错会直接跳过下面的 web 请求
        try {
          const startedAt = Date.now()
          const res = await http({
            method,
            headers: appHeaders(),
            url: appUrl,
            'policy-descriptor': node,
            node,
          })
          appLatency = Date.now() - startedAt
          const judged = judge(res)
          appOk = judged.ok
          if (!judged.ok && !reason) reason = judged.status
          $.info(
            `[${proxy.name}] [app] http: ${statusOf(res)}, result: ${judged.status}, latency: ${appLatency}`
          )
        } catch (e) {
          if (!reason) reason = 'app_failed'
          $.error(`[${proxy.name}] [app] ${e.message ?? e}`)
        }
      }

      if (mode === 'web' || mode === 'both') {
        try {
          const startedAt = Date.now()
          const res = await http({
            method,
            headers: {
              'User-Agent': webUa,
            },
            url: webUrl,
            'policy-descriptor': node,
            node,
          })
          webLatency = Date.now() - startedAt
          const judged = judge(res)
          webOk = judged.ok
          if (!judged.ok && !reason) reason = judged.status
          $.info(
            `[${proxy.name}] [web] http: ${statusOf(res)}, result: ${judged.status}, latency: ${webLatency}`
          )
        } catch (e) {
          if (!reason) reason = 'web_failed'
          $.error(`[${proxy.name}] [web] ${e.message ?? e}`)
        }
      }

      if (appOk || webOk) {
        applyResult(proxy, appOk, webOk, appLatency, webLatency)
        proxy._gpt_status = 'ok'
        if (cacheEnabled) {
          $.info(`[${proxy.name}] 设置成功缓存`)
          cache.set(id, { ok: true, app: appOk, web: webOk, app_latency: appLatency, web_latency: webLatency })
        }
      } else {
        proxy._gpt = false
        proxy._gpt_web = false
        proxy._gpt_plus = false
        proxy._gpt_status = reason || 'failed'
        if (unusablePrefix) proxy.name = `${unusablePrefix}${proxy.name}`
        if (cacheEnabled) {
          $.info(`[${proxy.name}] 设置失败缓存`)
          cache.set(id, {})
        }
      }
    } catch (e) {
      $.error(`[${proxy.name}] ${e.message ?? e}`)
      proxy._gpt = false
      proxy._gpt_web = false
      proxy._gpt_plus = false
      proxy._gpt_status = 'failed'
      if (unusablePrefix) proxy.name = `${unusablePrefix}${proxy.name}`
      if (cacheEnabled) {
        $.info(`[${proxy.name}] 设置失败缓存`)
        cache.set(id, {})
      }
    }
  }

  // 打名字前缀 + 写字段
  function applyResult(proxy, appOk, webOk, appLatency, webLatency) {
    if (appOk && webOk) {
      proxy.name = `${gptPlusPrefix}${proxy.name}`
    } else if (appOk) {
      proxy.name = `${gptPrefix}${proxy.name}`
    } else if (webOk) {
      proxy.name = `${gptWebPrefix}${proxy.name}`
    }

    proxy._gpt = !!appOk
    proxy._gpt_web = !!webOk
    proxy._gpt_plus = !!(appOk && webOk)
    if (appOk) proxy._gpt_latency = appLatency
    if (webOk) proxy._gpt_web_latency = webLatency
  }

  // 判定: 只看响应体特征, 不依赖状态码
  function judge(res) {
    const status = statusOf(res)
    const raw = String(res.body ?? res.rawBody ?? '')
    if (status >= 500) return { ok: false, status: `http_${status}` }
    if (!raw) return { ok: false, status: `http_${status}_empty` }
    const lower = raw.toLowerCase()
    if (lower.indexOf('unsupported_country') > -1) return { ok: false, status: 'unsupported_country' }
    if (rejectVpn && lower.indexOf('vpn') > -1) return { ok: false, status: 'vpn' }
    return { ok: true, status: 'ok' }
  }

  function statusOf(res) {
    return parseInt(res.status ?? res.statusCode ?? 0) || 0
  }

  // 模拟 ChatGPT App 的请求头(与 subs-check 一致)
  function appHeaders() {
    return {
      'User-Agent': ua,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Requested-With': 'com.openai.chatgpt',
      Referer: 'https://chat.openai.com/',
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: 'https://chat.openai.com',
      'Sec-Fetch-Site': 'same-origin',
      'sec-ch-ua-mobile': '?1',
    }
  }

  function decode(value) {
    try {
      return decodeURIComponent(value)
    } catch (e) {
      return value
    }
  }

  // 布尔参数解析: URL query 传进来的都是字符串, 不能直接 !!
  function bool(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue
    if (typeof value === 'boolean') return value
    const s = String(value).trim().toLowerCase()
    if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
    if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
    return defaultValue
  }

  // 请求
  async function http(opt = {}) {
    const METHOD = opt.method || 'get'
    const TIMEOUT = parseFloat(opt.timeout || $arguments.timeout || 5000)
    const RETRIES = parseFloat(opt.retries ?? $arguments.retries ?? 1)
    const RETRY_DELAY = parseFloat(opt.retry_delay ?? $arguments.retry_delay ?? 1000)

    let count = 0
    const fn = async () => {
      try {
        return await $.http[METHOD]({ ...opt, timeout: TIMEOUT })
      } catch (e) {
        // $.error(e)
        if (count < RETRIES) {
          count++
          const delay = RETRY_DELAY * count
          await $.wait(delay)
          return await fn()
        } else {
          throw e
        }
      }
    }
    return await fn()
  }

  function executeAsyncTasks(tasks, { wrap, result, concurrency = 1 } = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        let running = 0
        const results = []

        let index = 0

        function executeNextTask() {
          while (index < tasks.length && running < concurrency) {
            const taskIndex = index++
            const currentTask = tasks[taskIndex]
            running++

            currentTask()
              .then(data => {
                if (result) {
                  results[taskIndex] = wrap ? { data } : data
                }
              })
              .catch(error => {
                if (result) {
                  results[taskIndex] = wrap ? { error } : error
                }
              })
              .finally(() => {
                running--
                executeNextTask()
              })
          }

          if (running === 0) {
            return resolve(result ? results : undefined)
          }
        }

        await executeNextTask()
      } catch (e) {
        reject(e)
      }
    })
  }
}
