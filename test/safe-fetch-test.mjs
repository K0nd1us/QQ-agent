// safe-fetch 的 DNS 解析自测。**不联网** —— lookup / resolve4 都是注入的假实现。
//
// 背景见 src/safe-fetch.js 顶部的注释：老实现只用 dns.lookup（getaddrinfo）且只给 5 秒、
// 不重试、不缓存。实测同一台机器解析 multimedia.nt.qq.com.cn：
//     dns.lookup 冷启动 11066ms   （getaddrinfo 走系统 DNS 客户端，冷启动极慢）
//     dns.resolve4          18ms   （c-ares 直接问 DNS 服务器）
// 于是系统 DNS 缓存一过期，5 秒必爆 -> "有时候识图失败：域名解析失败：DNS 解析超时"。
// 修复的核心是「两条路竞速、谁先回用谁」—— 本测试就是把这个行为锁住。
//
// 运行：node test/safe-fetch-test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-dns-'));

const { resolveHostAddresses, clearDnsCache, validateFetchUrl } =
  await import('../src/safe-fetch.js');

const dead = async () => { throw new Error('这条解析路径不可用'); };
const okList = (list) => async () => list;
// 故意慢慢失败：既模拟 getaddrinfo 卡住，又不会留下长定时器拖住进程退出
const slowFail = (ms) => new Promise((_, reject) =>
  setTimeout(() => reject(new Error('getaddrinfo 太慢')), ms));

// ── 1. 核心：lookup 卡住时，resolve4 必须先把结果带回来 ──
{
  clearDnsCache();
  const t0 = Date.now();
  const addrs = await resolveHostAddresses('slow.example', {
    lookup: () => slowFail(500), resolve4: okList(['9.9.9.9']), cache: false
  });
  const cost = Date.now() - t0;
  assert.deepStrictEqual(addrs, ['9.9.9.9'], '应拿到 c-ares 的结果');
  assert.ok(cost < 300, `不该等 getaddrinfo 慢慢失败（实际 ${cost}ms）`);
}

// ── 2. 反过来：resolve4 不可用时，lookup 应当兜底 ──
{
  clearDnsCache();
  const addrs = await resolveHostAddresses('hosts-only.example', {
    lookup: okList([{ address: '8.8.8.8' }]), resolve4: dead, cache: false
  });
  assert.deepStrictEqual(addrs, ['8.8.8.8'], 'lookup 应能兜底（它认 hosts 文件）');
}

// ── 3. IPv4 排前面，但 IPv6 不能丢（部分 CDN 的 AAAA 在纯 IPv4 网络下连不通）──
{
  clearDnsCache();
  const addrs = await resolveHostAddresses('dual.example', {
    lookup: okList([{ address: '2001:db8::1' }, { address: '1.2.3.4' }]), resolve4: dead, cache: false
  });
  assert.strictEqual(addrs[0], '1.2.3.4', 'IPv4 必须排在 IPv6 前面');
  assert.ok(addrs.includes('2001:db8::1'), 'IPv6 仍要保留（不能只会连 IPv4）');
}

// ── 4. 去重 ──
{
  clearDnsCache();
  const addrs = await resolveHostAddresses('dup.example', {
    lookup: okList([{ address: '1.1.1.1' }, { address: '1.1.1.1' }]), resolve4: dead, cache: false
  });
  assert.deepStrictEqual(addrs, ['1.1.1.1'], '两条路可能返回同一个地址，要去重');
}

// ── 5. 重试：前两次失败，第三次成功 ──
{
  clearDnsCache();
  let n = 0;
  const flaky = async () => {
    n += 1;
    if (n < 3) throw new Error('临时失败');
    return ['5.5.5.5'];
  };
  const addrs = await resolveHostAddresses('flaky.example', { lookup: flaky, resolve4: dead, cache: false });
  assert.deepStrictEqual(addrs, ['5.5.5.5'], '应当重试到成功');
  assert.strictEqual(n, 3, '应该是第 3 次才成功');
}

// ── 6. 全部失败 -> 抛出，且带的是最后一次的错误 ──
{
  clearDnsCache();
  await assert.rejects(
    () => resolveHostAddresses('dead.example', { lookup: dead, resolve4: dead, cache: false }),
    /不可用/,
    '全部失败时应抛出而不是返回空数组'
  );
}

// ── 7. 缓存：TTL 内不该重复解析；clearDnsCache 之后要重新解析 ──
{
  clearDnsCache();
  let calls = 0;
  const counted = async () => { calls += 1; return ['7.7.7.7']; };
  await resolveHostAddresses('cached.example', { lookup: counted, resolve4: dead });
  await resolveHostAddresses('cached.example', { lookup: counted, resolve4: dead });
  assert.strictEqual(calls, 1, '5 分钟 TTL 内应走缓存');

  clearDnsCache();
  await resolveHostAddresses('cached.example', { lookup: counted, resolve4: dead });
  assert.strictEqual(calls, 2, 'clearDnsCache 之后应重新解析');
}

// ── 8. 向后兼容：validateFetchUrl 仍返回 ip，并新增 ips ──
{
  const r = await validateFetchUrl('http://1.2.3.4/x');
  assert.strictEqual(r.ip, '1.2.3.4', 'ip 字段必须保留 —— 老调用方可能还在解构它');
  assert.deepStrictEqual(r.ips, ['1.2.3.4'], '新增的 ips 数组');
}

// ── 9. SSRF 防护没被削弱 ──
{
  await assert.rejects(() => validateFetchUrl('http://127.0.0.1/x'), /内网|本机/, '本机地址应被拒');
  await assert.rejects(() => validateFetchUrl('http://10.0.0.1/x'), /内网|本机/, '内网地址应被拒');
  const allowed = await validateFetchUrl('http://127.0.0.1/x', { allowPrivate: true });
  assert.strictEqual(allowed.ip, '127.0.0.1', 'allowPrivate 时放行');
}

console.log('✓ safe-fetch DNS 解析自测全部通过');
