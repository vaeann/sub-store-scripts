/**********
 * Surge 面板脚本：订阅用量 / 到期信息
 * 原作者：cc63 & ChatGPT & Claude（2025-05-03）
 * 上游：https://github.com/cc63/Surge/blob/main/Module/Panel/Sub-info/Moore/Sub-info.js
 * 本文件为**修改版**（上游仓库未声明许可证，仅供自用）
 *
 * ── 本版改动 ────────────────────────────────────────────
 * 1. 【新增】到期时间精确到秒（原版只输出到"日"），可用参数 seconds=false 关掉
 * 2. 【修复】formatTime 中对 const 变量重新赋值 → 日期字符串格式时会抛
 *            TypeError: Assignment to constant variable，进而整块面板报错
 * 3. 【修复】total=0（不限量套餐）时 used/total 变成 Infinity → 显示"已使用Infinity%"
 * 4. 【改进】取不到流量信息时不再静默 $done({})，改为在面板上显示失败原因
 * 5. 【改进】参数解析改用 indexOf("=") 切分，value 里含 "=" 也不会被截断
 * 6. 【改进】剩余时间显示到"天+小时"（不足 1 天显示"小时+分"，不足 1 小时显示"分+秒"）
 * 7. 【改进】bytesToSize 增加 NaN / 非数字保护；支持从响应头读取 reset_day
 * 8. 【新增】ua 参数可覆盖请求头（默认仍是 Quantumult X，用来骗过机场返回流量头）
 *
 * ── 参数 ────────────────────────────────────────────────
 * url=<订阅链接>        必填
 * title=<标题>          默认 "订阅信息"
 * icon=/color=          面板图标与颜色
 * reset_day=<1-31>      流量重置日（响应头带 reset_day 时可省略）
 * expire=<时间戳/日期>   手动指定到期时间（覆盖响应头）
 * seconds=true|false    是否把到期时间精确到秒，默认 true
 * ua=<User-Agent>       默认 "Quantumult X"
 *
 * ── 安装（Surge 面板）────────────────────────────────────
 * [Script]
 * SubInfo = type=generic,script-path=https://raw.githubusercontent.com/vaeann/sub-store-scripts/main/surge-panel/sub-info.js,timeout=15,argument="url=你的订阅链接&title=订阅信息&seconds=true"
 *
 * [Panel]
 * SubInfo = title="订阅信息",content="加载中…",style=info,script-name=SubInfo,update-interval=60
 *
 * ⚠️ argument 里的 url 必须 URL 编码，否则链接自带的 & 会把参数切断：
 *    https://airport.com/sub?token=abc&flag=clash
 *    -> url=https%3A%2F%2Fairport.com%2Fsub%3Ftoken%3Dabc%26flag%3Dclash
 *    （也可用浏览器控制台 encodeURIComponent('https://...') 直接生成）
 **********/

(async () => {
  const args = getArgs();
  const withSeconds = args.seconds === undefined ? true : !/^(0|false|no|off)$/i.test(args.seconds);

  try {
    const info = await getDataInfo(args.url);
    if (!info) {
      return $done({
        title: args.title || "订阅信息",
        content: "未获取到流量信息",
        icon: "exclamationmark.triangle",
        "icon-color": "#CB1B45",
      });
    }

    // 流量
    const total = Number(info.total) || 0;
    const used = (Number(info.download) || 0) + (Number(info.upload) || 0);
    const content = [
      total > 0
        ? `用量：${bytesToSize(used)} / ${bytesToSize(total)}（${((used / total) * 100).toFixed(1)}%）`
        : `用量：${bytesToSize(used)} / 不限量`,
    ];

    // 重置日 / 到期日
    const resetDay = args.reset_day || info.reset_day;
    const resetLeft = resetDay ? getRemainingDays(parseInt(resetDay, 10)) : null;
    const expire = args.expire || info.expire;
    const remainMs = getRemainMs(expire);

    buildNotifications(content, resetLeft, remainMs, expire, withSeconds);

    $done({
      title: args.title || "订阅信息",
      content: content.join("\n"),
      icon: args.icon || "tornado",
      "icon-color": args.color || "#DF4688",
    });
  } catch (error) {
    $done({
      title: args.title || "订阅信息获取失败",
      content: `错误信息：${error && error.message ? error.message : error}`,
      icon: "exclamationmark.triangle",
      "icon-color": "#CB1B45",
    });
  }
})();

/**
 * 构建提示内容
 */
function buildNotifications(content, resetLeft, remainMs, expire, withSeconds) {
  const expired = remainMs !== null && remainMs <= 0;
  const remainText = expired ? null : formatRemain(remainMs);

  if (expired) {
    content.push("提醒：套餐已到期");
  } else if (resetLeft && remainText) {
    content.push(`提醒：${resetLeft}天后重置，${remainText}后到期`);
  } else if (resetLeft) {
    content.push(`提醒：流量将在${resetLeft}天后重置`);
  } else if (remainText) {
    content.push(`提醒：套餐将于${remainText}后到期`);
  }

  if (remainMs !== null) {
    content.push(`到期：${formatTime(expire, withSeconds)}`);
  }
}

