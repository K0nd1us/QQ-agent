import fs from 'node:fs';
import { parseProviderCatalog } from './provider-catalog.js';
import { providerEditPatch, providerModelEditPatch, providerCredentialRevision } from './provider-edit.js';
import { chatIsVisible } from './chat-visibility.js';
import { chatAllowed } from '../kernel/chat-access.js';
import { readArchivedForward } from './forward-adapter.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { serializeChat, serializeSessionDetail, serializeSessionSummary, serializeSkill, serializeStatus } from './serializers.js';
import { deepMerge, sanitizeConfigForApi } from '../kernel/config.js';
import { buildSystemPrompt } from '../kernel/prompt.js';
import { createCompositionLifecycle } from '../kernel/composition-lifecycle.js';
import { safeFetch } from '../kernel/safe-fetch.js';
import { buildToolAvailabilityContext } from '../kernel/tools.js';
import { createMediaDataAdapter, createMemoryConsolidationAdapter, respondJson } from './memory-media-adapters.js';
import { createMemberNoteController } from './member-notes.js';
import { createMemberEditorController } from './member-editor.js';
import { createPersonaTemplateController } from './persona-templates.js';
import { createPersonaByChatController } from './persona-by-chat.js';
import { createFeedbackDraftController } from './feedback-draft.js';
import { createModelPriceController } from './model-price-settings.js';
import { createPeakScheduleController } from './peak-schedule.js';
import { createBlocklistMemberController } from './blocklist-members.js';
import { createBlocklistRawController } from './blocklist-raw.js';
import { createSettingsSaveLifecycleController } from './settings-save-lifecycle.js';
import { createSessionNameController } from './session-names.js';
import { copyTransportReadiness, safeTransportText, transportDiagnosis } from './transport-status.js';
import { personaForChat } from '../kernel/persona.js';
import { unavailable, assertForwardUrl, openDataDir, resetDataDir } from './route-adapters.js';
import { KEY_READ_DENIED_MESSAGE, keyEndpointAllowed } from './key-access.js';
import { createProviderAdapters } from './provider-adapters.js';
import { requestModelEndpoint } from './model-request.js';
import { createPriceUpdateAdapters, resolveCustomPrice, builtinModelPrice, manualModelPrice } from './price-update-adapters.js';
import { createVisionScanAdapter } from './vision-scan-adapter.js';
import { createSearchProviderAdapter } from './search-provider-adapter.js';
import { createCommunityMarketAdapters, extractZipSafely, MARKET_MAX_ZIP_BYTES } from './community-market-adapters.js';
import { APP_ROOT } from '../kernel/env.js';
import { pluginFingerprint, normalizeManifest } from '../kernel/plugin-loader.js';
import { serviceFacade } from '../kernel/service-host.js';

function bad(message, status = 400) {
  throw Object.assign(new Error(message), { expose: true, status });
}

function trimText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function chatKeyOf(raw) {
  const key = decodeURIComponent(String(raw ?? ''));
  if (!/^(group|private)_\d+$/.test(key)) bad('会话标识格式错误');
  return key.replace('_', ':');
}

function memoryKey(kind, id) {
  return `${kind}:${id}`;
}

function emit(deps, name, payload) {
  deps.bus?.emit?.(name, payload);
}

function statusError(err, fallback) {
  const message = String(err?.message ?? fallback);
  bad(message, 502);
}

// 归一化动作调用：走 transport.actions 的平台无关契约；缺失 = 平台不支持 → 501 人话。
function transportAction(transport, name) {
  const fn = transport?.actions?.[name];
  if (typeof fn !== 'function') bad('当前协议端不支持该操作', 501);
  return fn.bind(transport.actions);
}

function providerView(provider, cfg) {
  const storedKey = [cfg.dshProviderKeys?.[provider.id], provider.apiKey].find((value) => typeof value === 'string' && value.trim() && value !== '******');
  const key = storedKey || (provider.apiKeyFrom ? process.env[provider.apiKeyFrom] : '') || '';
  const { apiKey: _ignored, ...safe } = provider;
  return {
    ...safe,
    id: provider.id,
    displayName: provider.displayName ?? provider.name ?? provider.id,
    baseURL: provider.baseURL ?? provider.baseUrl ?? '',
    apiKey: '',
    hasKey: Boolean(key),
    credentialRevision: providerCredentialRevision(provider, cfg),
    apiKeyFrom: storedKey ? 'config' : key ? provider.apiKeyFrom : '',
    needsBaseUrl: true,
    anthropicOrigin: Boolean(provider.anthropicOrigin),
    models: Array.isArray(provider.models) ? provider.models : [],
    modelNames: provider.modelNames && typeof provider.modelNames === 'object' && !Array.isArray(provider.modelNames)
      ? structuredClone(provider.modelNames) : Array.isArray(provider.models) ? provider.models.map((m) => typeof m === 'string' ? m : m.id).filter(Boolean) : [],
  };
}

