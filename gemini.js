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
 * - [samples] 非 ok 时的最大采样次数, 取多数票. 默认 3
 *   ⚠️ 实测该判定存在约 1/8 的偶发抖动(同一节点偶尔给出别的区域码), 单次采样会产生假阴性。
 *      除首次外, 每个采样都要"再确认一次"才下结论, 因此比单次采样准得多。
 *      按抖动率 1/8 模拟(开启 early_exit_ok): samples=3 -> 假阴性 2.9% / 5 -> 1.0%
 *      平均只需 1.2~1.4 次整页请求(旧版固定 2.2 次)。
 *      设 samples=1 可回到单次采样的轻量模式(假阴性 12.5%, 不推荐)。
 * - [early_exit_ok] 首次采样就 ok 时立即停止采样. 默认 true
 *   依据: 实测抖动只会把"可用节点"偶尔判成 blocked(假阴性), 从未把"不可用节点"判成 ok,
 *   所以首次即为 ok 时可以立即定论。首次不是 ok 则继续采样, 避免单次抖动误杀节点。
 * - [probe_url] 轻量预检地址, 默认 https://www.google.com/generate_204 (响应约 0KB)。
 *   预检"连 Google 都不通"或"命中 Google 人机验证页"时, 直接判为不可用,
 *   跳过 141KB 的整页下载 —— 这是耗时与超时的主要来源。设为 off 可关闭预检。
 * - [probe_timeout] 预检超时(毫秒). 默认 3000
 * - [probe_retries] 预检重试次数. 默认 0 (预检快, 失败即判)
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
 *   _gemini_status   ok / blocked / unknown / unreachable / captcha / failed / cached_failed
 *                    unreachable => 预检不通(节点连 Google 都连不上)
 *                    captcha     => 预检命中 Google 人机验证页(该出口被 Google 限流)
 *   _gemini_region   区域码(能识别到时才有), 如 USA
 *   _gemini_latency  响应延迟(ms, 仅实际请求时)
 *   _gemini_sampled  实际采样次数
 *   _gemini_raw      每次采样看到的原始值(区域码优先), 逗号分隔, 用于排查抖动
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
  const samples = Math.max(1, parseInt($arguments.samples || 3) || 3)
  const earlyExitOk = bool($arguments.early_exit_ok, true)
  const probeRaw = $arguments.probe_url
  const probeUrl =
    probeRaw !== undefined && /^(off|false|no|0)$/i.test(String(probeRaw).trim())
      ? undefined
      : decode(probeRaw || 'https://www.google.com/generate_204')
  const probeTimeout = parseFloat($arguments.probe_timeout || 3000)
  const probeRetries = parseFloat($arguments.probe_retries ?? 0)
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
      ? `gemini:${url}:${samples}:${JSON.stringify(
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
            if (cached.gemini_sampled) proxy._gemini_sampled = cached.gemini_sampled
            if (cached.gemini_raw) proxy._gemini_raw = cached.gemini_raw
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

      // ⓪ 轻量预检: 先花约 0.3s / 0KB 确认这个节点能到 Google。
      //    不通就直接判死, 不再下载 141KB 整页 —— 死节点会一直挂到超时, 是耗时的主要来源。
      if (probeUrl) {
        let probeStatus = 0
        let probeBody = ''
        try {
          const pRes = await http({
            method: 'get',
            headers: {
              'User-Agent': ua,
            },
            url: probeUrl,
            timeout: probeTimeout,
            retries: probeRetries,
            'policy-descriptor': node,
            node,
          })
          probeStatus = parseInt(pRes.status ?? pRes.statusCode ?? 0) || 0
          probeBody = String(pRes.body ?? pRes.rawBody ?? '')
        } catch (e) {
          probeStatus = 0
        }
        const captcha = /google\.[a-z.]+\/sorry|unusual traffic/i.test(probeBody)
        const unreachable = probeStatus === 0 || probeStatus >= 400
        $.info(
          `[${proxy.name}] 预检: http ${probeStatus}${captcha ? ' (命中 Google 人机验证页)' : ''}`
        )
        if (unreachable || captcha) {
          proxy._gemini = false
          proxy._gemini_status = captcha ? 'captcha' : 'unreachable'
          proxy._gemini_sampled = 0
          if (unavailablePrefix) proxy.name = `${unavailablePrefix}${proxy.name}`
          if (cacheEnabled) cache.set(id, {})
          return
        }
      }

      // 请求（多次采样取多数票：该判定存在约 1/6 的偶发抖动，单次采样会产生假阴性）
      const statuses = []
      const regions = []
      let latency = 0
      let lastStatus = 0
      for (let i = 0; i < samples; i++) {
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
        latency = Date.now() - startedAt
        lastStatus = parseInt(res.status ?? res.statusCode ?? 200)
        const body = String(res.body ?? res.rawBody ?? '')

        // 从页面数据中提取区域码
        const region = extractRegion(body)
        if (region) regions.push(region)

        // 拿到区域码 => 页面正常下发, 按地区判断; 否则看 HTTP 状态
        const s = region
          ? BLOCKED_CODES.indexOf(region) > -1
            ? 'blocked'
            : 'ok'
          : lastStatus >= 200 && lastStatus < 400
            ? 'unknown'
            : 'failed'
        statuses.push(s)
        $.info(
          `[${proxy.name}] 采样 ${i + 1}/${samples}: http: ${lastStatus}, region: ${region || '-'}, result: ${s}, latency: ${latency}`
        )

        // 首次采样就得到 ok 则立即定论: 实测抖动只会让可用节点偶尔变 blocked(假阴性),
        // 不会把不可用节点误判成 ok。若首次不是 ok, 则必须继续采样 —— 否则单次抖动就会误杀节点。
        if (earlyExitOk && i === 0 && s === 'ok') break

        // 已经形成多数票就不必再采（samples=3 时通常在 2 次后结束）
        if (i + 1 < samples && topOf(statuses).count >= Math.ceil(samples / 2)) break
      }

      const geminiStatus = topOf(statuses).value
      const region = regions.length ? topOf(regions).value : undefined

      proxy._gemini_status = geminiStatus
      proxy._gemini_sampled = statuses.length
      proxy._gemini_raw = (regions.length ? regions : statuses).join(',')
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
            gemini_sampled: statuses.length,
            gemini_raw: proxy._gemini_raw,
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

  // 取数组里的众数（多数票）
  function topOf(arr) {
    const counter = {}
    let best
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i]
      counter[v] = (counter[v] || 0) + 1
      if (best === undefined || counter[v] > counter[best]) best = v
    }
    return { value: best, count: best === undefined ? 0 : counter[best] }
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