/**
 * 解析参数（value 里含 "=" 也不会被截断）
 */
function getArgs() {
  const result = {};
  if (!$argument) return result;
  $argument
    .split("&")
    .forEach((item) => {
      const index = item.indexOf("=");
      const key = index < 0 ? item : item.slice(0, index);
      const raw = index < 0 ? "" : item.slice(index + 1);
      if (!key) return;
      try {
        result[key] = raw ? decodeURIComponent(raw) : null;
      } catch (e) {
        result[key] = raw || null;
      }
    });
  return result;
}

/**
 * 获取订阅的 subscription-userinfo 响应头
 */
function getUserInfo(url, ua) {
  if (!url) return Promise.reject(new Error("未提供有效的订阅链接"));

  return new Promise((resolve, reject) => {
    $httpClient.get({ headers: { "User-Agent": ua || "Quantumult%20X" }, url }, (err, resp) => {
      if (err) return reject(new Error(`网络请求错误：${err}`));
      if (!resp || resp.status !== 200) {
        return reject(new Error(`服务器返回非 200 状态码：${resp && resp.status}`));
      }
      const headers = resp.headers || {};
      const key = Object.keys(headers).find((k) => k.toLowerCase() === "subscription-userinfo");
      if (!key) return reject(new Error("订阅链接响应头不带 subscription-userinfo"));
      resolve(headers[key]);
    });
  });
}

/**
 * 解析流量信息
 * subscription-userinfo 的标准分隔符是 ";"
 * （不用 /(\w+)=[\d.eE+-]+/ 这种数字专用正则，否则 expire 为日期字符串时会被截断）
 */
async function getDataInfo(url) {
  const ua = getArgs().ua;
  const data = await getUserInfo(url, ua);

  const result = {};
  String(data)
    .split(";")
    .forEach((segment) => {
      const index = segment.indexOf("=");
      if (index < 0) return;
      const key = segment.slice(0, index).trim();
      const raw = segment.slice(index + 1).trim();
      if (!key) return;
      result[key] = /^[\d.]+$/.test(raw) ? Number(raw) : raw;
    });

  if (Object.keys(result).length === 0) throw new Error("无法解析 subscription-userinfo 内容");
  return result;
}

/**
 * 计算到下一个"重置日"的剩余天数
 */
function getRemainingDays(resetDay) {
  if (!resetDay || resetDay < 1 || resetDay > 31) return null;

  const now = new Date();
  const today = now.getDate();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();

  const daysInThisMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
  const adjustedResetDay = Math.min(resetDay, daysInThisMonth);

  if (adjustedResetDay > today) return adjustedResetDay - today;

  const daysInNextMonth = new Date(currentYear, currentMonth + 2, 0).getDate();
  const nextMonthResetDay = Math.min(resetDay, daysInNextMonth);
  return daysInThisMonth - today + nextMonthResetDay;
}

/**
 * 把时间戳 / 日期字符串 / 数字字符串 解析成 Date，失败返回 null
 */
function parseDate(time) {
  if (time === undefined || time === null || time === "") return null;

  let value = time;
  if (typeof value !== "number" && /^[\d.]+$/.test(String(value).trim())) {
    value = Number(value);
  }

  if (typeof value === "number") {
    if (!isFinite(value) || value <= 0) return null;
    if (value < 1e11) value *= 1000; // 秒 → 毫秒
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(String(value));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * 距离到期还有多少毫秒（已到期返回负数，无法解析返回 null）
 */
function getRemainMs(expire) {
  const d = parseDate(expire);
  return d ? d.getTime() - Date.now() : null;
}

/**
 * 剩余时间的可读文本（已到期返回 null，由调用方单独处理）
 */
function formatRemain(ms) {
  if (ms === null || ms <= 0) return null;

  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${minutes}分`;
  if (minutes > 0) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

/**
 * 字节转可读大小
 */
function bytesToSize(bytes) {
  const value = Number(bytes);
  if (!isFinite(value) || value <= 0) return "0B";

  const units = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
  const k = 1024;
  const i = Math.min(Math.floor(Math.log(value) / Math.log(k)), units.length - 1);
  return (value / Math.pow(k, i)).toFixed(2) + " " + units[i];
}

/**
 * 格式化到期时间
 *   withSeconds = true  ->  2026-09-10 23:59:59
 *   withSeconds = false ->  2026-09-10
 */
function formatTime(time, withSeconds = true) {
  const d = parseDate(time);
  if (!d) return "未知日期";

  const p = (n) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  if (!withSeconds) return date;
  return `${date} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