// Match the actual endpoint, including legacy baseURL fields, without creating
// a second channel merely because the URL has a trailing slash/default port.
function providerEndpointKey(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

function checkProviderEndpoint(provider, body) {
  if (!Object.hasOwn(body ?? {}, 'expectedBaseUrl')) return;
  const expected = typeof body.expectedBaseUrl === 'string' ? providerEndpointKey(body.expectedBaseUrl) : '';
  if (!expected) bad('预期渠道地址无效');
  if (!provider) bad('提供商不存在', 404);
  if (expected !== providerEndpointKey(provider.baseUrl ?? provider.baseURL)) bad('渠道地址已改变，请重新读取目录后再操作', 409);
}

// Append by model ID; richer existing metadata survives string-only discovery,
// while explicitly supplied object fields take precedence on the same ID.
function appendProviderModels(current, incoming) {
  const rows = new Map();
  for (const item of [...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const object = item && typeof item === 'object' && !Array.isArray(item);
    const id = String(object ? item.id ?? item.model ?? '' : typeof item === 'string' ? item : '').trim();
    if (!id) continue;
    const next = object ? { ...structuredClone(item), id } : id;
    const previous = rows.get(id);
    rows.set(id, object ? { ...(previous && typeof previous === 'object' ? previous : {}), ...next }
      : previous && typeof previous === 'object' ? previous : next);
  }
  return [...rows.values()];
}

function appendProviderModelNames(current, incoming) {
  const mapping = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!mapping(current) && !mapping(incoming)) return {};
  return { modelNames: { ...(mapping(current) ? current : {}), ...(mapping(incoming) ? incoming : {}) } };
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function dayKeyOf(ts) {
  const d = new Date(Number(ts) || 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayKeys(range) {
  const raw = String(range ?? '7').trim().toLowerCase();
  const now = new Date(); now.setHours(0, 0, 0, 0);
  if (raw === 'today') return { count: 1, from: now.getTime(), keys: [dayKeyOf(now.getTime())], mode: 'today', rangeLabel: '今天' };
  if (raw === '24h') return { count: 2, from: Date.now() - 86400000, keys: [dayKeyOf(now.getTime() - 86400000), dayKeyOf(now.getTime())], mode: '24h', rangeLabel: '过去 24 小时' };
  if (raw === 'all') return { count: 366, from: 0, keys: Array.from({ length: 366 }, (_, i) => { const d = new Date(now); d.setDate(d.getDate() - (365 - i)); return dayKeyOf(d.getTime()); }), mode: 'all', rangeLabel: '全部记录' };
  const count = Math.max(1, Math.min(366, Number(raw) || 7));
  const out = []; for (let i = count - 1; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); out.push(dayKeyOf(d.getTime())); }
  return { count, from: now.getTime() - (count - 1) * 86400000, keys: out, mode: 'days', rangeLabel: `${count} 天` };
}

function priceFor(model, cfg, deps) {
  const custom = resolveCustomPrice(model, cfg);
  if (custom) return custom;
  const resolver = deps?.resolveModelPrice ?? deps?.priceResolver;
  if (typeof resolver === 'function') {
    try { const p = resolver(model, cfg); if (p) return { ...p, source: p.source ?? 'official' }; } catch { /* provider 隔离 */ }
  }
  return builtinModelPrice(model, cfg) ?? manualModelPrice(cfg);
}

function hourOf(ts) { return new Date(Number(ts) || 0).getHours(); }

function peakHour(ts) {
  const d = new Date((Number(ts) || 0) + 8 * 3600000); const hour = d.getUTCHours(); const dow = d.getUTCDay();
  return dow !== 0 && dow !== 6 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
}

export function usageCost(u, model, at, cfg, deps) {
  const p = priceFor(model, cfg, deps); const prompt = Number(u.promptTokens) || 0; const completion = Number(u.completionTokens) || 0;
  const cached = Math.min(prompt, Math.max(0, Number(u.cachedTokens) || 0)); const fresh = Math.max(0, prompt - cached); const inPeak = peakHour(at); const tier = inPeak && p.peak ? p.peak : p;
  const cachedPrice = tier.cached == null ? tier.in : Number(tier.cached) || 0;
  const freshCost = fresh * (Number(tier.in) || 0) / 1e6; const cachedCost = cached * cachedPrice / 1e6; const outputCost = completion * (Number(tier.out) || 0) / 1e6;
  const peak = inPeak && Boolean(p.peak); const total = freshCost + cachedCost + outputCost;
  return { cost: total, source: p.source, breakdown: { fresh: freshCost, cached: cachedCost, output: outputCost }, prices: { in: Number(tier.in) || 0, out: Number(tier.out) || 0, cached: cachedPrice }, matched: p.matched ?? null, peak, hasPeakTiers: Boolean(p.peak), peakTokens: peak ? prompt + completion : 0, offPeakTokens: peak ? 0 : prompt + completion };
}

function calculateUsageCost(usage, model, at, cfg, deps) {
  const calculate = deps?.components?.['console.usageCost'] ?? usageCost;
  return calculate(usage, model, at, cfg, deps);
}

function fullSessions(dataDir, sessions) {
  const map = new Map();
  const mergeCurrent = (session) => {
    const full = { ...map.get(session.id), ...session }, u = full.usage ?? {};
    full.runs = usageNumber(u.calls) || usageNumber(u.totalTokens, usageNumber(u.promptTokens) + usageNumber(u.completionTokens)) ? 1 : 0;
    map.set(session.id, full);
  };
  try {
    for (const name of fs.readdirSync(path.join(dataDir ?? '', 'usage-days'))) {
      if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
      const archive = readJson(path.join(dataDir, 'usage-days', name));
      if (archive?.version === 1 && archive.records && typeof archive.records === 'object') for (const record of Object.values(archive.records)) if (record?.id) map.set(record.id, { ...record, _usageArchiveRecord: record, _usageLegacyAggregates: Boolean(archive.legacyAggregates) });
    }
  } catch { /* directory not created yet */ }
  try { for (const f of fs.readdirSync(path.join(dataDir ?? '', 'sessions'))) if (f.endsWith('.json')) { const s = sessions.peek?.(f.slice(0, -5)) ?? readJson(path.join(dataDir, 'sessions', f)); if (s?.id) mergeCurrent(s); } } catch { /* 目录不可用 */ }
  for (const s of sessions.listSummaries?.() ?? []) mergeCurrent({ ...s, ...(sessions.peek?.(s.id) ?? {}) });
  return [...map.values()];
}

const providerOf = (session) => String(session.providerId || session.provider || session.vendor || 'direct');
const usageNumber = (value, fallback = 0) => value != null && Number.isFinite(Number(value)) ? Number(value) : fallback;
const usageDifference = (current, previous = {}) => Object.fromEntries(['promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens', 'calls'].map((key) => [key, Math.max(0, usageNumber(current?.[key]) - usageNumber(previous[key]))]));
const modelIdentity = (model, provider = null) => ({ model, provider, modelKey: JSON.stringify([provider, model]) });
function snapshotModels(snapshot) {
  // Old model aggregates have no provider identity. Only durable record
  // contributions can be separated; assigning their baseline to a channel
  // would invent a historical distribution (and can double-count its cost).
  const baseline = snapshot.legacyAggregates ?? snapshot.aggregates;
  const rows = (baseline.models ?? []).map((row) => ({ ...row, ...modelIdentity(row.model ?? 'unknown', row.providerId || row.provider || null) }));
  if (snapshot.legacyAggregates) for (const record of Object.values(snapshot.records ?? {})) {
    const u = usageDifference(record.usage, record.baselineUsage);
    const row = { ...modelIdentity(record.model ?? 'unknown', providerOf(record)), vendor: record.vendor ?? '',
      ...u, token: u.totalTokens, exactCalls: u.calls, runs: Math.max(0, usageNumber(record.runs) - usageNumber(record.baselineRuns)),
      cost: usageNumber(record.contributionCost), peakCost: usageNumber(record.contributionPeakCost), offPeakCost: usageNumber(record.contributionOffPeakCost),
      peakTokens: usageNumber(record.contributionPeakTokens), offPeakTokens: usageNumber(record.contributionOffPeakTokens), hasPeakModel: Boolean(record.costInfo?.hasPeakTiers) };
    if (row.cost || row.totalTokens || row.exactCalls || row.runs) rows.push(row);
  }
  return rows;
}
function legacyUsageContribution(session) {
  const record = session._usageArchiveRecord;
  if (!record || !session._usageLegacyAggregates) return session;
  const toolCounts = Object.fromEntries(Object.entries(usageToolCounts(session)).map(([name, count]) => [name, Math.max(0, usageNumber(count) - usageNumber(record.baselineToolCounts?.[name]))]));
  const contribution = { ...record, usage: usageDifference(record.usage, record.baselineUsage), cost: usageNumber(record.contributionCost),
    peakCost: usageNumber(record.contributionPeakCost), offPeakCost: usageNumber(record.contributionOffPeakCost),
    peakTokens: usageNumber(record.contributionPeakTokens), offPeakTokens: usageNumber(record.contributionOffPeakTokens),
    // Legacy aggregate prices have no component breakdown. Keep the recorded
    // contribution cost, just as the unscoped legacy snapshot path does.
    costInfo: { ...record.costInfo, breakdown: { fresh: 0, cached: 0, output: 0 } } };
  return { ...session, _usageArchiveRecord: contribution, usage: usageDifference(session.usage, record.baselineUsage),
    runs: Math.max(0, usageNumber(session.runs) - usageNumber(record.baselineRuns)),
    webSearchCount: Math.max(0, usageNumber(session.webSearchCount) - usageNumber(record.baselineSearchCount)), messages: [], toolCounts };
}
function usageToolCounts(session) {
  if (!session.messages?.length && session.toolCounts) return session.toolCounts;
  const counts = {};
  for (const message of session.messages ?? []) { const name = message.toolCall?.name ?? message.tool_call?.name; if (name) counts[name] = (counts[name] ?? 0) + 1; }
  return counts;
}

function recordedUsagePrice(session, usage, at, cfg, deps) {
  const archive = session._usageArchiveRecord;
  if (!archive?.costInfo) return calculateUsageCost(usage, session.model ?? 'unknown', at, cfg, deps);
  const increment = calculateUsageCost(usageDifference(usage, archive.usage), session.model ?? 'unknown', at, cfg, deps), original = archive.costInfo;
  return { ...original, cost: usageNumber(archive.cost) + increment.cost,
    peakCost: usageNumber(archive.peakCost) + (increment.peak ? increment.cost : 0), offPeakCost: usageNumber(archive.offPeakCost) + (increment.peak ? 0 : increment.cost),
    peakTokens: usageNumber(archive.peakTokens) + increment.peakTokens, offPeakTokens: usageNumber(archive.offPeakTokens) + increment.offPeakTokens,
    peak: Boolean(original.peak || increment.peak), hasPeakTiers: Boolean(original.hasPeakTiers || increment.hasPeakTiers),
    breakdown: Object.fromEntries(['fresh', 'cached', 'output'].map((key) => [key, usageNumber(original.breakdown?.[key]) + increment.breakdown[key]])),
  };
}

function usageRows(sessions, range, dataDir, cfg, deps, filter = null) {
  const originalRange = String(range ?? '7'); const { from, keys, mode, rangeLabel } = dayKeys(range);
  const records = fullSessions(dataDir, sessions);
  if (mode === 'all') {
    const days = new Set(records.map((record) => dayKeyOf(record.startedAt)));
    try { for (const name of fs.readdirSync(path.join(dataDir ?? '', 'usage-days'))) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) days.add(name.slice(0, -5)); } catch { /* no archived days */ }
    keys.splice(0, keys.length, ...[...days].sort());
  }
  const keySet = new Set(keys); const totals = { cost: 0, peakCost: 0, offPeakCost: 0, peakTokens: 0, offPeakTokens: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, token: 0, runs: 0, exactCalls: 0, cacheHitRate: 0, peakRatio: 0, hasPeakModel: false, source: 'none', breakdown: { fresh: 0, cached: 0, output: 0 }, prices: { in: 0, out: 0, cached: 0 }, matched: null, peak: false, hasPeakTiers: false };
  const byDay = new Map(keys.map((day) => [day, { day, cost: 0, peakCost: 0, offPeakCost: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, token: 0, runs: 0, exactCalls: 0, searchCount: 0 }]));
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, cost: 0, peakCost: 0, offPeakCost: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, token: 0, runs: 0, exactCalls: 0, searchCount: 0 }));
  const chats = new Map(); const models = new Map(); const sessionRows = new Map(); const providers = new Map(); const toolCounts = {}; let searchCount = 0; const snapDays = new Map();
  const add = (s, snapshot = false, scope = 'session') => {
    const u = s.usage ?? s; const at = Number(s.startedAt ?? s.at ?? Date.now()); const modelId = s.model ?? 'unknown'; const modelPrice = recordedUsagePrice(s, u, at, cfg, deps); const cost = s._usageArchiveRecord ? modelPrice.cost : usageNumber(s.cost, modelPrice.cost); const prompt = usageNumber(u.promptTokens); const completion = usageNumber(u.completionTokens); const total = usageNumber(u.totalTokens, prompt + completion); const cached = Math.min(prompt, Math.max(0, usageNumber(u.cachedTokens))); const calls = usageNumber(u.calls ?? s.exactCalls); const run = usageNumber(s.runs, snapshot ? 0 : ((calls || total) > 0 ? 1 : 0));
    const peakCost = usageNumber(modelPrice.peakCost, modelPrice.peak ? cost : 0), offPeakCost = usageNumber(modelPrice.offPeakCost, modelPrice.peak ? 0 : cost);
    const day = dayKeyOf(at); if (!keySet.has(day)) return; if (filter && !filter(s, day, hourOf(at))) return; const hour = hourOf(at); const d = byDay.get(day); const h = byHour[hour];
    if (!snapshot && scope !== 'aggregate') {
      const provider = providerOf(s);
      for (const [map, key, identity] of [[sessionRows, s.id, { sessionId: s.id, chatKey: s.chatKey, model: modelId, provider, startedAt: at }], [providers, provider, { provider }]]) {
        if (key == null) continue;
        const row = map.get(key) ?? { ...identity, cost: 0, token: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, runs: 0, exactCalls: 0, peakCost: 0, offPeakCost: 0, peakTokens: 0, offPeakTokens: 0 };
        row.cost += cost; row.token += total; row.promptTokens += prompt; row.completionTokens += completion; row.cachedTokens += cached; row.totalTokens += total; row.runs += run; row.exactCalls += calls;
        row.peakTokens += modelPrice.peakTokens; row.offPeakTokens += modelPrice.offPeakTokens; row.peakCost += peakCost; row.offPeakCost += offPeakCost; row.hasPeakModel ||= modelPrice.hasPeakTiers;
        row.cacheHitRate = row.promptTokens ? row.cachedTokens / row.promptTokens : 0; map.set(key, row);
      }
    }
    if (scope === 'detail') return;
    for (const row of [totals, d, h]) { row.cost += cost; row.promptTokens += prompt; row.completionTokens += completion; row.totalTokens += total; row.cachedTokens += cached; row.token += total; row.runs += run; row.exactCalls += calls; row.peakTokens = (row.peakTokens || 0) + modelPrice.peakTokens; row.offPeakTokens = (row.offPeakTokens || 0) + modelPrice.offPeakTokens; row.hasPeakModel = Boolean(row.hasPeakModel || modelPrice.hasPeakTiers); row.peakCost = (row.peakCost || 0) + peakCost; row.offPeakCost = (row.offPeakCost || 0) + offPeakCost; }
    const searches = Number(s.webSearchCount ?? s.searchCount) || 0; searchCount += searches; d.searchCount += searches; h.searchCount += searches;
    const chatKey = s.chatKey ?? s.chat ?? 'unknown'; const chat = chats.get(chatKey) ?? { chatKey, cost: 0, token: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, runs: 0, exactCalls: 0 }; Object.assign(chat, { cost: chat.cost + cost, token: chat.token + total, promptTokens: chat.promptTokens + prompt, completionTokens: chat.completionTokens + completion, cachedTokens: chat.cachedTokens + cached, totalTokens: chat.totalTokens + total, runs: chat.runs + run, exactCalls: chat.exactCalls + calls }); chats.set(chatKey, chat);
    const identity = modelIdentity(modelId, providerOf(s)); const m = models.get(identity.modelKey) ?? { ...identity, vendor: s.vendor ?? '', cost: 0, token: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, runs: 0, exactCalls: 0 }; Object.assign(m, { vendor: m.vendor || s.vendor || '', cost: m.cost + cost, token: m.token + total, promptTokens: m.promptTokens + prompt, completionTokens: m.completionTokens + completion, cachedTokens: m.cachedTokens + cached, totalTokens: m.totalTokens + total, runs: m.runs + run, exactCalls: m.exactCalls + calls }); models.set(identity.modelKey, m);
    if (!snapshot) {
      for (const [name, count] of Object.entries(usageToolCounts(s))) toolCounts[name] = (toolCounts[name] ?? 0) + usageNumber(count);
    }
    totals.source = totals.source === 'none' ? modelPrice.source : totals.source === modelPrice.source ? totals.source : 'mixed';
    totals.hasPeakModel = Boolean(totals.hasPeakModel || modelPrice.hasPeakTiers); totals.hasPeakTiers = totals.hasPeakModel; totals.peak = Boolean(totals.peak || modelPrice.peak); totals.matched = totals.matched ?? modelPrice.matched; totals.breakdown.fresh += modelPrice.breakdown.fresh; totals.breakdown.cached += modelPrice.breakdown.cached; totals.breakdown.output += modelPrice.breakdown.output; totals.prices = modelPrice.prices;
  };
  const mergeAgg = (target, row) => { for (const k of ['cost', 'peakCost', 'offPeakCost', 'peakTokens', 'offPeakTokens', 'promptTokens', 'completionTokens', 'cachedTokens', 'totalTokens', 'token', 'runs', 'exactCalls', 'searchCount']) target[k] = (target[k] || 0) + (Number(row?.[k]) || 0); target.hasPeakModel ||= Boolean(row?.hasPeakModel ?? row?.hasPeakTiers); target.hasPeakTiers ||= Boolean(row?.hasPeakModel ?? row?.hasPeakTiers); };
  const mergeTools = (counts) => { for (const [name, count] of Object.entries(counts ?? {})) toolCounts[name] = (toolCounts[name] ?? 0) + (Number(count) || 0); };
  for (const day of keys) {
    if (mode === '24h' || filter?.skipSnapshots || (filter && filter.snapshotDay && !filter.snapshotDay(day))) continue;
    const snap = readJson(path.join(dataDir ?? '', 'usage-days', `${day}.json`));
    if (snap?.version !== 1 || snap.day !== day || !snap.aggregates) continue;
    // 新日档已有完整身份与固定价格，直接合并其记录和运行中会话，避免缓存遮住实时增量。
    if (snap.records && !snap.legacyAggregates) continue;
    const a = snap.aggregates; const snapshotMode = filter?.snapshotMode ?? 'full'; let accepted = false;
    const addGroup = (row, kind, includeTotals = true) => {
      if (!row) return;
      accepted = true; if (includeTotals) mergeAgg(totals, row);
      if (kind === 'chat') { const key = row.chatKey ?? row.chat ?? 'unknown'; const cur = chats.get(key) ?? { chatKey: key, cost: 0, token: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, runs: 0, exactCalls: 0 }; mergeAgg(cur, row); chats.set(key, cur); }
      if (kind === 'model') { const identity = modelIdentity(row.model ?? 'unknown', row.providerId || row.provider || null); const cur = models.get(identity.modelKey) ?? { ...identity, vendor: row.vendor ?? '', cost: 0, token: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, runs: 0, exactCalls: 0 }; mergeAgg(cur, row); models.set(identity.modelKey, cur); }
    };
    if (snapshotMode === 'legacy-model') {
      for (const row of snapshotModels(snap).filter((row) => row.provider == null && String(row.model) === filter.key)) {
        addGroup(row, 'model'); mergeAgg(byDay.get(day), row);
      }
    } else if (snapshotMode === 'full') {
      accepted = true; mergeAgg(totals, a.totals); mergeAgg(byDay.get(day), a.totals);
      for (const row of a.hours ?? []) { const h = byHour[Number(row.hour)]; if (h) mergeAgg(h, row); }
      for (const row of a.chats ?? []) addGroup(row, 'chat', false);
      for (const row of snapshotModels(snap)) addGroup(row, 'model', false);
      searchCount += Number(a.searchCount) || 0; mergeTools(a.toolCounts);
    } else if (snapshotMode === 'day') {
      accepted = true; mergeAgg(totals, a.totals); mergeAgg(byDay.get(day), a.totals);
      for (const row of a.hours ?? []) { const h = byHour[Number(row.hour)]; if (h) mergeAgg(h, row); }
      for (const row of a.chats ?? []) addGroup(row, 'chat', false);
      for (const row of snapshotModels(snap)) addGroup(row, 'model', false);
      searchCount += Number(a.searchCount) || 0; mergeTools(a.toolCounts);
    } else if (snapshotMode === 'chat') addGroup((a.chats ?? []).find((row) => String(row.chatKey ?? row.chat ?? '') === filter.key), 'chat');
    else if (snapshotMode === 'model') for (const row of snapshotModels(snap).filter((row) => String(row.model ?? '') === filter.key)) addGroup(row, 'model');
    else if (snapshotMode === 'hour') { const row = (a.hours ?? []).find((item) => String(item.hour) === filter.key); if (row) { accepted = true; mergeAgg(totals, row); mergeAgg(byHour[Number(row.hour)], row); } }
    if (accepted) snapDays.set(day, snap);
  }
  for (const s of records) {
    if (filter?.legacyOnly) continue;
    const day = dayKeyOf(s.startedAt); if (Number(s.startedAt) < from || !keySet.has(day)) continue;
    const snapshot = snapDays.get(day);
    if (!snapshot) { add(filter?.providerScoped ? legacyUsageContribution(s) : s); continue; }
    add(s, false, 'detail');
    const archived = snapshot.records?.[s.id];
    const baseline = archived?.usage ?? s.usageArchiveBaseline ?? s.accountedUsage ?? (['running', 'waiting'].includes(s.status) ? {} : s.usage);
    const beforeTools = archived?.toolCounts ?? s.usageArchiveBaseline?.toolCounts ?? s.accountedTotals?.toolCounts ?? (['running', 'waiting'].includes(s.status) ? {} : usageToolCounts(s));
    const deltaTools = Object.fromEntries(Object.entries(usageToolCounts(s)).map(([name, count]) => [name, Math.max(0, usageNumber(count) - usageNumber(beforeTools[name]))]));
    add({ ...s, _usageArchiveRecord: null, cost: undefined, usage: usageDifference(s.usage, baseline), runs: archived?.runs || baseline?.counted || baseline?.calls || baseline?.totalTokens ? 0 : usageNumber(s.runs, s.usage?.calls || s.usage?.totalTokens ? 1 : 0), webSearchCount: Math.max(0, usageNumber(s.webSearchCount) - usageNumber(archived?.webSearchCount ?? baseline?.webSearchCount)), messages: [], toolCounts: deltaTools }, false, 'aggregate');
  }
  totals.cacheHitRate = totals.promptTokens ? Math.min(1, Math.max(0, totals.cachedTokens / totals.promptTokens)) : 0; totals.peakRatio = (totals.peakTokens + totals.offPeakTokens) ? totals.peakTokens / (totals.peakTokens + totals.offPeakTokens) : 0;
  for (const row of [ ...byDay.values(), ...byHour ]) { row.cacheHitRate = row.promptTokens ? Math.min(1, Math.max(0, row.cachedTokens / row.promptTokens)) : 0; row.peakRatio = (row.peakTokens + row.offPeakTokens) ? row.peakTokens / (row.peakTokens + row.offPeakTokens) : 0; row.hasPeakModel = Boolean(row.hasPeakModel); }
  return { range: originalRange, rangeLabel, mode, totals, days: [...byDay.values()], hours: byHour, chats: [...chats.values()].sort((a, b) => b.cost - a.cost), models: [...models.values()].sort((a, b) => b.cost - a.cost), sessions: [...sessionRows.values()], providers: [...providers.values()], toolCounts, searchCount };
}

