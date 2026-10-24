// 节假日问候：识别中国法定节假日 + 常见节日，供机器人主动发问候。
//
// 设计：不联网、不依赖外部 API —— 内置一份"月份+日期 → 节日"的查表，
// 加上春节/中秋这类农历节日的近似日期（按公历近似，逐年手维护一份小表）。
// 模型通过 check_holiday 工具查询"今天/最近有什么节日"，决定要不要主动问候。
//
// 覆盖：
//   - 公历固定节日（元旦/情人节/劳动节/国庆/圣诞等）
//   - 农历节日（春节/元宵/清明/端午/七夕/中元/中秋/重阳/腊八/除夕）—— 按公历近似表
//   - 节气不在这里（那是另一套，且群友一般不互道节气）

// 公历固定节日：{ 'MM-DD': { name, greeting } }
const SOLAR_HOLIDAYS = {
  '01-01': { name: '元旦', greeting: '新年快乐！新的一年顺顺利利' },
  '02-14': { name: '情人节', greeting: '情人节快乐' },
  '03-08': { name: '妇女节', greeting: '妇女节快乐' },
  '04-01': { name: '愚人节', greeting: '愚人节快乐（今天说话都带点谱）' },
  '05-01': { name: '劳动节', greeting: '劳动节快乐，好好休息' },
  '05-04': { name: '青年节', greeting: '青年节快乐' },
  '06-01': { name: '儿童节', greeting: '儿童节快乐，永远年轻' },
  '09-10': { name: '教师节', greeting: '教师节快乐' },
  '10-01': { name: '国庆节', greeting: '国庆快乐！假期愉快' },
  '10-31': { name: '万圣夜', greeting: '万圣夜快乐，不给糖就捣蛋' },
  '11-01': { name: '万圣节', greeting: '万圣节快乐' },
  '12-24': { name: '平安夜', greeting: '平安夜快乐' },
  '12-25': { name: '圣诞节', greeting: '圣诞快乐' }
};

