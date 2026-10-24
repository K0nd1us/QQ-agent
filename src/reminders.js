// 提醒（闹钟/计时）持久化存储。
// 文件：data/reminders.json
// 每条：{ id, chatKey, text, dueAt, createdAt, createdBy, fired }
//
// 设计：模型通过 set_reminder 工具设定 → 这里落盘 → ReminderScheduler 到点触发。
// 落盘是为了重启不丢：进程重启后调度器会重新加载所有未触发的提醒。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const REMINDER_FILE = path.join(DATA_DIR, 'reminders.json');

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(REMINDER_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.reminders)) return parsed.reminders;
  } catch { /* 新文件 */ }
  return [];
}

function save(reminders) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${REMINDER_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ reminders }, null, 1), 'utf8');
  fs.renameSync(tmp, REMINDER_FILE);
}

export class ReminderStore {
  constructor() {
    this.reminders = load();
  }

  /** 新增一条提醒。返回该提醒。 */
  add({ chatKey, text, dueAt, createdBy = '' }) {
    const entry = {
      id: `r_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
      chatKey: String(chatKey),
      text: String(text ?? '').trim(),
      dueAt: Number(dueAt),
      createdAt: Date.now(),
      createdBy: String(createdBy ?? ''),
      fired: false
    };
    this.reminders.push(entry);
    save(this.reminders);
    return entry;
  }

  /** 列出某会话未触发的提醒（按到期时间升序）。 */
  pending(chatKey = null) {
    return this.reminders
      .filter((r) => !r.fired && (!chatKey || r.chatKey === chatKey))
      .sort((a, b) => a.dueAt - b.dueAt);
  }

  /** 取所有到点且未触发的提醒。 */
  due(now = Date.now()) {
    return this.reminders.filter((r) => !r.fired && r.dueAt <= now);
  }

  /** 标记一条提醒已触发（落盘）。 */
  markFired(id) {
    const r = this.reminders.find((x) => x.id === id);
    if (!r) return false;
    r.fired = true;
    r.firedAt = Date.now();
    save(this.reminders);
    return true;
  }

  /** 取消一条提醒（按 id）。返回是否取消成功。 */
  cancel(id) {
    const before = this.reminders.length;
    this.reminders = this.reminders.filter((x) => x.id !== id);
    if (this.reminders.length < before) {
      save(this.reminders);
      return true;
    }
    return false;
  }

  /** 清理已触发很久的旧提醒（保留最近 200 条已触发的，防文件无限增长）。 */
  prune() {
    const fired = this.reminders.filter((r) => r.fired).sort((a, b) => (b.firedAt || 0) - (a.firedAt || 0));
    const pending = this.reminders.filter((r) => !r.fired);
    if (fired.length > 200) {
      this.reminders = [...pending, ...fired.slice(0, 200)];
      save(this.reminders);
    }
  }
}
