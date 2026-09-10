/**
 * Gemini 可用性检测 (适配 Surge / Loon / Egern 的 Sub-Store 脚本)
 *
 * 与 gpt.js 写法保持一致, 用于 Sub-Store 的「脚本操作」, 逐个节点检测 Gemini 可用性
 *
 * ── 检测原理 ─────────────────────────────────────────────
 * 通过指定节点请求 https://gemini.google.com , 从页面 bootstrap 数据中提取区域码:
 *
 *     ,2,1,200,"XXX"          XXX 为 ISO 3166-1 alpha-3 区域码 (如 USA / JPN / SGP / HKG / CHN)
 *
 * 区域码不属于不支持地区 => 可用; 属于 => 地区不支持。
 * 当前不支持地区(与上游保持一致): CHN HKG MAC RUS BLR CUB IRN PRK SYR
 *
 * 该方法是 clash-verge-rev / subs-check 等主流工具使用的标准做法, 比"抓网页关键词"可靠得多:
 *   https://github.com/clash-verge-rev/clash-verge-rev
 *     -> crates/clash-verge-media-unlock/src/gemini.rs
 *
 * ── 参数 ─────────────────────────────────────────────────
 * - [timeout] 请求超时(单位: 毫秒) 默认 5000
 * - [retries] 重试次数 默认 1
 * - [retry_delay] 重试延时(单位: 毫秒) 默认 1000
 * - [concurrency] 并发数 默认 10
 * - [method] 请求方法. 默认 get
 * - [url] 检测地址. 默认 https://gemini.google.com (在 URL query 中传参需要 encodeURIComponent)
 * - [ua] 请求头 User-Agent. 默认 macOS Chrome (与上游一致)
 * - [gemini_prefix] 可用节点显示前缀. 默认 "[Gemini] "
 * - [show_region] 显示区域码, 开启后前缀变为 "[Gemini USA] ". 默认关闭
 * - [unavailable_prefix] 给不可用节点也加前缀(如 "[X-Gemini] "). 默认不加
 * - [keep_only_ok] 只保留可用节点. 默认 false (保留全部, 仅打标签)
 * - [include_unsupported_proxy] 传递给运行环境时, 包含官方/商店版不支持的协议. 默认不包含
 * - [cache] 使用缓存, 默认不使用缓存
 * - [disable_failed_cache/ignore_failed_error] 禁用失败缓存. 即不缓存失败结果
 *
 * 注: 节点上总是会添加以下字段, 可用于脚本筛选
 *   _gemini          true / false   是否可用
 *   _gemini_status   ok / blocked / unknown / failed / cached_failed
 *   _gemini_region   区域码(能识别到时才有), 如 USA
 *   _gemini_latency  响应延迟(ms, 仅实际请求时)
 *
 * 关于缓存时长: 若在对应的脚本中使用参数(⚠ 别忘了这个, 一般为 cache, 值设为 true 即可)开启缓存,
 * 可在 Sub-Store 前端(>=2.16.0) 配置各项缓存的默认时长。
 * 也可以在脚本前面添加一个脚本操作(operator2), 保留 1 小时缓存:
 * async function operator(proxies = [], targetPlatform, context) {
 *     scriptResourceCache._cleanup(undefined, 1 * 3600 * 1000);
 * }
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const { isLoon, isSurge, isEgern } = $.env
  if (!isLoon && !isSurge && !isEgern) throw new Error('仅支持 Loon、Surge 和 Egern')

  const includeUnsupportedProxy = bool($arguments.include_unsupported_proxy, false)
  const cacheEnabled = bool($arguments.cache, false)
  const disableFailedCache =
    bool($arguments.disable_failed_cache, false) || bool($arguments.ignore_failed_error, false)
  const cache = scriptResourceCache

  const geminiPrefix = $arguments.gemini_prefix ?? '[Gemini] '
  const unavailablePrefix = $arguments.unavailable_prefix
  const showRegion = bool($arguments.show_region, false)
  const keepOnlyOk = bool($arguments.keep_only_ok, false)
  const method = $arguments.method || 'get'
  const url = decode($arguments.url || 'https://gemini.google.com')
  const ua = decode(
    $arguments.ua ||
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  )
  const target = isLoon ? 'Loon' : isEgern ? 'Egern' : isSurge ? 'Surge' : undefined
  const concurrency = parseInt($arguments.concurrency || 10)

  // Gemini 不支持的地区(ISO 3166-1 alpha-3), 与 clash-verge-rev 保持一致
  const BLOCKED_CODES = ['CHN', 'RUS', 'BLR', 'CUB', 'IRN', 'PRK', 'SYR', 'HKG', 'MAC']
  // 页面中区域码的定位标记: 标记之后紧跟 3 位大写区域码
  const REGION_MARKER = ',2,1,200,"'

  await executeAsyncTasks(
    proxies.map(proxy => () => check(proxy)),
    { concurrency }
  )

  if (keepOnlyOk) return proxies.filter(p => p._gemini)

  return proxies

  async function check(proxy) {
    const id = cacheEnabled
      ? `gemini:${url}:${JSON.stringify(
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
          if (cached.gemini) {
            proxy.name = `${tagPrefix(cached.gemini_region)}${proxy.name}`
            proxy._gemini = true
            proxy._gemini_status = cached.gemini_status || 'ok'
            if (cached.gemini_region) proxy._gemini_region = cached.gemini_region
            proxy._gemini_latency = cached.gemini_latency
            $.info(`[${proxy.name}] 使用成功缓存`)
            return
          } else if (disableFailedCache) {
            $.info(`[${proxy.name}] 不使用失败缓存`)
          } else {
            proxy._gemini = false
            proxy._gemini_status = 'cached_failed'
            if (unavailablePrefix) proxy.name = `${unavailablePrefix}${proxy.name}`
            $.info(`[${proxy.name}] 使用失败缓存`)
            return
          }
        }
      }

      // 请求
      const startedAt = Date.now()
      const res = await http({
        method,
        headers: {
          'User-Agent': ua,
        },
        url,
        'policy-descriptor': node,
        node,
      })
      const status = parseInt(res.status ?? res.statusCode ?? 200)
      const body = String(res.body ?? res.rawBody ?? '')
      const latency = Date.now() - startedAt

      // 从页面数据中提取区域码
      const region = extractRegion(body)

      let geminiStatus
      if (region) {
        // 拿到区域码 => 页面正常下发, 按地区判断
        geminiStatus = BLOCKED_CODES.indexOf(region) > -1 ? 'blocked' : 'ok'
      } else {
        // 没拿到区域码: HTTP 正常但页面异常 => unknown; 请求失败 => failed
        geminiStatus = status >= 200 && status < 400 ? 'unknown' : 'failed'
      }

      $.info(`[${proxy.name}] status: ${status}, region: ${region || '-'}, result: ${geminiStatus}, latency: ${latency}`)

      proxy._gemini_status = geminiStatus
      if (region) proxy._gemini_region = region

      if (geminiStatus === 'ok') {
        proxy.name = `${tagPrefix(region)}${proxy.name}`
        proxy._gemini = true
        proxy._gemini_latency = latency
        if (cacheEnabled) {
          $.info(`[${proxy.name}] 设置成功缓存`)
          cache.set(id, {
            gemini: true,
            gemini_status: geminiStatus,
            gemini_region: region,
            gemini_latency: latency,
          })
        }
      } else {
        proxy._gemini = false
        if (unavailablePrefix) proxy.name = `${unavailablePrefix}${proxy.name}`
        if (cacheEnabled) {
          $.info(`[${proxy.name}] 设置失败缓存`)
          cache.set(id, {})
        }
      }
    } catch (e) {
      $.error(`[${proxy.name}] ${e.message ?? e}`)
      proxy._gemini = false
      proxy._gemini_status = 'failed'
      if (unavailablePrefix) proxy.name = `${unavailablePrefix}${proxy.name}`
      if (cacheEnabled) {
        $.info(`[${proxy.name}] 设置失败缓存`)
        cache.set(id, {})
      }
    }
  }

  // 可用节点前缀
  function tagPrefix(region) {
    if (showRegion) return `[Gemini ${region || '?'}] `
    return geminiPrefix
  }

  // 从页面数据中提取区域码, 找不到返回 undefined
  function extractRegion(body) {
    const index = body.indexOf(REGION_MARKER)
    if (index < 0) return undefined
    const code = body.substr(index + REGION_MARKER.length, 3)
    if (!/^[A-Z]{3}$/.test(code)) return undefined
    if (code === 'UNK') return undefined
    return code
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