// 农历节日的公历近似日期（按年维护）。{ 'YYYY-MM-DD': { name, greeting } }
// 来源：公开日历。覆盖 2024-2029，过期后退回"无农历节日"（不影响公历节日）。
// 2028/2029 条目由 lunar-javascript（6tail 天文历算库）离线推算，并与内置
// 2024-2027 旧表逐条交叉验证（16/17 命中）——唯一不一致是 2027 重阳：
// 算法给 10-08（九月初九），旧表写 10-07（那天是初八），**旧表抄错了一天**，
// 一并修正。顺带确认 2027/2029 腊月只有 29 天：除夕落在"腊月廿九"，
// 不是"三十"——这正是这类手维护表最容易抄错的点。
const LUNAR_HOLIDAYS = {
  // 2024
  '2024-02-10': { name: '春节', greeting: '新年快乐！恭喜发财' },
  '2024-02-24': { name: '元宵节', greeting: '元宵节快乐，记得吃汤圆' },
  '2024-04-04': { name: '清明节', greeting: '清明时节，注意出行' },
  '2024-06-10': { name: '端午节', greeting: '端午安康，吃粽子了吗' },
  '2024-08-10': { name: '七夕', greeting: '七夕快乐' },
  '2024-08-18': { name: '中元节', greeting: '中元节' },
  '2024-09-17': { name: '中秋节', greeting: '中秋快乐，人月两团圆' },
  '2024-10-11': { name: '重阳节', greeting: '重阳节快乐' },
  // 2025
  '2025-01-28': { name: '除夕', greeting: '除夕快乐！守岁迎新年' },
  '2025-01-29': { name: '春节', greeting: '新年快乐！蛇年大吉' },
  '2025-02-12': { name: '元宵节', greeting: '元宵节快乐，记得吃汤圆' },
  '2025-04-04': { name: '清明节', greeting: '清明时节，注意出行' },
  '2025-05-31': { name: '端午节', greeting: '端午安康，吃粽子了吗' },
  '2025-08-29': { name: '七夕', greeting: '七夕快乐' },
  '2025-09-06': { name: '中元节', greeting: '中元节' },
  '2025-10-06': { name: '中秋节', greeting: '中秋快乐，人月两团圆' },
  '2025-10-29': { name: '重阳节', greeting: '重阳节快乐' },
  // 2026
  '2026-02-16': { name: '除夕', greeting: '除夕快乐！守岁迎新年' },
  '2026-02-17': { name: '春节', greeting: '新年快乐！马年大吉' },
  '2026-03-03': { name: '元宵节', greeting: '元宵节快乐，记得吃汤圆' },
  '2026-04-05': { name: '清明节', greeting: '清明时节，注意出行' },
  '2026-06-19': { name: '端午节', greeting: '端午安康，吃粽子了吗' },
  '2026-08-19': { name: '七夕', greeting: '七夕快乐' },
  '2026-08-27': { name: '中元节', greeting: '中元节' },
  '2026-09-25': { name: '中秋节', greeting: '中秋快乐，人月两团圆' },
  '2026-10-18': { name: '重阳节', greeting: '重阳节快乐' },
  // 2027（重阳由 10-07 修正为 10-08）
  '2027-02-05': { name: '除夕', greeting: '除夕快乐！守岁迎新年' },
  '2027-02-06': { name: '春节', greeting: '新年快乐！羊年大吉' },
  '2027-02-20': { name: '元宵节', greeting: '元宵节快乐，记得吃汤圆' },
  '2027-04-05': { name: '清明节', greeting: '清明时节，注意出行' },
  '2027-06-09': { name: '端午节', greeting: '端午安康，吃粽子了吗' },
  '2027-08-08': { name: '七夕', greeting: '七夕快乐' },
  '2027-09-15': { name: '中秋节', greeting: '中秋快乐，人月两团圆' },
  '2027-10-08': { name: '重阳节', greeting: '重阳节快乐' },
  // 2028（猴年）
  '2028-01-25': { name: '除夕', greeting: '除夕快乐！守岁迎新年' },
  '2028-01-26': { name: '春节', greeting: '新年快乐！猴年大吉' },
  '2028-02-09': { name: '元宵节', greeting: '元宵节快乐，记得吃汤圆' },
  '2028-04-04': { name: '清明节', greeting: '清明时节，注意出行' },
  '2028-05-28': { name: '端午节', greeting: '端午安康，吃粽子了吗' },
  '2028-08-26': { name: '七夕', greeting: '七夕快乐' },
  '2028-09-03': { name: '中元节', greeting: '中元节' },
  '2028-10-03': { name: '中秋节', greeting: '中秋快乐，人月两团圆' },
  '2028-10-26': { name: '重阳节', greeting: '重阳节快乐' },
  // 2029（鸡年）
  '2029-02-12': { name: '除夕', greeting: '除夕快乐！守岁迎新年' },
  '2029-02-13': { name: '春节', greeting: '新年快乐！鸡年大吉' },
  '2029-02-27': { name: '元宵节', greeting: '元宵节快乐，记得吃汤圆' },
  '2029-04-04': { name: '清明节', greeting: '清明时节，注意出行' },
  '2029-06-16': { name: '端午节', greeting: '端午安康，吃粽子了吗' },
  '2029-08-16': { name: '七夕', greeting: '七夕快乐' },
  '2029-08-24': { name: '中元节', greeting: '中元节' },
  '2029-09-22': { name: '中秋节', greeting: '中秋快乐，人月两团圆' },
  '2029-10-16': { name: '重阳节', greeting: '重阳节快乐' }
};

function pad(n) { return String(n).padStart(2, '0'); }

function keyOf(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function solarKeyOf(d) { return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

/**
 * 查询某天是什么节日。
 * @param {Date} [date=new Date()] 默认今天
 * @returns {{ name, greeting, type: 'solar'|'lunar' } | null}
 */
export function holidayOn(date = new Date()) {
  const lunar = LUNAR_HOLIDAYS[keyOf(date)];
  if (lunar) return { ...lunar, type: 'lunar' };
  const solar = SOLAR_HOLIDAYS[solarKeyOf(date)];
  if (solar) return { ...solar, type: 'solar' };
  return null;
}

/**
 * 查询未来 N 天内最近的节日（含今天）。
 * @param {number} [days=7] 往后查几天
 * @returns {{ name, greeting, type, date, daysAway } | null}
 */
export function upcomingHoliday(days = 7) {
  const now = new Date();
  for (let i = 0; i <= Math.max(0, Number(days) || 7); i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const h = holidayOn(d);
    if (h) return { ...h, date: keyOf(d), daysAway: i };
  }
  return null;
}