function allowSend(cfg, chatKey) {
  const [kind, id] = chatKey.split(':');
  if ((cfg.deny?.[kind === 'group' ? 'groups' : 'private'] ?? []).map(String).includes(id)) bad('该会话在黑名单内，不能发送', 403);
  if (!chatAllowed(cfg,kind,id)) bad('该会话不在白名单内，不能发送（请先添加白名单，或在选择窗口允许全部）', 403);
}

export function registerConsoleRoutes(http, deps) {
  // transport = 平台提供者（kernel 注入）。兼容键：老调用方可能仍传 onebot。
  const { config, sessions, store, memory, loader, orchestrator, log, capability, registry, permissions, startedAt = Date.now(), version = '0.5.0', appId = 'cn.kondius.qq-agent', dataDir } = deps;
  const transport = deps.transport ?? deps.onebot ?? null;
  const cfg = () => config.get();
  const providerAdapters = createProviderAdapters({ cfg, fetchImpl: deps.fetchImpl, dnsLookup: deps.dnsLookup });
  const visionScan = createVisionScanAdapter({ cfg, config, fetchImpl: deps.fetchImpl, dnsLookup: deps.dnsLookup, emit: (name, payload) => emit(deps, name, payload) });
  const searchProviders = createSearchProviderAdapter({ cfg, config, fetchImpl: deps.fetchImpl, dnsLookup: deps.dnsLookup });
  const priceUpdates = deps.priceUpdates ?? createPriceUpdateAdapters({ dataDir, config, version, fetchImpl: deps.fetchImpl });
  let fallbackPriceUpdates;
  const priceAdapterFor = method => typeof priceUpdates[method] === 'function' ? priceUpdates
    : fallbackPriceUpdates ??= createPriceUpdateAdapters({ dataDir, config, version, fetchImpl: deps.fetchImpl });
  const routeDeps = { ...deps, resolveModelPrice: (model, currentCfg) => priceAdapterFor('resolve').resolve(model, currentCfg) ?? deps.resolveModelPrice?.(model, currentCfg) ?? null };
  deps.bindInstallZip?.(installExtensionZip);
  // Standalone callers predate the capability host. Production resolves the
  // selected service on every request, including after enable/disable or pins.
  const legacyCommunityMarket = !capability && (!deps.marketClient || !deps.communityClient)
    ? createCommunityMarketAdapters({ dataDir, config, fetchImpl: deps.fetchImpl, dnsLookup: deps.dnsLookup, appRoot: deps.appRoot ?? APP_ROOT, communityKey: deps.communityKey, installZip: installExtensionZip }) : null;
  const selectedService = (name) => deps.services
    ? deps.services.get(name) : capability?.providers?.(name)?.[0]?.provider;
  const marketClient = deps.marketClient ?? legacyCommunityMarket ?? serviceFacade(() => selectedService('market.client'), ['listCatalog', 'listAccounts', 'login', 'logout', 'publish', 'install'], { label: '扩展市场' });
  const communityClient = deps.communityClient ?? legacyCommunityMarket ?? serviceFacade(() => selectedService('community.client'), ['getBlocklist', 'updateBlocklist'], { label: '社区屏蔽名单' });
  const quotes = serviceFacade(() => selectedService('community.client'), ['quoteStatus','publishQuote'], { label: '金句发布' });
  const feedback = serviceFacade(() => selectedService('community.client'), ['feedbackStatus','publishFeedback'], { label: '意见收集' });
  const feedbackDraft = (deps.components?.['console.feedbackDraft'] ?? createFeedbackDraftController)({
    dataDir: dataDir ?? (typeof config.file === 'string' ? path.dirname(config.file) : undefined),
    lifecycle: deps.lifecycle, publish: (name, payload) => emit(deps, name, payload),
  });
  const modelPriceSettings = (deps.components?.['console.modelPrices'] ?? createModelPriceController)({
    config, publish: (name, payload) => emit(deps, name, payload),
  });
  const peakSettings = (deps.components?.['console.peakSchedule'] ?? createPeakScheduleController)({
    config, publish: (name, payload) => emit(deps, name, payload),
  });
  const blocklistMembers = (deps.components?.['console.blocklistMembers'] ?? createBlocklistMemberController)({
    config, communityClient, selfId: () => deps.selfId?.() ?? transport?.selfId ?? '',
    resolveCommunity: () => deps.services ? selectedService('community.client')
      : deps.communityClient ?? legacyCommunityMarket ?? selectedService('community.client'),
    publish: (name, payload) => emit(deps, name, payload),
  });
  const blocklistRaw = (deps.components?.['console.blocklistRaw'] ?? createBlocklistRawController)({
    config, publish: (name, payload) => emit(deps, name, payload),
  });
  const sessionNames = (deps.components?.['console.sessionNames'] ?? createSessionNameController)({
    resolveSource: () => ({provider:deps.services ? selectedService('transport.provider') : transport,
      token:deps.services?.token?.('transport.provider')}),
    serviceLeaseOf:deps.serviceLeaseOf,capability,bus:deps.bus,lifecycle:deps.lifecycle,
  });
  async function withSessionNames(rows) {
    let names;
    try { names=await sessionNames.getNames(rows.map(row=>row.chatKey)); } catch { names=null; }
    return rows.map(row=>({...row,chatName:typeof names?.get?.(row.chatKey)==='string'?names.get(row.chatKey):''}));
  }
  const chatNameCache = new Map();
  async function chatNameFor(chatKey) {
    if (!String(chatKey).startsWith('group:')) return '';
    const groupId = Number(String(chatKey).slice(6));
    if (chatNameCache.has(groupId)) return chatNameCache.get(groupId);
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve(transportAction(transport, 'getGroupName')(chatKey)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('群名查询超时')), 3000); }),
      ]);
      const name = String(result ?? '').trim();
      chatNameCache.set(groupId, name);
      return name;
    } catch {
      return '';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const availabilityContext = () => buildToolAvailabilityContext(cfg(), loader);
  const skillView = () => {
    const skills = (loader?.listEntries?.() ?? []).map(serializeSkill);
    return {
      skills,
      summary: { total: skills.length, active: skills.filter((s) => s.active).length, disabled: skills.filter((s) => !s.enabled).length, broken: skills.filter((s) => s.code === 'error').length },
      capabilities: (capability?.names?.() ?? []).map((name) => {
        const detail = capability.explain(name);
        return { ...detail, available: Boolean(detail.exists), reason: detail.exists ? null : '没有可用提供者' };
      }),
      uninstalled: Object.keys(cfg().skills ?? {}).filter((id) => !skills.some((skill) => skill.id === id)),
    };
  };

  // M4 permission ask broker: requests expose only bounded, non-secret summaries.
  http.route('GET', '/api/composition', () => {
    const current = deps.composition;
    return {
      version: current?.version ?? 1, layers: current?.layers ?? [],
      selection: current?.selection ?? { components: {}, ui: { panels: {}, assets: {} } },
      conflicts: current?.conflicts ?? [],
    };
  });
  http.route('GET', '/api/permissions/pending', () => ({ requests: permissions?.pending?.() ?? [] }));
  http.route('POST', '/api/permissions/resolve', ({ body }) => {
    if (typeof body?.requestId !== 'string' || !['once', 'always', 'deny'].includes(body?.decision)) bad('权限请求参数错误');
    const result = permissions?.resolveAsk?.(body.requestId, body.decision);
    if (!result) bad('权限服务不可用', 503);
    if (!result.ok) bad(result.error, 404);
    return result;
  });
  // 注：/api/plugins/:id/permissions 的 GET/POST 由 panel-adapters.js 的
  // registerPanelRoutes 注册（含 bundled 拒绝与 contentCurrent 指纹校验），此处不重复实现。

  // ---- 组件库：控制台背景图 ----
  // 上传只接受常见静态图，按魔数校验（不信扩展名、不信客户端 MIME），
  // 落到数据目录下的 ui/backgrounds/，文件名由服务端生成（防路径穿越）。
  const BG_MAX_BYTES = 8 * 1024 * 1024;
  const BG_TYPES = [
    { ext: 'png', mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
    { ext: 'jpg', mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
    { ext: 'gif', mime: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
    { ext: 'webp', mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46] },
  ];
  function sniffImage(buf) {
    for (const t of BG_TYPES) {
      if (buf.length >= t.magic.length && t.magic.every((b, i) => buf[i] === b)) {
        // webp 还需检查 RIFF....WEBP
        if (t.ext === 'webp' && buf.toString('ascii', 8, 12) !== 'WEBP') continue;
        return t;
      }
    }
    return null;
  }
  const bgDir = () => path.join(dataDir ?? '', 'ui', 'backgrounds');
  // 背景图走静态别名 /ui/backgrounds/ 而非 /api/*：图片要当 CSS background / <img src> 用，
  // <img> 带不了 x-console-token header，走 API 必然 401（预览直接裂图）。
  // kernel 用 extraStaticRoots 把该目录挂到 /ui/backgrounds/，safeJoinStatic 防穿越。
  http.route('POST', '/api/uikit/background', ({ body }) => {
    const raw = String(body?.data ?? '');
    if (!raw) bad('缺少图片数据');
    // data URL（前端 FileReader 产出）或裸 base64
    const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?;base64,(.*)$/i.exec(raw) ?? /^(?:data:)?base64,(.*)$/i.exec(raw);
    const payload = m ? m[m.length - 1] : raw;
    const buf = Buffer.from(String(payload), 'base64');
    if (!buf.length || buf.length > BG_MAX_BYTES) bad(`图片需在 1 字节 ~ ${BG_MAX_BYTES / 1024 / 1024}MB 之间`);
    const type = sniffImage(buf);
    if (!type) bad('只支持 PNG / JPG / GIF / WebP 图片');
    const dir = bgDir();
    fs.mkdirSync(dir, { recursive: true });
    const name = `bg-${crypto.randomBytes(6).toString('hex')}.${type.ext}`;
    fs.writeFileSync(path.join(dir, name), buf);
    return { ok: true, url: `/ui/backgrounds/${name}`, bytes: buf.length, mime: type.mime };
  });
  // 旧路径保留：已存进 config.json 的 /api/uikit/background/xxx 仍要能显示。
  // 注意它是"以 token 换取图片"的受控端点，不能当静态资源用（<img> 带不了 token）。
  http.route('GET', /^\/api\/uikit\/background\/(?<name>[A-Za-z0-9._-]+)$/, ({ params, res }) => {
    // 文件名白名单校验（只允许上面生成的 bg-xxxx.ext），杜绝 ../ 穿越
    if (!/^bg-[a-f0-9]{12}\.(png|jpg|gif|webp)$/.test(params.name)) bad('背景图不存在', 404);
    const file = path.join(bgDir(), params.name);
    if (!fs.existsSync(file)) bad('背景图不存在', 404);
    const buf = fs.readFileSync(file);
    const type = BG_TYPES.find((t) => file.endsWith(t.ext));
    res.writeHead(200, {
      'content-type': type?.mime ?? 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': 'public, max-age=86400',
    });
    res.end(buf);
    // 已自行写响应：http.js 会检查 res.writableEnded，不会再补发 JSON
  });

  // R01-R07: status, usage and price DTOs.
  http.route('GET', '/api/version', () => ({ version, appId, profile: deps.profile?.n }));
  // 账号中心上下文：只读、不含密钥；单号直接运行时 multiAccount=false。
  http.route('GET', '/api/account-context', () => {
    const hubPort = Number(process.env.QQ_AGENT_HUB_PORT) || 0;
    return {
      multiAccount: hubPort > 0,
      accountId: String(process.env.QQ_AGENT_ACCOUNT_ID || ''),
      accountName: String(process.env.QQ_AGENT_ACCOUNT_NAME || ''),
      hubUrl: hubPort > 0 ? `http://127.0.0.1:${hubPort}/` : ''
    };
  });
  http.route('GET', '/api/status', () => {
    const safe = (fn, fallback) => { try { return fn(); } catch (err) { return { ...fallback, error: String(err?.message ?? err) }; } };
    const ob = safe(() => {
      // 优先用内核维护的 status 快照（provider 回调驱动）；否则按 provider 契约实时读一次。
      const snapshot = typeof deps.transportStatus === 'function' ? deps.transportStatus() : null;
      const live = snapshot ?? (typeof transport?.status === 'function' ? transport.status() : {
        connected: !!transport?.connected,
        selfId: transport?.selfId ?? null,
        everConnected: !!transport?.everConnected,
        error: transport?.error ?? null,
      });
      return copyTransportReadiness(live, {
        connected: !!live.connected,
        selfId: typeof deps.selfId === 'function' ? deps.selfId() ?? null : live.selfId ?? null,
        ...(typeof live.selfNickname === 'string' ? { selfNickname: live.selfNickname.slice(0, 200) } : {}),
        everConnected: !!live.everConnected,
        error: live.error == null ? null : safeTransportText(live.error),
        id: live.id ?? transport?.id ?? 'transport',
      });
    }, { connected: false, selfId: null, everConnected: false, error: null, id: 'transport' });
    ob.diagnosis = transportDiagnosis(ob);
    const usage = safe(() => sessions.todayUsage(), { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, runs: 0, webSearchCount: 0 });
    const orch = safe(() => orchestrator?.status?.() ?? {}, {});
    // Today's live session aggregate may not yet be flushed to disk; price it using
    // the currently selected model while historical route stats stay disk-based.
    const todayModel = cfg().api?.model ?? '';
    const todayPrice = safe(() => calculateUsageCost(usage, todayModel, Date.now(), cfg(), routeDeps), { cost: 0, source: 'none', breakdown: { fresh: 0, cached: 0, output: 0 }, prices: { in: 0, out: 0, cached: 0 }, matched: null, peak: false, hasPeakTiers: false });
    const todayPrompt = Number(usage.promptTokens) || 0; const todayCached = Math.min(todayPrompt, Math.max(0, Number(usage.cachedTokens) || 0));
    const cost = { cost: todayPrice.cost ?? 0, source: todayPrice.source ?? 'none', breakdown: todayPrice.breakdown ?? { fresh: 0, cached: 0, output: 0 }, prices: todayPrice.prices ?? { in: 0, out: 0, cached: 0 }, matched: todayPrice.matched ?? null, peak: Boolean(todayPrice.peak), hasPeakTiers: Boolean(todayPrice.hasPeakTiers) };
    const plugins = (loader?.listEntries?.() ?? []).map(serializeSkill);
    const reset = deps.resetStatus?.() ?? null;
    return { ok: true, version, dataDir, uptimeMs: Date.now() - startedAt, onebot: ob, orchestrator: { paused: !!orch.paused, running: orch.running ?? [], waiting: orch.waiting ?? [], consolidating: orch.consolidating ?? false }, usage: { tokens: usage.totalTokens ?? 0, runs: usage.runs ?? 0, search: usage.webSearchCount ?? 0, ...usage }, cost, cacheHitRate: todayPrompt ? Math.min(1, todayCached / todayPrompt) : 0, plugins, ...(reset ? { reset } : {}) };
  });
  http.route('GET', '/api/usage/stats', ({ query }) => { const range = query.range ?? query.days ?? '7'; const stats = usageRows(sessions, range, dataDir, cfg(), routeDeps); return { ok: true, range: String(range), ...stats }; });
  http.route('GET', '/api/usage/breakdown', ({ query }) => {
    const dimensions = ['chat', 'model', 'day', 'hour', 'session', 'provider'];
    const by = dimensions.includes(query.by) ? query.by : 'chat'; const dim = dimensions.includes(query.dim) ? query.dim : null; const key = query.key == null ? null : String(query.key);
    let filter = null;
    if (dim && key != null) {
      filter = (s, day, hour) => dim === 'chat' ? String(s.chatKey ?? s.chat ?? '') === key : dim === 'model' ? String(s.model ?? '') === key : dim === 'day' ? day === key : dim === 'hour' ? String(hour) === key : dim === 'session' ? String(s.id ?? '') === key : providerOf(s) === key;
      filter.key = key;
      filter.snapshotMode = dim === by && !['session', 'provider'].includes(by) ? dim : null;
      // 日快照没有 chat×model/day×hour 交叉明细；这些下钻必须扫描完整 session。
      filter.skipSnapshots = !filter.snapshotMode;
    }
    if (['session', 'provider'].includes(by)) { filter ??= () => true; filter.skipSnapshots = true; }
    const provider = query.provider == null ? null : String(query.provider);
    const legacyOnly = provider === '' && dim === 'model' && key != null;
    if (legacyOnly) {
      // An explicit empty provider scopes the unassigned legacy model row.
      // Only its model/day marginals are known; never fabricate cross tables.
      filter = Object.assign(() => false, { key, snapshotMode: 'legacy-model', legacyOnly: true });
    } else if (provider != null) {
      const previous = filter;
      filter = Object.assign((s, day, hour) => providerOf(s) === provider && (!previous || previous(s, day, hour)), { skipSnapshots: true, providerScoped: true });
    }
    const range = query.range ?? '7'; const stats = usageRows(sessions, range, dataDir, cfg(), routeDeps, filter); const rows = stats[{ chat: 'chats', model: 'models', day: 'days', hour: 'hours', session: 'sessions', provider: 'providers' }[by]]; const showPeak = Boolean(stats.totals.hasPeakModel && (stats.totals.peakCost > 0 || stats.totals.offPeakCost > 0));
    const detailUnavailable = legacyOnly && !['model', 'day'].includes(by);
    const shaped = (detailUnavailable ? [] : rows).map((row) => ({ ...row, key: by === 'session' ? row.sessionId : by === 'provider' ? row.provider : row.chatKey ?? row.model ?? row.day ?? row.hour, cacheHitRate: row.cacheHitRate ?? (row.promptTokens ? Math.min(1, Math.max(0, row.cachedTokens / row.promptTokens)) : 0) }));
    return { ok: true, range: String(range), dim: query.dim ?? '', key: query.key ?? '', by: query.by ?? '', ...(provider == null ? {} : { provider }), ...(detailUnavailable ? { detailUnavailable: true } : {}), totals: stats.totals, rows: shaped.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)), showPeak };
  });
  http.route('GET', '/api/model-prices', ({ query }) => priceAdapterFor('snapshot').snapshot(query.model, {models:query.models,resolveModelPrice:(model,current)=>priceFor(model,current,routeDeps)}));
  http.route('POST', '/api/model-prices/refresh', ({ query }) => priceAdapterFor('refresh').refresh(query.model, {models:query.models,resolveModelPrice:(model,current)=>priceFor(model,current,routeDeps)}));

  http.route('GET', '/api/model-price-overrides', () => modelPriceSettings.get());
  http.route('PUT', '/api/model-price-overrides', ({ body }) => modelPriceSettings.put(body));
  http.route('GET', '/api/peak-schedule', ({ query }) => peakSettings.get(query.target ?? 'global'));
  http.route('PUT', '/api/peak-schedule', ({ body }) => peakSettings.put(body));
  http.route('GET', '/api/blocklist-members', () => blocklistMembers.get());
  http.route('PUT', '/api/blocklist-members', ({ body }) => blocklistMembers.put(body));
  http.route('GET', '/api/blocklist-raw', () => blocklistRaw.get());
  http.route('PUT', '/api/blocklist-raw', ({ body }) => blocklistRaw.put(body));

  // R45-R52: community blocklist and market operations use narrow injected adapters.
  http.route('GET', '/api/community/blocklist', () => communityClient.getBlocklist());
  http.route('GET', '/api/community/quotes/status', () => quotes.quoteStatus());
  http.route('POST', '/api/community/quotes', ({body}) => quotes.publishQuote(body));
  http.route('GET', '/api/community/feedback/status', () => feedback.feedbackStatus());
  http.route('POST', '/api/community/feedback', ({body}) => feedback.publishFeedback(body));
  http.route('GET', '/api/community/feedback-draft', () => feedbackDraft.get());
  http.route('PUT', '/api/community/feedback-draft', ({body}) => feedbackDraft.put(body));
  http.route('DELETE', '/api/community/feedback-draft', ({body}) => feedbackDraft.remove(body));
  http.route('POST', '/api/community/blocklist', async ({ body, res }) => {
    try { const result = await communityClient.updateBlocklist(body); emit(deps, 'status', { communityBlocklistUpdated: true }); return result; }
    catch (err) { respondJson(res, err.status ?? 502, { error: err.message }); }
  });
  http.route('GET', '/api/market/accounts', () => marketClient.listAccounts());
  http.route('GET', '/api/market/catalog', ({ query }) => {
    if (!['skill', 'plugin'].includes(query.kind)) bad('市场类型必须是 skill 或 plugin', 400);
    if (typeof marketClient.listCatalog !== 'function') bad('当前市场提供者暂不支持在线目录，请检查扩展市场服务', 503);
    return marketClient.listCatalog({ kind: query.kind });
  });
  http.route('POST', '/api/market/login', async ({ body }) => marketClient.login(body));
  http.route('POST', '/api/market/logout', async ({ body }) => marketClient.logout(body));
  http.route('POST', '/api/market/publish', async ({ body }) => marketClient.publish(body));
  http.route('POST', '/api/market/install', ({ body }) => marketClient.install(body));

  // R17/R18/R79: direct transport read adapters（走归一化 actions，QQ 语义在 provider 内）。
  http.route('GET', '/api/onebot/groups', async () => {
    try {
      const groups = await transportAction(transport, 'listGroups')();
      return { groups };
    } catch (err) { statusError(err, '获取群列表失败'); }
  });
  http.route('GET', '/api/onebot/friends', async () => {
    try {
      const friends = await transportAction(transport, 'listFriends')();
      return { friends };
    } catch (err) { statusError(err, '获取好友列表失败'); }
  });
  http.route('GET', /^\/api\/groups\/(?<id>\d+)\/members$/, async ({ params }) => {
    try {
      const members = await transportAction(transport, 'getGroupMembers')(params.id);
      members.sort((a, b) => (a.card || a.nickname).localeCompare(b.card || b.nickname, 'zh-CN'));
      return { members };
    } catch (err) { statusError(err, '获取群成员失败'); }
  });

  // R19-R21: builtin templates precede persisted custom templates.
  // The factory card is an asset, not a second hand-written copy of persona text.
  const builtinPersonaText = deps.personaText ?? (() => {
    try { return fs.readFileSync(path.join(APP_ROOT, 'assets', 'personas', 'xiaojingyu.txt'), 'utf8').trimEnd(); }
    catch { return ''; }
  })();
  const templates=(deps.components?.['console.personaTemplates']??createPersonaTemplateController)({
    config,personaText:builtinPersonaText,publish:(name,payload)=>emit(deps,name,payload),
  });
  http.route('GET','/api/persona-templates',()=>templates.list());
  http.route('POST','/api/persona-templates',({body})=>templates.create(body));
  http.route('PUT',/^\/api\/persona-templates\/(?<id>[A-Za-z0-9_-]+)$/,({params,body})=>{
    if(typeof templates.update!=='function')throw Object.assign(new Error('当前人设服务不支持编辑，请复制为新的人设'),{status:501,expose:true});
    return templates.update(params.id,body);
  });
  http.route('DELETE',/^\/api\/persona-templates\/(?<id>[A-Za-z0-9_-]+)$/,({params,body})=>templates.remove(params.id,body));
  const chatPersonas=(deps.components?.['console.personaByChat']??createPersonaByChatController)({
    config,store,resolvePersona:deps.components?.['core.prompt.persona']??personaForChat,getTemplates:()=>templates.list(),publish:(name,payload)=>emit(deps,name,payload),
  });
  http.route('GET','/api/persona-by-chat',()=>chatPersonas.list());
  http.route('GET',/^\/api\/persona-by-chat\/(?<kind>group|private)_(?<id>[1-9]\d{0,14})$/,({params,query})=>chatPersonas.get(memoryKey(params.kind,params.id),query.storageKey));
  http.route('PUT',/^\/api\/persona-by-chat\/(?<kind>group|private)_(?<id>[1-9]\d{0,14})$/,({params,body})=>chatPersonas.put(memoryKey(params.kind,params.id),body));

  // R22-R35: provider credentials and catalog management.
  const requireTrustedKeyRead = (req) => {
    if (!keyEndpointAllowed(req, cfg().server?.token ?? '')) bad(KEY_READ_DENIED_MESSAGE, 403);
  };
  http.route('GET', '/api/providers', () => ({ providers: (cfg().providers ?? []).map((provider) => providerView(provider, cfg())), source: cfg().providersSourceYaml ?? '' }));
  http.route('POST', '/api/providers/import', ({ body }) => {
    let parsed; try { parsed = parseProviderCatalog(body?.source); } catch (error) { bad(error.message); }
    const old = cfg().providers ?? [];
    const providers = body?.replace === true ? parsed.providers : [...old.filter((item) => !parsed.providers.some((next) => next.id === item.id)), ...parsed.providers];
    const ids = new Set(providers.map((item) => item.id));
    const keys = Object.fromEntries(Object.entries({ ...(cfg().dshProviderKeys ?? {}), ...parsed.keys }).filter(([id]) => ids.has(id)));
    const current = cfg().api ?? {}, importedCurrent = parsed.providers.find((provider) => provider.id === current.provider);
    const api = current.provider && !ids.has(current.provider) ? { provider: '', model: '', baseUrl: '' } : importedCurrent ? { baseUrl: importedCurrent.baseUrl, ...(!importedCurrent.models.includes(current.model) ? { model: '' } : {}) } : {};
    config.update({ providers, dshProviderKeys: { __replace__: keys }, providersSourceYaml: parsed.source, api });
    return { ok: true, providers: providers.map((provider) => providerView(provider, cfg())), imported: parsed.providers.length };
  });
  http.route('GET', '/api/providers/key', ({ req, query }) => {
    requireTrustedKeyRead(req);
    const provider = cfg().providers?.find((item) => item.id === query.providerId);
    return { apiKey: [cfg().dshProviderKeys?.[query.providerId], provider?.apiKey, provider?.apiKeyFrom && process.env[provider.apiKeyFrom]].find((value) => typeof value === 'string' && value.trim() && value !== '******') ?? '' };
  });
  http.route('GET', '/api/api-key', ({ req }) => {
    requireTrustedKeyRead(req);
    return { apiKey: cfg().api?.apiKey ?? '' };
  });
  http.route('GET', '/api/search-key', ({ req, query }) => {
    requireTrustedKeyRead(req);
    const field = query.field ?? ''; const source = field.startsWith('custom:') ? cfg().webSearch?.providers?.find((provider) => provider.id === field.slice(7)) : cfg().webSearch?.[field];
    if (!source || !['deepseek', 'zhipu', 'bocha', 'baidu', 'metaso'].includes(field) && !field.startsWith('custom:')) bad(`未知搜索服务：${field}`);
    const envKeys = { deepseek: 'DEEPSEEK_API_KEY', zhipu: 'ZHIPU_API_KEY', bocha: 'BOCHA_API_KEY', baidu: 'BAIDU_SEARCH_API_KEY', metaso: 'METASO_API_KEY' };
    const apiKey = source?.apiKey || (envKeys[field] ? process.env[envKeys[field]] : '') || '';
    return { apiKey, hasApiKey: Boolean(apiKey) };
  });
  http.route('GET', '/api/onebot-token', ({ req, query }) => {
    requireTrustedKeyRead(req);
    if (query.which === 'ws') return { token: cfg().onebot?.accessToken ?? '' };
    if (query.which === 'http') return { token: cfg().onebot?.httpAccessToken ?? '' };
    bad(`未知令牌类型：${query.which}`);
  });
  http.route('POST', '/api/providers/fetch-models', async ({ body, res }) => {
    checkProviderEndpoint((cfg().providers ?? []).find(p => p.id === body?.providerId), body);
    try { return { ok: true, models: await providerAdapters.fetchModels(body) }; }
    catch (err) { respondJson(res, 502, { ok: false, error: String(err?.message ?? err) }); }
  });
  http.route('POST', '/api/providers/test-one', async ({ body }) => ({ ok: true, result: await providerAdapters.testProvider(body) }));
  http.route('POST', '/api/providers/test-chat', async ({ body }) => {
    if (body?.expectedBaseUrl !== undefined) checkProviderEndpoint((cfg().providers ?? []).find(p => p.id === body?.providerId), body);
    const result = await providerAdapters.testChat(body);
    return { ok: true, result, thinking: providerAdapters.detectThinking(body?.baseUrl, body?.model) ?? null };
  });
  http.route('POST', '/api/providers/test-all', async () => ({ ok: true, ...(await providerAdapters.testAll()) }));
  http.route('POST', '/api/providers', ({ body }) => {
    const inputUrl = trimText(body?.baseUrl ?? body?.baseURL, 1000);
    if (!inputUrl) bad('Base URL 不能为空');
    const baseUrl = providerEndpointKey(inputUrl);
    if (!baseUrl) bad('Base URL 必须是有效的 http(s) 地址');
    const current = cfg().providers ?? [];
    const index = current.findIndex(provider => providerEndpointKey(provider.baseUrl ?? provider.baseURL) === baseUrl);
    const existing = index >= 0 ? current[index] : null;
    const id = existing?.id || trimText(body?.id, 80) || `provider_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    if (!existing && current.some(provider => provider.id === id)) bad('提供商已存在');
    const provider = { ...existing, id, displayName: trimText(body?.displayName ?? body?.name, 100) || existing?.displayName || existing?.name || id,
      baseUrl, ...(existing && Object.hasOwn(existing, 'baseURL') ? { baseURL: baseUrl } : {}),
      models: appendProviderModels(existing?.models, body?.models), ...appendProviderModelNames(existing?.modelNames, body?.modelNames) };
    const keys = { ...(cfg().dshProviderKeys ?? {}) };
    // Blank/masked Add forms do not clear a channel already found by endpoint;
    // deleting a key remains the explicit set-key operation.
    if (typeof body?.apiKey === 'string' && body.apiKey.trim() && body.apiKey.trim() !== '******') keys[id] = body.apiKey.trim();
    const providers = structuredClone(current);
    if (existing) providers[index] = provider; else providers.push(provider);
    config.update({ providers, dshProviderKeys: keys });
    return { ok: true, provider: providerView(provider, cfg()), created: id };
  });
  http.route('POST', '/api/providers/update', ({ body }) => {
    const patch = providerEditPatch(cfg(), body);
    if (patch) config.update(patch);
    return { ok: true, provider: providerView(cfg().providers.find(p => p.id === body.providerId), cfg()) };
  });
  http.route('POST', '/api/providers/models', ({ body }) => {
    const index = (cfg().providers ?? []).findIndex((provider) => provider.id === body?.providerId);
    if (index < 0) bad('提供商不存在', 404);
    const providers = structuredClone(cfg().providers);
    checkProviderEndpoint(providers[index], body);
    const existing = new Set((Array.isArray(providers[index].models) ? providers[index].models : []).map(m => typeof m === 'string' ? m.trim() : String(m?.id ?? m?.model ?? '').trim()));
    const incoming = body?.onlyMissing === true ? (Array.isArray(body.models) ? body.models : []).filter(m => !existing.has(typeof m === 'string' ? m.trim() : String(m?.id ?? m?.model ?? '').trim())) : body?.models;
    if (body?.onlyMissing === true && !incoming.length) return {ok: true, provider: providerView(providers[index], cfg())};
    const accepted = new Set((Array.isArray(incoming) ? incoming : []).map(m => typeof m === 'string' ? m.trim() : String(m?.id ?? m?.model ?? '').trim()));
    const names = body?.onlyMissing === true ? Object.fromEntries(Object.entries(body.modelNames && typeof body.modelNames === 'object' && !Array.isArray(body.modelNames) ? body.modelNames : {}).filter(([id]) => accepted.has(id))) : body?.modelNames;
    providers[index].models = appendProviderModels(providers[index].models, incoming);
    Object.assign(providers[index], appendProviderModelNames(providers[index].modelNames, names));
    config.update({ providers }); return { ok: true, provider: providerView(providers[index], cfg()) };
  });
  http.route('POST', '/api/providers/models/update', ({ body }) => {
    const patch = providerModelEditPatch(cfg(), body);
    if (patch) config.update(patch);
    return { ok: true, provider: providerView(cfg().providers.find(p => p.id === body.providerId), cfg()) };
  });
  http.route('DELETE', '/api/providers/models', ({ body }) => {
    const providers = structuredClone(cfg().providers ?? []); const provider = providers.find((item) => item.id === body?.providerId);
    const index = provider?.models?.findIndex((model) => (typeof model === 'string' ? model : model.id) === body?.modelId) ?? -1;
    if (!provider || index < 0) bad('提供商或模型不存在', 404);
    checkProviderEndpoint(provider, body);
    provider.models.splice(index, 1);
    if (provider.modelNames && typeof provider.modelNames === 'object' && !Array.isArray(provider.modelNames)) delete provider.modelNames[body.modelId];
    config.update({ providers }); return { ok: true };
  });
  http.route('POST', '/api/providers/set-key', ({ body }) => {
    if (!(cfg().providers ?? []).some((provider) => provider.id === body?.providerId)) bad('提供商不存在', 404);
    checkProviderEndpoint((cfg().providers ?? []).find(provider => provider.id === body.providerId), body);
    if (typeof body?.apiKey !== 'string' || body.apiKey === '******') bad('请提供新密钥或空串清除');
    const keys = { ...(cfg().dshProviderKeys ?? {}) }; if (body?.apiKey === '') delete keys[body.providerId]; else keys[body.providerId] = String(body?.apiKey ?? '');
    const providers = body.apiKey === '' ? cfg().providers.map((provider) => provider.id === body.providerId ? { ...provider, apiKey: '', apiKeyFrom: '' } : provider) : cfg().providers;
    config.update({ dshProviderKeys: { __replace__: keys }, providers });
    const view = providerView(providers.find((provider) => provider.id === body.providerId), cfg());
    return { ok: true, hasKey: view.hasKey, credentialRevision: view.credentialRevision };
  });
  http.route('DELETE', '/api/providers', ({ body }) => {
    const providers = (cfg().providers ?? []).filter((provider) => provider.id !== body?.providerId);
    if (providers.length === (cfg().providers ?? []).length) bad('提供商不存在', 404);
    const keys = { ...(cfg().dshProviderKeys ?? {}) }; delete keys[body.providerId];
    const api = { ...(cfg().api ?? {}) }; if (api.provider === body.providerId) { api.provider = ''; api.model = ''; api.baseUrl = ''; }
    config.update({ providers, dshProviderKeys: { __replace__: keys }, api }); return { ok: true };
  });
  // R36-R41: asynchronous vision capability scans and custom search providers.
  http.route('GET', '/api/vision/results', () => ({ results: visionScan.snapshot(), scanning: visionScan.running }));
  http.route('POST', '/api/vision/scan', ({ body, res }) => {
    if (visionScan.running) { respondJson(res, 409, { ok: false, error: '已有一次扫描正在进行' }); return; }
    const providerIds = Array.isArray(body?.providerIds) ? body.providerIds : null;
    visionScan.scan({ onlyProviderIds: providerIds, timeoutMs: 25_000, limit: 3 }).catch(() => {});
    respondJson(res, 202, { ok: true, started: true });
  });
  http.route('GET', '/api/search-providers', () => ({ providers: searchProviders.list() }));
  http.route('POST', '/api/search-providers', ({ body, res }) => {
    try { return { ok: true, provider: searchProviders.upsert(body) }; }
    catch (err) { respondJson(res, 400, { ok: false, error: String(err?.message ?? err) }); }
  });
  const removeSearchProvider = ({ body, res }) => {
    try { searchProviders.remove(body?.id); return { ok: true }; }
    catch (err) { respondJson(res, 400, { ok: false, error: String(err?.message ?? err) }); }
  };
  http.route('DELETE', '/api/search-providers', removeSearchProvider);
  http.route('DELETE', '/api/search-provider', removeSearchProvider);
  http.route('POST', '/api/search-providers/test', async ({ body }) => ({ ok: true, result: await searchProviders.test(body?.providerId || null) }));

  // R42-R44 and R53-R63.
  http.route('POST', '/api/test/api', async () => providerAdapters.testApi());
  http.route('GET', '/api/config', () => sanitizeConfigForApi(cfg()));
  http.route('GET', '/api/ui/list-layout', () => ({width: Math.round(Math.min(520, Math.max(180, Number(cfg().ui?.listWidth) || 288)))}));
  http.route('POST', '/api/ui/list-layout', ({ body }) => {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'width') || !Number.isInteger(body.width) || body.width < 180 || body.width > 520) bad('列表宽度须为180至520之间的整数');
    config.update({ui: {listWidth: body.width}});
    return {width: body.width};
  });
  http.route('*', '/api/prompt-preview', async ({ body = {} }) => {
    const patch = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const current = deepMerge(structuredClone(cfg()), patch);
    const context = buildToolAvailabilityContext(current, loader);
    const tools = (registry?.list?.() ?? []).filter((tool) => {
      try { return registry?.availability?.(tool.id, context)?.ok ?? true; }
      catch { return false; }
    }).map((tool) => ({ id: tool.id, name: tool.name ?? tool.id, description: tool.description ?? '', category: tool.category ?? null }));
    const skillSections = await loader?.promptSections?.() ?? [];
    const systemPromptFor = deps.components?.['core.prompt.system'] ?? buildSystemPrompt;
    const systemPrompt = await systemPromptFor({ lifecycle: deps.lifecycle, cfg: current, skillSections, extraSections: [] });
    return { systemPrompt, tools };
  });
  function applyConfigPatch(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) bad('配置必须是对象');
    if (['blocklist', 'globalBlocklist', 'communityExemptions'].some(key => Object.hasOwn(body, key))) bad('原始名单请通过专用编辑器保存，以防覆盖较新的成员修改');
    config.update(body);
    // A failed backup leaves the original config writable so a settings draft
    // can be recovered, but must not restart the quiesced business instance.
    if (deps.resetStatus?.().phase === 'failed') return { ok: true, config: sanitizeConfigForApi(cfg()), restartRequired: true };
    // 对已装配的内核组件立即施加副作用，无需重启即可更新存档、会话和主动循环。
    store.setMaxPerChat?.(cfg().store?.maxMessagesPerChat);
    sessions.setKeepFiles?.(cfg().store?.keepSessionFiles);
    if (cfg().proactive?.enabled) orchestrator?.startProactiveLoop?.(); else orchestrator?.stopProactiveLoop?.();
    deps.initPriceFeed?.();
    emit(deps, 'status', { configUpdated: true });
    return { ok: true, config: sanitizeConfigForApi(cfg()) };
  }
  http.route('POST', '/api/config', ({ body }) => applyConfigPatch(body));
  const settingsSaveLifecycle = (deps.components?.['console.settingsSaveLifecycle'] ?? createSettingsSaveLifecycleController)({
    config, applyPatch: applyConfigPatch, getIdentity: deps.settingsSaveIdentity,
    canRecoverDraft: () => deps.resetStatus?.()?.phase === 'failed',
    readConfig: () => sanitizeConfigForApi(cfg()), lifecycle: deps.lifecycle,
    publish: (name, payload) => emit(deps, name, payload),
  });
  http.route('POST', '/api/config/lifecycle', ({ body }) => settingsSaveLifecycle.put(body));
  http.route('POST', '/api/config/lifecycle/open', ({ body }) => settingsSaveLifecycle.open(body));
  const extensionDto = (entry) => ({ ...serializeSkill(entry), description: entry.description ?? '', status: entry.status, broken: Boolean(entry.loadError), available: entry.status === 'active' && !entry.loadError });
  const extensionView = () => { const view = skillView(); return { ...view, skills: (loader?.listEntries?.() ?? []).map(extensionDto) }; };
  const managementRoot = path.resolve(deps.appRoot ?? APP_ROOT);
  http.route('GET', '/api/extensions/authoring-context', () => ({
    version: deps.version ?? '0.5.0', appRoot: managementRoot,
    docs: ['docs/plugin-sdk.md', 'docs/architecture-composition.md', 'docs/extension-authoring.md',
      'docs/extension-reference.md', 'docs/v04-extension-parity.md', 'docs/ai-extension-prompt.md'],
  }));
  const managementDir = path.join(managementRoot, '.extension-management-v1');
  function safeManagementDirectory(name) {
    for (const dir of [managementDir, path.join(managementDir, name)]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir);
      if (fs.lstatSync(dir).isSymbolicLink() || !fs.lstatSync(dir).isDirectory()) bad('管理目录不是普通目录', 403);
    }
    return path.join(managementDir, name);
  }
  http.route('GET', '/api/skills', extensionView);
  http.route('POST', '/api/skills/reload', async () => {
    if (typeof loader?.loadAll !== 'function') bad('核心未提供 reloadSkills…', 500);
    const before = new Set((loader.listEntries?.() ?? []).map((entry) => entry.id));
    const loaded = await loader.loadAll({ reason: 'console-reload' });
    const afterEntries = loaded ?? loader.listEntries?.() ?? [];
    const after = new Set(afterEntries.map((entry) => entry.id));
    const view = extensionView();
    return {
      ok: true,
      loaded: afterEntries.filter((entry) => entry.status === 'active').map((entry) => entry.id),
      failed: afterEntries.filter((entry) => entry.status === 'error').map((entry) => ({ id: entry.id, error: entry.loadError ?? '' })),
      pruned: [...before].filter((id) => !after.has(id)),
      skills: view.skills, summary: view.summary,
    };
  });
  http.route('POST', '/api/skills/cleanup', ({ body }) => {
    const ids = body?.ids; if (!Array.isArray(ids) || !ids.length) bad('缺少 ids');
    const installed = new Set((loader?.listEntries?.() ?? []).map((entry) => entry.id)); const removed = ids.filter((id) => typeof id === 'string' && !installed.has(id));
    if (!removed.length) bad('没有可清理的条目（都处于已安装状态）');
    const skills = structuredClone(cfg().skills ?? {}); for (const id of removed) delete skills[id]; config.update({ skills: { __replace__: skills } }); emit(deps, 'status', { configUpdated: true });
    return { ok: true, removed, skipped: ids.filter((id) => !removed.includes(id)), config: sanitizeConfigForApi(cfg()) };
  });

  // 卸载仅移动用户代码到可恢复隔离区，不删除插件存储命名空间。
  http.route('POST', /^\/api\/skills\/(?<id>[^/]+)\/delete$/, async ({ params }) => {
    const id = params.id;
    const entry = loader?.hostEntry?.(id);
    const dto = (loader?.listEntries?.() ?? []).find((item) => item.id === id);
    if (!entry || !dto) bad(`扩展不存在：${id}`, 404);
    if (!['plugins', 'skills'].includes(entry.rootKind)) bad('只能卸载用户安装的扩展', 403);
    if (dto.enabled || entry.status === 'active') bad('请先停用该扩展再卸载', 409);
    const root = path.join(managementRoot, entry.rootKind);
    const dir = path.resolve(entry.dir);
    let real;
    try {
      if (fs.lstatSync(root).isSymbolicLink() || fs.lstatSync(dir).isSymbolicLink()) bad('拒绝卸载符号链接目录', 403);
      real = fs.realpathSync(dir);
      if (path.dirname(dir) !== root || path.dirname(real) !== fs.realpathSync(root)) bad('卸载目标必须是用户域的直接子目录', 403);
    } catch (e) { if (e.expose) throw e; bad('插件目录已不存在，请重扫磁盘', 409); }
    if (typeof permissions?.revokePlugin !== 'function' || typeof loader?.unload !== 'function') bad('核心未提供插件卸载或授权撤销', 500);
    const trash = safeManagementDirectory('trash');
    const quarantine = path.join(trash, `${path.basename(dir)}-${Date.now()}-${crypto.randomUUID()}.uninstalled-v1`);
    const oldSkills = structuredClone(cfg().skills ?? {});
    const skills = structuredClone(oldSkills); delete skills[id];
    let moved = false;
    try {
      fs.renameSync(real, quarantine); moved = true;
      config.update({ skills: { __replace__: skills } });
      permissions.revokePlugin(id);
      await loader.unload(id, 'user-uninstalled');
    } catch (e) {
      if (moved) {
        try { fs.renameSync(quarantine, dir); config.update({ skills: { __replace__: oldSkills } }); }
        catch (rollback) { bad(`卸载失败；代码保存在 ${quarantine}，恢复失败：${rollback.message}`, 500); }
      }
      bad(`卸载失败，已恢复代码及配置：${e.message}`, 500);
    }
    emit(deps, 'status', { configUpdated: true });
    return { ok: true, deleted: id, recoverable: true, quarantine: path.relative(managementRoot, quarantine), namespacePreserved: true };
  });

  // 单插件热更新（2026-06）：代码改了不用重启整个进程。
  // 与 POST /api/skills/reload（全量重扫）的区别：本端点只重载目标插件，且以 hot=true
  // 绕过 ESM 子模块缓存——常规 loadDir 在依赖图变化时故意报错要求重启（避免半新半旧）。
  // 安全约束与权限一致：用户插件更新后指纹变化 → 旧授权立即失效，需重新授权。
  http.route('POST', /^\/api\/skills\/(?<id>[^/]+)\/hot-reload$/, async ({ params }) => {
    const id = params.id;
    const entry = loader?.hostEntry?.(id);
    if (!entry) bad(`扩展不存在：${id}`, 404);
    if (entry.status === 'disabled') bad('该扩展已停用，请先启用再热更新', 409);
    if (!entry.dir) bad('该扩展没有可重载的目录');
    if (typeof loader?.loadDir !== 'function') bad('核心未提供 loadDir', 500);
    const before = entry.fingerprint ?? null;
    let reloadError = null;
    try {
      const manifestFile = ['skill.json', 'plugin.json'].find((name) => fs.existsSync(path.join(entry.dir, name)));
      if (!manifestFile) throw new Error('扩展清单已不存在');
      const raw = JSON.parse(fs.readFileSync(path.join(entry.dir, manifestFile), 'utf8').replace(/^\uFEFF/, ''));
      if ((raw.id ?? path.basename(entry.dir)) !== id) throw new Error('热更新不能改变扩展 id，请作为新扩展安装');
      await loader.loadDir(entry.rootKind, entry.dir, { hot: true });
    } catch (e) { reloadError = e.message; }
    const after = (loader.listEntries?.() ?? []).find((item) => item.id === id);
    const changed = Boolean(before && after?.fingerprint && before !== after.fingerprint);
    const error = reloadError ?? after?.loadError ?? null;
    const ok = after?.status === 'active' && !error;
    // loader 绑定新实例身份并发出 plugin.loaded；生命周期事件只由 loader
    // 发布，SSE 名称转换交给桥接层，避免重复通知或误发未注册事件。
    emit(deps, 'status', { configUpdated: true });
    return {
      ok, status: ok ? 'active' : 'error', retainedStatus: after?.status ?? 'unknown', error,
      fingerprintChanged: changed,
      needsReauthorize: Boolean(changed && entry.rootKind !== 'bundled'),
      skill: after ? extensionDto(after) : null,
    };
  });

  // 本地 ZIP 与市场安装共用身份校验和停用策略，目录名始终等于清单 id。
  async function installExtensionZip(buffer, { requestedId = '', kind: requestedKind } = {}) {
    if (!buffer.length || buffer.length > MARKET_MAX_ZIP_BYTES) bad('ZIP 内容为空或超过 8MB 上限');
    if (requestedId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(requestedId)) bad('skillId 非法');
    if (requestedKind != null && !['skill', 'plugin'].includes(requestedKind)) bad('kind 必须为 skill 或 plugin');
    if (typeof loader?.loadDir !== 'function') bad('核心未提供 loadDir', 500);
    const staging = safeManagementDirectory('staging');
    let stage;
    try {
      stage = extractZipSafely(buffer, staging);
      const manifests = ['skill.json', 'plugin.json'].filter((name) => fs.existsSync(path.join(stage, name)));
      if (manifests.length !== 1) bad('安装包根目录必须有且只有一个 skill.json 或 plugin.json');
      const raw = JSON.parse(fs.readFileSync(path.join(stage, manifests[0]), 'utf8').replace(/^\uFEFF/, ''));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw.id)) bad('清单必须声明合法 id');
      if (['constructor', 'prototype'].includes(raw.id) || /[. ]$/.test(raw.id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(raw.id)) bad('清单 id 不适合作为目录名');
      // 0.4 packages classify extensions by their manifest filename and often
      // omit kind. Infer only an absent field; never repair an invalid value or
      // let the selected market override an explicit package identity.
      const inferredKind = !Object.hasOwn(raw, 'kind');
      const kindValue = inferredKind ? (manifests[0] === 'plugin.json' ? 'plugin' : 'skill') : raw.kind;
      if (!['skill', 'plugin'].includes(kindValue)) bad('清单 kind 必须为 skill 或 plugin');
      const { manifest, problems } = normalizeManifest({ ...structuredClone(raw), kind: kindValue }, raw.id);
      if (problems.some((p) => p.level === 'error')) bad(problems.map((p) => p.msg).join('；'));
      if (requestedId && requestedId !== manifest.id) bad('skillId 与清单 id 不一致');
      if (requestedKind && requestedKind !== manifest.kind) bad('安装页类型与清单 kind 不一致');
      const entryFile = path.resolve(stage, manifest.entry);
      const relative = path.relative(stage, entryFile);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(entryFile) || !fs.statSync(entryFile).isFile()) bad('清单 entry 必须是安装目录内的普通文件');
      // Persist the inferred classification before fingerprinting and loading:
      // the loader's generic default is skill, including for plugin.json.
      if (inferredKind) fs.writeFileSync(path.join(stage, manifests[0]), JSON.stringify({ ...raw, kind: kindValue }, null, 2) + '\n', 'utf8');
      pluginFingerprint(stage);
      const kind = manifest.kind === 'skill' ? 'skills' : 'plugins';
      const root = path.join(managementRoot, kind);
      if (!fs.existsSync(root)) fs.mkdirSync(root);
      if (fs.lstatSync(root).isSymbolicLink() || !fs.lstatSync(root).isDirectory()) bad('用户扩展根目录不安全', 403);
      const destination = path.join(root, manifest.id);
      const identities = (loader.listEntries?.() ?? []).map((item) => item.id.toLowerCase());
      for (const domain of ['bundled', 'plugins', 'skills']) {
        const domainRoot = path.join(managementRoot, domain);
        if (!fs.existsSync(domainRoot)) continue;
        for (const name of fs.readdirSync(domainRoot)) {
          if (name.toLowerCase() === manifest.id.toLowerCase()) bad(`目标或身份已存在：${manifest.id}`, 409);
          for (const file of ['skill.json', 'plugin.json']) {
            let installed = null;
            try { installed = JSON.parse(fs.readFileSync(path.join(domainRoot, name, file), 'utf8').replace(/^\uFEFF/, '')); } catch { /* 无有效清单的目录仍由目录名保护 */ }
            if (typeof installed?.id === 'string' && installed.id.toLowerCase() === manifest.id.toLowerCase()) bad(`身份已存在：${manifest.id}`, 409);
          }
        }
      }
      if (identities.includes(manifest.id.toLowerCase())) bad(`身份已存在：${manifest.id}`, 409);
      const oldSkills = structuredClone(cfg().skills ?? {});
      try {
        // 明确停用必须先于装载；清单 enabledByDefault 不等于用户信任。
        config.update({ skills: { [manifest.id]: { enabled: false } } });
        fs.renameSync(stage, destination); stage = null;
      } catch (e) { config.update({ skills: { __replace__: oldSkills } }); throw e; }
      await loader.loadDir(kind, destination);
      const skill = (loader.listEntries?.() ?? []).find((item) => item.id === manifest.id);
      emit(deps, 'status', { configUpdated: true });
      return { ok: true, installed: manifest.id, root: kind, enabled: false, skill: skill ? extensionDto(skill) : null };
    } catch (e) { if (e.expose && e.status !== 502) throw e; bad(`安装失败：${e.message}`, 400); }
    finally { if (stage) fs.rmSync(stage, { recursive: true, force: true }); }
  }
  http.route('POST', '/api/skills/install', async ({ body }) => {
    const zipBase64 = body?.zipBase64;
    if (typeof zipBase64 !== 'string' || !zipBase64.length) bad('缺少 zipBase64');
    if (zipBase64.length > Math.ceil(MARKET_MAX_ZIP_BYTES / 3) * 4) bad('安装包超过 8MB 上限');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(zipBase64) || zipBase64.length % 4 !== 0 || Buffer.from(zipBase64, 'base64').toString('base64') !== zipBase64) bad('zipBase64 不是合法 base64');
    return installExtensionZip(Buffer.from(zipBase64, 'base64'), { requestedId: body?.skillId == null ? '' : String(body.skillId).trim(), kind: body?.kind });
  });
  http.route('POST', /^\/api\/skills\/(?<id>[^/]+)$/, async ({ params, body }) => {
    const entry = (loader?.listEntries?.() ?? []).find((item) => item.id === params.id); if (!entry) bad(`Skill 不存在：${params.id}`, 404);
    if (body?.enabled !== undefined && typeof body.enabled !== 'boolean') bad('body.enabled 必须是布尔');
    if (body?.settings !== undefined && (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings))) bad('body.settings 必须是对象');
    if (body?.clearSecrets !== undefined && (!Array.isArray(body.clearSecrets) || body.clearSecrets.some((key) => typeof key !== 'string'))) bad('clearSecrets 必须是设置字段名数组');
    if (body?.settings || body?.clearSecrets?.length) {
      const schema = entry.configSchema ?? {};
      const savedSettings = cfg().skills?.[params.id]?.settings ?? {};
      // Recover the structural marker left by older first writes as well.
      const settings = { ...(Object.hasOwn(savedSettings, '__replace__') ? savedSettings.__replace__ : savedSettings) };
      for (const [key, value] of Object.entries(body.settings ?? {})) {
        if (!Object.hasOwn(schema, key)) continue;
        const secret = /(apikey|api_key|accesstoken|access_token|communitykey|cookie|secret|password|privatekey|private_key|^token$)/i.test(key) || schema[key]?.secret === true || schema[key]?.sensitive === true || schema[key]?.format === 'password';
        if (['__proto__', 'constructor', 'prototype'].includes(key)) bad('设置字段非法');
        if (secret && (value === '' || value === '******')) continue;
        const rule = schema[key] ?? {};
        const type = rule.type;
        if ((type === 'boolean' && typeof value !== 'boolean') || (type === 'string' && typeof value !== 'string') || ((type === 'number' || type === 'integer') && (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value)))) || (type === 'array' && !Array.isArray(value)) || (type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value)))) bad(`设置 ${key} 类型不正确`);
        if (Array.isArray(rule.enum) && !rule.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) bad(`设置 ${key} 不在允许选项内`);
        if (typeof value === 'number' && ((rule.minimum != null && value < rule.minimum) || (rule.maximum != null && value > rule.maximum))) bad(`设置 ${key} 超出允许范围`);
        settings[key] = value;
      }
      for (const key of body.clearSecrets ?? []) {
        if (!Object.hasOwn(schema, key) || !(/(apikey|api_key|accesstoken|access_token|communitykey|cookie|secret|password|privatekey|private_key|^token$)/i.test(key) || schema[key]?.secret === true || schema[key]?.sensitive === true || schema[key]?.format === 'password')) bad(`设置 ${key} 不是可清除的密钥字段`);
        settings[key] = '';
      }
      // Replace from an existing parent: deepMerge does not descend into a new
      // skill entry, so a nested replacement marker would otherwise reach disk.
      const skills = structuredClone(cfg().skills ?? {});
      skills[params.id] = { ...(skills[params.id] ?? {}), settings };
      config.update({ skills: { __replace__: skills } });
    }
    if (body?.enabled !== undefined) await loader.setEnabled(params.id, body.enabled);
    const skill = (loader.listEntries() ?? []).map(extensionDto).find((item) => item.id === params.id); emit(deps, 'status', { configUpdated: true });
    return { ok: true, skill, settings: skill?.settings ?? {}, config: sanitizeConfigForApi(cfg()) };
  });
  function capabilityDto(name) {
      const detail = capability.explain(name);
      const service = deps.services?.status?.().find((item) => item.name === name);
      const providers = (detail.providers ?? []).map((provider) => {
        const implemented = provider.kind !== 'placeholder';
        const managed = capability.options?.(name, provider.ownerId)?.lifecycle === true;
        const selected = !detail.multi && Boolean(provider.selected);
        const running = managed && service?.ownerId === provider.ownerId && service.running === true;
        const error = managed && selected ? service?.error ?? null : null;
        return {
          skillId: provider.ownerId,
          ownerId: provider.ownerId,
          active: Boolean(provider.active),
          implemented,
          selectable: Boolean(provider.active) && implemented,
          usable: managed ? running : Boolean(provider.active) && implemented,
          managed,
          running: managed ? running : null,
          status: managed ? (running ? 'running' : error ? 'error' : selected ? 'stopped' : 'standby') : (provider.active && implemented ? 'active' : 'inactive'),
          error,
          kind: provider.kind,
          default: Boolean(provider.default),
          selected,
        };
      });
      const available = providers.some((provider) => provider.usable);
      return { name, multi: Boolean(detail.multi), selectedOwnerId: providers.find((provider) => provider.selected)?.ownerId ?? null, pinnedOwnerId: cfg().extensions?.providers?.[name] ?? null, available, reason: available ? null : service?.error ?? (providers.some((provider) => provider.selectable) ? '提供者服务尚未就绪' : '没有激活且已实现的提供者'), providers };
  }
  http.route('GET', '/api/skills/capabilities', () => ({ capabilities: (capability?.names?.() ?? []).map(capabilityDto) }));
  http.route('PUT', '/api/skills/capabilities/provider', async ({ body }) => {
    if (typeof body?.name !== 'string' || !body.name || ['__proto__', 'constructor', 'prototype'].includes(body.name)) bad('能力名称格式错误');
    if (typeof body?.ownerId !== 'string') bad('提供者标识格式错误');
    if (!(capability?.names?.() ?? []).includes(body.name)) bad('能力不存在', 404);
    if (body.ownerId && capability.explain(body.name).multi) bad('多提供者能力按声明顺序协作，不支持指定提供者');
    if (body.ownerId && !(capability.providers(body.name) ?? []).some((provider) => provider.ownerId === body.ownerId)) bad('提供者未激活或未实现', 409);
    const providers = { ...(cfg().extensions?.providers ?? {}) };
    if (body.ownerId) providers[body.name] = body.ownerId;
    else delete providers[body.name];
    config.update({ extensions: { providers: { __replace__: providers } } });
    await deps.services?.refresh?.();
    emit(deps, 'status', { configUpdated: true });
    return { ok: true, capability: capabilityDto(body.name), services: deps.services?.status?.() ?? [] };
  });
  http.route('GET', '/api/tools', () => ({ tools: (registry?.list?.() ?? []).map((tool) => ({ id: tool.id, name: tool.name ?? tool.id, description: tool.description ?? '', category: tool.category ?? null, icon: tool.icon ?? null, defaultEnabled: tool.defaultEnabled !== false, requiresVision: Boolean(tool.requiresVision), requiresSearch: Boolean(tool.requiresSearch), skillId: tool.ownerId ?? null })) }));
  http.route('GET', '/api/tools/availability', () => ({ categories: cfg().tools?.categories ?? {}, tools: (registry?.list?.() ?? []).map((tool) => { const available = registry.availability?.(tool.id, availabilityContext()) ?? { ok: true }; return { id: tool.id, category: tool.category ?? null, skillId: tool.ownerId ?? null, enabled: available.ok, code: available.code ?? null, reason: available.reason ?? null }; }) }));
  // 捆绑域工具id 撞车诊断（R52 补充）：裸 id 只在 bundled 之间可能撞，
  // 用户插件走<skillId>__<toolId> 前缀不会到这里。有冲突时返回非空，前端可提示。
  http.route('GET', '/api/tools/conflicts', () => ({ conflicts: registry?.collisionsInfo?.() ?? [] }));
  http.route('GET', '/api/update-check', () => priceAdapterFor('updateCheck').updateCheck());
  http.route('GET', '/api/models', async () => {
    const api = cfg().api ?? {};
    const providerId = typeof api.provider === 'string' ? api.provider : '';
    const provider = providerId ? (cfg().providers ?? []).find((item) => item.id === providerId) : null;
    const baseUrl = api.baseUrl || provider?.baseUrl || provider?.baseURL;
    if (!baseUrl) bad('获取模型列表失败：请先填写 Base URL', 502);
    const declaredBase = provider?.baseUrl ?? provider?.baseURL;
    if (providerId && declaredBase) {
      let matches=false;try{matches=new URL(baseUrl).origin===new URL(declaredBase).origin;}catch{}
      if(!matches)bad('所选渠道与模型接口来源不一致，请重新核对地址',502);
    }
    const apiKey = (providerId ? [cfg().dshProviderKeys?.[providerId], provider?.apiKey, provider?.apiKeyFrom && process.env[provider.apiKeyFrom]] : [api.apiKey]).find((value) => typeof value === 'string' && value.trim() && value !== '******') ?? '';
    try {
      const response = await requestModelEndpoint(new URL('models', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString(), { config: cfg(), timeoutMs: 15000, fetchImpl: deps.fetchImpl, dnsLookup: deps.dnsLookup, headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
      if (response.status >= 400) bad(`获取模型列表失败：HTTP ${response.status}`, 502);
      const data = JSON.parse(response.body);
      const rows = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : []));
      return { models: rows.map((model) => ({ id: model && typeof model === 'object' ? (model.id ?? model.model) : model })).filter((model) => model.id !== undefined && model.id !== null && String(model.id).trim() !== '') };
    } catch (err) { statusError(err, '获取模型列表失败'); }
  });

  // R64-R70/R77/R80-R87: session and archive controls.
  http.route('GET', '/api/sessions', async ({ query }) => {
    const rows=sessions.listSummaries().slice(0,Math.min(1048576,Math.max(1,Number(query.limit)||500))).map(serializeSessionSummary);
    return {sessions:await withSessionNames(rows)};
  });
  http.route('GET', /^\/api\/sessions\/(?<id>[A-Za-z0-9_-]+)$/, async ({ params }) => {
    const session=sessions.get(params.id);if(!session)bad('会话不存在',404);
    return (await withSessionNames([serializeSessionDetail(session)]))[0];
  });
  http.route('DELETE', /^\/api\/sessions\/(?<id>[A-Za-z0-9_-]+)$/, ({ params }) => { if (!sessions.delete(params.id)) bad('会话不存在或正在运行（运行中的会话不能删除）', 409); return { ok: true }; });
  http.route('POST', '/api/sessions/clear-finished', () => ({ ok: true, removed: sessions.clearFinished() }));
  http.route('POST', /^\/api\/sessions\/(?<id>[^/]+)\/(?<op>retry|abort)$/, ({ params }) => { const result = params.op === 'retry' ? orchestrator.retrySession(params.id) : orchestrator.abortSession(params.id); if (!result?.ok) bad(result?.error ?? '会话操作冲突', 409); return result; });
  const visibleChat=(query,key)=>query?.scope!=='allowlist'||chatIsVisible(cfg(),key);
  const requireVisibleChat=(query,key)=>{if(!visibleChat(query,key))bad('此聊天不在聊天白名单中',404);};
  http.route('GET', '/api/chats', async ({query}) => ({ chats: (await Promise.all(store.listChats().filter(chat=>visibleChat(query,chat.chatKey)).map(async (chat) => serializeChat({ ...chat, chatName: await chatNameFor(chat.chatKey) })))).filter(chat=>visibleChat(query,chat.chatKey)) }));
  http.route('GET', /^\/api\/chats\/(?<key>(group|private)_\d+)\/messages$/, ({ params, query }) => {
    const chatKey = chatKeyOf(params.key), limit = Math.min(500, Math.max(1, Math.floor(Number(query.limit) || 500)));
    requireVisibleChat(query,chatKey);
    const offset = Math.max(0, Math.floor(Number(query.offset) || 0));
    if (typeof store.page === 'function') return store.page(chatKey, { limit, offset, beforeId: query.beforeId });
    // Replacement stores implementing the original contract remain supported.
    const all = store.recent(chatKey, Number.MAX_SAFE_INTEGER, { resolveReplies: true });
    const entries = query.beforeId == null ? all : all.filter((entry) => Number(entry.id) < Number(query.beforeId));
    const end = Math.max(0, entries.length - offset), start = Math.max(0, end - limit);
    return { chatKey, messages: entries.slice(start, end), total: all.length, offset, hasMore: start > 0 };
  });
  http.route('POST', /^\/api\/chats\/(?<key>(group|private)_\d+)\/wake$/, () => bad('已移除：不触发的消息现在会立即标为已读，无需手动唤醒', 410));
  http.route('GET', /^\/api\/chats\/(?<key>(group|private)_\d+)\/messages\/(?<id>\d+)\/forward$/, async ({ params }) => {
    try { const result = await readArchivedForward({ store, transport, chatKey: chatKeyOf(params.key), localId: params.id }); emit(deps, 'chat.update', chatKeyOf(params.key)); return { ok: true, ...result }; }
    catch (error) { statusError(error, '展开转发失败'); }
  });
  http.route('POST', /^\/api\/chats\/(?<key>(group|private)_\d+)\/test-send$/, async ({ params, body }) => {
    const text = trimText(body?.text, 4000); if (!text) bad('消息内容为空'); const chatKey = chatKeyOf(params.key); allowSend(cfg(), chatKey);
    try {
      // 走 provider 归一化发送（send_group_msg/send_private_msg 的二选一在 provider 内）。
      // 管理员主动测试，有意不走 SendQueue 限频。
      const sent = await transport.send(chatKey, [{ type: 'text', text }]);
      const messageId = Array.isArray(sent) ? sent[0]?.msgId ?? null : sent?.msgId ?? null;
      store.appendSelf(chatKey, { mid: messageId, text }); emit(deps, 'chat.update', chatKey); return { ok: true, messageId };
    } catch (err) { statusError(err, '测试发送失败'); }
  });
  http.route('POST', /^\/api\/chats\/(?<key>(group|private)_\d+)\/(?<op>mark-read|clear|mute|delete-messages)$/, ({ params, body }) => {
    const chatKey = chatKeyOf(params.key); const op = params.op;
    if (op === 'clear') { const removed = store.recent(chatKey, 500000).length; store.clearChat(chatKey); emit(deps, 'chat.update', chatKey); return { ok: true, removed }; }
    if (op === 'delete-messages') { const ids = (Array.isArray(body?.ids) ? body.ids : []).filter(Number.isSafeInteger); if (!ids.length) bad('缺少要删除的消息 id 列表（ids）'); const removed = store.removeByLocalIds(chatKey, ids); emit(deps, 'chat.update', chatKey); return { ok: true, removed }; }
    const marked = store.markAllRead(chatKey); emit(deps, 'chat.update', chatKey); return { ok: true, marked };
  });
  function resumeWithoutBacklog({ body, res }) {
    if (typeof store.captureReadBoundary !== 'function' || typeof store.isReadBoundaryCurrent !== 'function') {
      respondJson(res, 503, { ok: false, error: '当前消息仓不支持可确认的积压标读' }); return;
    }
    let scopes;
    try { scopes = body && Object.hasOwn(body, 'remaining') ? body.remaining : store.captureReadBoundary(); }
    catch { respondJson(res, 503, { ok: false, error: '无法读取并确认当前积压，请保留暂停并重试' }); return; }
    if (!Array.isArray(scopes) || scopes.some(scope => !scope || typeof scope !== 'object' ||
      Object.keys(scope).some(key => !['chatKey', 'throughId', 'incarnation'].includes(key))) ||
      new Set(scopes.map(scope => scope.chatKey)).size !== scopes.length) {
      respondJson(res, 400, { ok: false, error: '无效标读边界' }); return;
    }
    // Validate every scope before any new write; a cleared/recreated chat must
    // never reinterpret an old local id as a newly received message.
    if (!scopes.every(scope => store.isReadBoundaryCurrent(scope))) {
      respondJson(res, 409, { ok: false, code: 'READ_BOUNDARY_STALE', error: '标读边界已失效，请取消重试并开始新操作' }); return;
    }
    const marked = {}, remaining = [], failed = {};
    for (const scope of scopes) {
      try { const count = store.markAllRead(scope.chatKey, { ...scope, strict: true }); if (count) marked[scope.chatKey] = count; }
      catch { remaining.push(scope); failed[scope.chatKey] = '保存标读状态失败'; }
    }
    emit(deps, 'chat.update', '*');
    if (remaining.length) {
      orchestrator.pause();
      emit(deps, 'status', { paused: true, pauseReason: null });
      respondJson(res, 207, { ok: false, partial: true, paused: true, marked, remaining, failed }); return;
    }
    orchestrator.resume({ skipBacklog: true });
    emit(deps, 'status', { paused: false, pauseReason: null });
    return { ok: true, paused: false, marked };
  }
  http.route('POST', '/api/pause', ({ body, res }) => {
    const paused = Boolean(body?.paused);
    if (!paused && body?.skipBacklog === true) return resumeWithoutBacklog({ body, res });
    if (paused) orchestrator.pause(); else orchestrator.resume({ skipBacklog: body?.skipBacklog === true });
    emit(deps, 'status', { paused, pauseReason: null });
    return { ok: true, paused };
  });
  http.route('DELETE', '/api/pause', resumeWithoutBacklog);
  http.route('GET', '/api/logs', ({ query }) => ({ logs: log.recent?.({ n: Math.min(500, Math.max(1, Number(query.limit) || 200)), minLevel: log.level ?? 'info' }) ?? [], level: log.level ?? 'info' }));
  http.route('POST', '/api/logs/level', ({ body }) => ({ ok: true, level: log.setLevel?.(body?.level) ?? log.level ?? 'info' }));

  // R71-R76: memory files backed by the kernel memory directory.
  const memoryConsolidation = createMemoryConsolidationAdapter({
    capability, memory, store, memoryConsolidator: deps.memoryConsolidator,
    serviceLeaseOf: deps.serviceLeaseOf, globalBlocklistOf: deps.globalBlocklistOf,
    resolveConsolidator: deps.services ? () => deps.services.get('memory.consolidate') : undefined,
    resolveToken: deps.services?.token ? () => deps.services.token('memory.consolidate') : undefined,
    emit: (name, payload) => emit(deps, name, payload), cfg,
  });
  const mediaData = createMediaDataAdapter({
    onebot: transport, transport, dataDir, mediaRoots: deps.mediaRoots, cfg,
    fetchImpl: deps.fetchImpl ?? fetch, dnsLookup: deps.dnsLookup,
  });
  const memberNotes=createMemberNoteController({config,publish:(name,payload)=>emit(deps,name,payload)});
  const memberEditor=(deps.components?.['console.memberEditor']??createMemberEditorController)({memory,config,memberNotes,publish:(name,payload)=>emit(deps,name,payload)});
  http.route('GET',/^\/api\/member-notes\/(?<uid>[^/]+)$/,({params})=>memberNotes.get(params.uid));
  http.route('PUT',/^\/api\/member-notes\/(?<uid>[^/]+)$/,({params,body})=>memberNotes.put(params.uid,body));
  http.route('GET', '/api/memory-files', ({query}) => {
    const validKey = /^(group|private):[1-9]\d{0,14}$/;
    const files = new Map();
    for (const file of memory?.listFiles?.() ?? []) {
      if (!validKey.test(file?.chatKey ?? '')||!visibleChat(query,file.chatKey)) continue;
      files.set(file.chatKey, { ...file, consolidating: memoryConsolidation.running.has(file.chatKey) });
    }
    const allow = cfg().allow ?? {};
    for (const [kind, ids] of [['group', allow.groups], ['private', allow.private]]) {
      if (!Array.isArray(ids)) continue;
      for (const value of ids) {
        if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) continue;
        const chatKey = `${kind}:${String(value).trim()}`;
        if (!validKey.test(chatKey) || files.has(chatKey)) continue;
        // A list placeholder does not load, create or persist a memory chat.
        files.set(chatKey, { chatKey, impressionCount: 0, memberCount: 0, updatedAt: 0, consolidating: false });
      }
    }
    return { files: [...files.values()].sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)), consolidating: [...memoryConsolidation.running].filter(key=>visibleChat(query,key)) };
  });
  http.route('GET', /^\/api\/memory-files\/(?<kind>group|private)_(?<id>\d+)$/, ({ params,query }) => {
    const chatKey = memoryKey(params.kind, params.id);requireVisibleChat(query,chatKey);const members = memory?.query?.(chatKey) ?? [];
    return { memberImpression: members, members: members.map((member) => ({ userId: member.userId, name: member.name, impressions: member.impressions, updatedAt: member.updatedAt, lastConsolidatedAt: member.lastConsolidatedAt })) };
  });
  http.route('GET',/^\/api\/memory-files\/(?<kind>group|private)_(?<id>\d+)\/members\/(?<uid>[^/]+)$/,({params})=>memberEditor.get(memoryKey(params.kind,params.id),params.uid));
  http.route('PUT',/^\/api\/memory-files\/(?<kind>group|private)_(?<id>\d+)\/members\/(?<uid>[^/]+)$/,({params,body,res})=>{
    const result=memberEditor.put(memoryKey(params.kind,params.id),params.uid,body);
    if(result.status!==200){respondJson(res,result.status,result.body);return;}
    return result.body;
  });
  http.route('DELETE', /^\/api\/memory-files\/(?<kind>group|private)_(?<id>\d+)\/members\/(?<uid>\d+)$/, ({ params }) => { memory?.removeMember?.(memoryKey(params.kind, params.id), params.uid); emit(deps, 'memory.update', { chatKey: memoryKey(params.kind, params.id) }); return { ok: true }; });
  http.route('DELETE', /^\/api\/memory-files\/(?<kind>group|private)_(?<id>\d+)$/, ({ params }) => { memory?.clearChat?.(memoryKey(params.kind, params.id)); emit(deps, 'memory.update', { chatKey: memoryKey(params.kind, params.id) }); return { ok: true }; });
  http.route('POST', '/api/memory-files/consolidate', ({ body, res }) => {
    if (!/^(group|private):\d+$/.test(body?.chatKey ?? '')) bad('chatKey 格式错误');
    const rawUserIds = body?.userIds;
    const userIds = rawUserIds == null ? null : (Array.isArray(rawUserIds) ? rawUserIds : [rawUserIds]).filter((id) => /^\d{1,15}$/.test(String(id))).map(String);
    if (rawUserIds != null && userIds.length === 0) bad('userIds 需为 QQ 号数组');
    const result = memoryConsolidation.start({ chatKey: body.chatKey, userIds, force: body?.force !== false, create: body?.create === true, mode: body?.mode === 'create' ? 'create' : '' });
    if (result.status !== 202) { respondJson(res, result.status, result.body); return; }
    respondJson(res, 202, result.body);
  });
  http.route('POST', '/api/media-data', async ({ body }) => {
    try { return { ok: true, results: await mediaData.resolveAll(body?.items) }; }
    catch (err) { return { ok: false, error: String(err?.message ?? err), results: [] }; }
  });

  // R-90：验证码请求只接受严格 HTTPS 白名单，保留方法/原始 body/上游状态与安全响应头。
  const captchaForward = async ({ req, res, query, rawBody }) => {
    const url = assertForwardUrl(query?.u);
    const hopByHop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
    for (const name of String(req.headers.connection ?? '').toLowerCase().split(',').map((x) => x.trim())) hopByHop.add(name);
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (hopByHop.has(lower) || ['host', 'content-length', 'content-encoding', 'x-console-token', 'cookie'].includes(lower) || value === undefined) continue;
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    let upstream;
    try {
      upstream = await safeFetch(url, { maxBytes: 16 * 1024 * 1024, timeoutMs: 15_000, browseLocked: true, allowedHosts: ['aliyuncs.com', 'alicdn.com'], expectBinary: true, followRedirects: false, method: req.method, headers, fetchImpl: deps.fetchImpl ?? fetch, dnsLookup: deps.dnsLookup, ...(rawBody?.length ? { body: rawBody } : {}) });
    } catch (err) { bad(`转发失败：${err?.message ?? err}`, 502); }
    if (upstream.truncated) bad('转发响应过大（>16MB）', 502);
    const responseHeaders = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
    for (const [name, value] of upstream.headers) {
      const lower = name.toLowerCase();
      if (hopByHop.has(lower) || ['content-length', 'content-encoding', 'set-cookie', 'access-control-allow-origin'].includes(lower)) continue;
      responseHeaders[name] = value;
    }
    responseHeaders['content-length'] = String(upstream.body.length);
    res.writeHead(upstream.status, responseHeaders);
    res.end(upstream.body);
  };
  http.route('*', '/api/captcha-forward', captchaForward);

  // R-02/R-03: these historical DTOs include ok:false even on failures.
  const dataDirFailure = (res, err) => {
    const status = Number.isInteger(err?.status) ? err.status : 500;
    const body = JSON.stringify({ ok: false, error: String(err?.message ?? err) });
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
    res.end(body);
  };
  http.route('POST', '/api/open-data-dir', async ({ res }) => {
    try { return await openDataDir(dataDir); } catch (err) { dataDirFailure(res, err); }
  });
  http.route('POST', '/api/reset-data', async ({ res }) => {
    try { return await (deps.resetData ? deps.resetData() : resetDataDir({ dataDir, config, orchestrator, onebot: transport })); } catch (err) { dataDirFailure(res, err); }
  });
}

// Trusted bootstrap composition runs before listen(). The scope owns only its
// registrations; HTTP authentication, origin/body checks and reset guards stay
// in the host transport even when a controller is explicitly replaced.
export async function registerComposedConsoleRoutes(http, deps, { routes = deps.composition?.routes ?? [], registerDefault = registerConsoleRoutes } = {}) {
  if (typeof http.createRouteScope !== 'function') throw new TypeError('Composed console routes require an HTTP route scope');
  const units = [];
  const parentSignal = deps.lifecycle?.signal;
  let disposal, quiescence, unregisterParent;
  const cancelChildren = () => {
    for (const unit of units) unit.lifecycle.cancel(parentSignal.reason);
  };
  parentSignal?.addEventListener('abort', cancelChildren, { once: true });
  const detachParent = () => {
    parentSignal?.removeEventListener('abort', cancelChildren);
    unregisterParent?.(); unregisterParent = null;
  };
  const checkActive = () => {
    if (parentSignal?.aborted) throw parentSignal.reason ?? new Error('Console route composition was cancelled');
  };
  const deactivate = unit => {
    unit.closed = true;
    unit.scope.dispose();
    unit.lifecycle.cancel();
    if (units.every(candidate => candidate.closed)) detachParent();
  };
  const disposeUnit = unit => {
    if (unit.disposal) return unit.disposal;
    // Publish before cancellation, whose listeners may reenter disposal.
    unit.disposal = Promise.resolve().then(async () => {
      const errors = [];
      try { await unit.returnedCleanup?.(); } catch (error) { errors.push(error); }
      try { await unit.lifecycle.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Console route composition cleanup failed');
    });
    deactivate(unit);
    return unit.disposal;
  };
  const disposeUnits = selected => Promise.resolve().then(async () => {
    const errors = [];
    for (const unit of [...selected].reverse()) {
      try { await disposeUnit(unit); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Console route composition cleanup failed');
  });
  const dispose = () => {
    if (!disposal) {
      disposal = disposeUnits(units).finally(detachParent);
      // Stop dispatching all controllers before awaiting resource cleanup.
      for (const unit of units) deactivate(unit);
    }
    return disposal;
  };
  // Reset keeps the host diagnostic controllers alive until the HTTP response
  // and application shutdown finish. Added controllers and resources stop now.
  dispose.quiesce = () => {
    if (!quiescence) {
      const selected = units.filter(unit => !unit.defaultUnit);
      quiescence = disposeUnits(selected).finally(() => { unregisterParent?.(); unregisterParent = null; });
      for (const unit of selected) deactivate(unit);
    }
    return quiescence;
  };
  async function register(id, registrar, config, strict) {
    checkActive();
    if (typeof registrar !== 'function') throw new TypeError(`Composition route ${id} must export a register function`);
    const unit = { scope: http.createRouteScope({ id, strict }), lifecycle: createCompositionLifecycle(), returnedCleanup: null, closed: false, defaultUnit: !strict, disposal: null };
    units.push(unit);
    const scopedHttp = Object.freeze({
      route: unit.scope.route,
      broadcast: (...args) => http.broadcast(...args),
      get port() { return http.port; },
      onDispose(cleanup) {
        if (unit.closed) throw new Error(`Composition route ${id} has been disposed`);
        if (typeof cleanup !== 'function') throw new TypeError('Route cleanup must be a function');
        unit.lifecycle.onStop(cleanup);
      },
    });
    const cleanup = await registrar(scopedHttp, { ...deps, lifecycle: unit.lifecycle }, config);
    // A registrar may return a resource after observing cancellation. Retain
    // its disposer even though the child no longer accepts new registrations.
    if (typeof cleanup === 'function') unit.returnedCleanup = cleanup;
    else if (cleanup && typeof cleanup.dispose === 'function') unit.returnedCleanup = () => cleanup.dispose();
    checkActive();
  }
  try {
    checkActive();
    if (registerDefault) await register('default.console.routes', registerDefault, undefined, false);
    for (const contribution of routes) await register(contribution.id ?? 'composition.routes', contribution.register, contribution.config, true);
    // Parent shutdown releases contributions; the kernel owns final disposal
    // of diagnostic controllers retained during data-reset quiescence.
    if (units.some(unit => !unit.defaultUnit)) unregisterParent = deps.lifecycle?.onStop?.(() => dispose.quiesce());
    if (!units.length) detachParent();
    return dispose;
  } catch (error) {
    try { await dispose(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Console route composition setup and cleanup failed', { cause: error }); }
    throw error;
  }
}
