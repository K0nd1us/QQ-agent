# -*- coding: utf-8 -*-
"""QQ Agent 社区 API：Skill 市场、插件市场、人设广场、云端统一屏蔽名单、
账号系统与口令安装。
独立于博客服务运行，公开读取；写入需 X-Community-Key（管理）或 X-Account-Token（账号）。

2026-09-19 合并版：以线上双市场结构为基底，叠加账号系统（注册/登录/凭据）、
带审核的账号发布、口令安装（install code）。旧的昵称上传入口保留兼容。
"""
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from flask import Flask, jsonify, request, send_from_directory

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'data' / 'community'
SKILLS = DATA / 'skills'
PERSONAS = DATA / 'personas'
PLUGINS = DATA / 'plugins'   # 插件市场：与 Skill 完全独立的一套存储
ACCOUNTS_FILE = DATA / 'accounts.json'
TOKENS_FILE = DATA / 'tokens.json'
BLOCKLIST = DATA / 'global-blocklist.json'
COMMUNITY_KEY = os.environ.get('QQ_AGENT_COMMUNITY_KEY', '')
MAX_UPLOAD = 8 * 1024 * 1024
MAX_TEXT = 120_000
SAFE_ID = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$')
LOGIN_ID_RE = re.compile(r'^[a-zA-Z0-9_]{3,24}$')
# 口令字符集：大写字母+数字，去掉易混淆的 0/O/1/I
INSTALL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
INSTALL_CODE_LEN = 6
# ⚠️ 必须与加载器白名单一致（src/skills/manifest.js 的 VALID_CATEGORIES）：
#    model / message / knowledge / media / utility。
CATEGORY_NAMES = {
    'model': '模型与推理', 'message': '消息与身份', 'knowledge': '知识库',
    'media': '媒体与多媒体', 'utility': '工具与运行控制', 'other': '其他'
}
LEGACY_CATEGORY_MAP = {
    'system': 'utility', 'tool': 'utility', 'web': 'utility', 'network': 'utility',
    'information': 'utility', 'productivity': 'utility', 'query': 'utility',
    'image': 'media', 'vision': 'media', 'audio': 'media', 'video': 'media',
    'chat': 'message', 'persona': 'message', 'conversation': 'message', 'messaging': 'message',
    'llm': 'model', 'chat-model': 'model', 'rag': 'knowledge', 'memory': 'knowledge'
}


# ── 阿里云验证码 2.0（服务端验签）──────────────────────────────
# 所有公开写入端点（上传/发布/人设/意见/金句）在处理业务前必须先过这道闸。
# 前端把 initAliyunCaptcha success 回调给出的 captchaVerifyParam 原样随请求带来，
# 这里透传给 VerifyIntelligentCaptcha 做一次性验签（token 用一次即失效）。
# 凭据走 systemd 环境：QQ_AGENT_CAPTCHA_AK_ID / QQ_AGENT_CAPTCHA_AK_SECRET /
# QQ_AGENT_CAPTCHA_SCENE_ID（endpoint 可选，默认上海）。
CAPTCHA_AK_ID = os.environ.get('QQ_AGENT_CAPTCHA_AK_ID', '')
CAPTCHA_AK_SECRET = os.environ.get('QQ_AGENT_CAPTCHA_AK_SECRET', '')
CAPTCHA_SCENE_ID = os.environ.get('QQ_AGENT_CAPTCHA_SCENE_ID', '')
CAPTCHA_ENDPOINT = os.environ.get('QQ_AGENT_CAPTCHA_ENDPOINT', 'captcha.cn-shanghai.aliyuncs.com')
CAPTCHA_VERIFY_TIMEOUT = 5  # 秒；验签 HTTP 超时（nginx read_timeout 60s，远小于它）


def _captcha_client_ip():
    """与 allow_public_write 同口径的真实访客 IP（TRUST_PROXY=1 时采信 X-Real-IP）。"""
    header_ip = request.headers.get('X-Real-IP', '')
    if os.environ.get('TRUST_PROXY') == '1' and header_ip:
        return header_ip.split(',')[0].strip()
    return request.remote_addr or ''


def _captcha_verify_remote(verify_param, user_ip):
    """调 VerifyIntelligentCaptcha（RPC + ACS3-HMAC-SHA256 V3 签名，纯标准库）。

    返回 (verify_result: bool, detail: str)。verify_result=True 表示验证通过。
    阿里云 API 层面失败（Success=false，如权限/欠费）不视为通过——那属于配置错误，
    静默放行会让闸门失效；只有网络层异常由外层按官方容灾建议处理。
    """
    body = urllib.parse.urlencode({
        'Action': 'VerifyIntelligentCaptcha',
        'Version': '2023-03-05',
        'CaptchaVerifyParam': verify_param,
        'SceneId': CAPTCHA_SCENE_ID,
        'UserIp': user_ip or '',
    }).encode('utf-8')

    body_hash = hashlib.sha256(body).hexdigest()
    now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    nonce = uuid.uuid4().hex
    headers = {
        'host': CAPTCHA_ENDPOINT,
        'content-type': 'application/x-www-form-urlencoded',
        'x-acs-action': 'VerifyIntelligentCaptcha',
        'x-acs-version': '2023-03-05',
        'x-acs-date': now,
        'x-acs-signature-nonce': nonce,
        'x-acs-content-sha256': body_hash,
    }
    signed_keys = sorted(headers)
    canonical_headers = ''.join(f'{k}:{headers[k]}\n' for k in signed_keys)
    canonical_request = '\n'.join([
        'POST', '/', '', canonical_headers, ';'.join(signed_keys), body_hash
    ])
    string_to_sign = 'ACS3-HMAC-SHA256\n' + hashlib.sha256(
        canonical_request.encode('utf-8')).hexdigest()
    signature = hmac.new(CAPTCHA_AK_SECRET.encode('utf-8'),
                         string_to_sign.encode('utf-8'), hashlib.sha256).hexdigest()
    auth = (f'ACS3-HMAC-SHA256 Credential={CAPTCHA_AK_ID},'
            f'SignedHeaders={";".join(signed_keys)},Signature={signature}')

    req = urllib.request.Request(
        f'https://{CAPTCHA_ENDPOINT}/', data=body, method='POST',
        headers={**headers, 'Authorization': auth, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=CAPTCHA_VERIFY_TIMEOUT) as resp:
        data = json.loads(resp.read().decode('utf-8'))
    # 200 响应：{Success, Code, Message, Result:{VerifyResult, VerifyCode, CertifyID}}
    if not data.get('Success'):
        return False, f"API拒绝:{data.get('Code')}/{data.get('Message', '')[:80]}"
    result = data.get('Result') or {}
    code = str(result.get('VerifyCode') or '')
    ok = bool(result.get('VerifyResult'))
    return ok, code if not ok else 'T001'


def verify_captcha(verify_param, user_ip=''):
    """公开写入闸门。返回 None=通过；str=拒绝原因（直接展示给用户）。

    fail-closed 场景：凭据未配置、param 缺失/超长、验签结果 false。
    fail-open 场景（官方容灾建议）：网络超时/DNS/5xx 等调用层异常——
    验证码是安全增强手段，不能成为业务单点故障；此时放行并记日志。
    """
    if not (CAPTCHA_AK_ID and CAPTCHA_AK_SECRET):
        return '服务器验证码未配置，上传暂不可用'
    if not verify_param or not isinstance(verify_param, str) or len(verify_param) > 16_384:
        return '请先完成人机验证'
    try:
        ok, detail = _captcha_verify_remote(verify_param, user_ip)
    except Exception as exc:  # 网络层异常：按官方建议放行，保障业务可用
        app.logger.warning('[captcha] verify fallback-pass: %r', exc)
        return None
    if not ok:
        app.logger.warning('[captcha] rejected: %s', detail)
        return '人机验证未通过，请重新验证后提交'
    return None


def normalize_category(value):
    """把作者写的 category 收敛到加载器认可的值，未知的一律 other（并保留原名便于排查）。"""
    raw = str(value or '').strip().lower()
    if raw in CATEGORY_NAMES: return raw
    mapped = LEGACY_CATEGORY_MAP.get(raw)
    if mapped: return mapped
    return 'other'
app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = MAX_UPLOAD + 512 * 1024
_UPLOAD_WINDOWS = {}
# 限流窗口是"读-改-写"共享字典，Flask 多线程下必须加锁
_UPLOAD_LOCK = threading.Lock()


def allow_public_write(bucket, limit=12, window=3600):  # noqa: D401
    """轻量 IP 限流：公开上传/发布接口不能被单个访客无限刷爆磁盘。"""
    now = time.time()
    # X-Real-IP 只有在部署于可信反代之后才采信（nginx 会清洗该头）
    header_ip = request.headers.get('X-Real-IP', '')
    if os.environ.get('TRUST_PROXY') == '1' and header_ip:
        ip = header_ip.split(',')[0].strip()
    else:
        ip = request.remote_addr or 'unknown'
    key = f'{bucket}:{ip}'
    with _UPLOAD_LOCK:
        recent = [t for t in _UPLOAD_WINDOWS.get(key, []) if now - t < window]
        if len(recent) >= limit:
            _UPLOAD_WINDOWS[key] = recent
        else:
            recent.append(now)
            _UPLOAD_WINDOWS[key] = recent
        if len(_UPLOAD_WINDOWS) > 1024:
            for k in [k for k, ts in _UPLOAD_WINDOWS.items() if all(now - t >= window for t in ts)]:
                del _UPLOAD_WINDOWS[k]
        return len(recent) <= limit


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify({'ok': False, 'error': '上传内容过大'}), 413


def atomic_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.tmp-', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(value, f, ensure_ascii=False, indent=2)
            f.flush(); os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        try: os.unlink(tmp)
        except FileNotFoundError: pass


def read_json(path: Path, default):
    try: return json.loads(path.read_text(encoding='utf-8'))
    except Exception: return default


def clean_text(value, max_len=MAX_TEXT):
    return str(value or '').strip()[:max_len]


def public_entry(kind, item):
    fields = ('id', 'name', 'title', 'description', 'category', 'categoryName', 'version', 'author', 'tags', 'createdAt', 'updatedAt', 'type', 'status', 'installCode')
    out = {k: item.get(k) for k in fields if k in item}
    # categoryName 是给前端直接显示的中文名，列表与单条响应必须一致
    if kind in ('skills', 'plugins'):
        out['category'] = normalize_category(item.get('category'))
        out['categoryName'] = CATEGORY_NAMES.get(out['category'], '其他')
        # 下载链接只对 approved 条目有意义；pending 的不下发（前端也就不渲染下载/口令按钮）
        if entry_status(item) == 'approved':
            out['downloadUrl'] = f"/api/community/{kind}/{item['id']}/download"
    if kind == 'personas':
        if item.get('prompt') is not None:
            out['hasPrompt'] = True
            out['prompt'] = item.get('prompt', '')
    if kind not in ('skills', 'plugins'):
        out['downloadUrl'] = f"/api/community/{kind}/{item['id']}/download"
    return out


def kind_root(kind):
    if kind == 'skills': return SKILLS
    if kind == 'plugins': return PLUGINS
    return PERSONAS


def list_entries(kind):
    root = kind_root(kind)
    root.mkdir(parents=True, exist_ok=True)
    out = []
    for p in sorted(root.glob('*/entry.json')):
        item = read_json(p, {})
        if isinstance(item, dict) and SAFE_ID.fullmatch(str(item.get('id', ''))):
            # 审核门（数据字段级而非条目级）：pending 条目照常展示（让人知道有新东西
            # 在路上，与线上原版行为一致），但 public_entry 不给它 downloadUrl /
            # installCode —— 前端按字段有无渲染下载与「复制口令」按钮。
            out.append(public_entry(kind, item))
    return sorted(out, key=lambda x: x.get('updatedAt', ''), reverse=True)


def require_key():
    if not COMMUNITY_KEY or not secrets.compare_digest(request.headers.get('X-Community-Key', ''), COMMUNITY_KEY):
        return jsonify({'ok': False, 'error': '社区管理密钥错误'}), 403
    return None


# ── 账号系统（2026-09-19）────────────────────────────────────────
# 注册三要素：登录 ID（3~24 位英文数字下划线，登录用，全局唯一）+
# 展示用户名（中文可，市场署名用）+ 密码（PBKDF2 加盐哈希）。
# token 是长期凭据（账号系统不需要频繁使用，登录一次长期有效），
# 但"长期"不是"永久"（2026-09-19 M13）：
#   · TTL 180 天：过期 token 在任意一次登录时被顺带清除（登录必然触发
#     _issue_token，那里有全局锁与写回，是天然的惰性清理点）；
#   · 每账号活跃 token 上限 10 个：老设备长期不登录就自动给新登录让位，
#     防止 tokens.json 被无限次登录撑大。

_AUTH_LOCK = threading.Lock()
PBKDF2_ITERATIONS = 100_000
TOKEN_TTL_SECONDS = 180 * 24 * 3600
TOKENS_PER_ACCOUNT = 10


def _load_accounts():
    return read_json(ACCOUNTS_FILE, {'accounts': []}) or {'accounts': []}


def _save_accounts(data):
    atomic_json(ACCOUNTS_FILE, data)


def _load_tokens():
    return read_json(TOKENS_FILE, {'tokens': {}}) or {'tokens': {}}


def _save_tokens(data):
    atomic_json(TOKENS_FILE, data)


def _hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), bytes.fromhex(salt), PBKDF2_ITERATIONS)
    return salt, digest.hex()


def _verify_password(password, salt, expected_hex):
    try:
        digest = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), bytes.fromhex(salt), PBKDF2_ITERATIONS)
        return hmac.compare_digest(digest.hex(), expected_hex)
    except (ValueError, TypeError):
        return False


def _issue_token(user_id):
    """发新 token，顺带做两件清理（都在全局锁内，读-改-写安全）：
    ① 淘汰全库过期 token（超过 TTL 180 天没被动过登录入口的凭据失效）；
    ② 该账号含新 token 在内的活跃凭据不超过 10 个，超出淘汰现有最旧的。
    token 只在登录时签发、登出/过期时删除，"签发时间"就是它的全部生命周期。"""
    now = time.time()
    data = _load_tokens()
    # ① 过期清理：createdAt 是 UTC ISO 串，解析失败（旧数据格式异常）按永不过期保留，
    #    宁可多留一条 token 也不能把能用的凭据误删。
    kept = {}
    for token, entry in data.get('tokens', {}).items():
        try:
            created = time.mktime(time.strptime(str(entry.get('createdAt', '')), '%Y-%m-%dT%H:%M:%SZ'))
        except (ValueError, TypeError):
            kept[token] = entry
            continue
        if now - created < TOKEN_TTL_SECONDS:
            kept[token] = entry
    # ② 每账号上限：同 userId 的 token（含即将签发的新 token）总数不超过上限，
    #    超出时淘汰现有 token 里"最旧"的。同秒签发的时间不可分，字典序等价随机，
    #    对"腾位置给新登录"这个目的没有影响。
    by_user = {}
    for token, entry in kept.items():
        by_user.setdefault(str(entry.get('userId', '')), []).append(token)
    # 新 token 即将加入：先给它腾位置，再写回（保证写盘后 ≤ TOKENS_PER_ACCOUNT）
    existing = by_user.get(str(user_id), [])
    while len(existing) + 1 > TOKENS_PER_ACCOUNT:
        kept.pop(existing.pop(0), None)
    token = secrets.token_urlsafe(32)
    kept[token] = {'userId': user_id, 'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    data['tokens'] = kept
    _save_tokens(data)
    return token


def _account_of_token(token):
    if not token:
        return None
    entry = _load_tokens().get('tokens', {}).get(str(token))
    if not isinstance(entry, dict):
        return None
    # TTL 判定（M13）：过期 token 直接当无效。解析不了 createdAt 的旧数据按有效保留。
    try:
        created = time.mktime(time.strptime(str(entry.get('createdAt', '')), '%Y-%m-%dT%H:%M:%SZ'))
        if time.time() - created >= TOKEN_TTL_SECONDS:
            return None
    except (ValueError, TypeError):
        pass
    user_id = str(entry.get('userId', ''))
    for acc in _load_accounts().get('accounts', []):
        if str(acc.get('id', '')) == user_id:
            return acc
    return None


def require_account():
    acc = _account_of_token(request.headers.get('X-Account-Token', ''))
    if not acc:
        return jsonify({'ok': False, 'error': '请先登录 QQ Agent 账号'}), 401
    return acc


def _account_public(acc):
    return {'id': acc.get('id', ''), 'loginId': acc.get('loginId', ''),
            'username': acc.get('displayName') or acc.get('loginId', ''),
            'displayName': acc.get('displayName') or acc.get('loginId', ''),
            'createdAt': acc.get('createdAt', '')}


@app.post('/api/community/auth/register')
def auth_register():
    if not allow_public_write('auth-register', limit=10):
        return jsonify({'ok': False, 'error': '注册过于频繁，请稍后再试'}), 429
    data = request.get_json(silent=True) or {}
    login_id = clean_text(data.get('loginId'), 24)
    display_name = clean_text(data.get('displayName'), 24)
    password = str(data.get('password') or '')
    if not LOGIN_ID_RE.fullmatch(login_id):
        return jsonify({'ok': False, 'error': '登录 ID 需 3~24 位，仅限字母/数字/下划线'}), 400
    if not display_name:
        return jsonify({'ok': False, 'error': '展示用户名不能为空'}), 400
    if len(password) < 6 or len(password) > 72:
        return jsonify({'ok': False, 'error': '密码长度需 6~72 位'}), 400
    with _AUTH_LOCK:
        accounts = _load_accounts()
        if any(str(a.get('loginId', '')).lower() == login_id.lower() for a in accounts.get('accounts', [])):
            return jsonify({'ok': False, 'error': '该登录 ID 已被注册'}), 409
        salt, pass_hash = _hash_password(password, salt=None)
        acc = {'id': uuid.uuid4().hex[:12], 'loginId': login_id, 'displayName': display_name,
               'salt': salt, 'passHash': pass_hash,
               'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        accounts.setdefault('accounts', []).append(acc)
        _save_accounts(accounts)
        token = _issue_token(acc['id'])
    return jsonify({'ok': True, 'account': _account_public(acc), 'token': token})


@app.post('/api/community/auth/login')
def auth_login():
    if not allow_public_write('auth-login', limit=15):
        return jsonify({'ok': False, 'error': '登录尝试过于频繁，请稍后再试'}), 429
    data = request.get_json(silent=True) or {}
    login_id = clean_text(data.get('loginId') or data.get('username'), 24)
    password = str(data.get('password') or '')
    for acc in _load_accounts().get('accounts', []):
        if str(acc.get('loginId', '')).lower() == login_id.lower():
            if _verify_password(password, str(acc.get('salt', '')), str(acc.get('passHash', ''))):
                token = _issue_token(acc['id'])
                return jsonify({'ok': True, 'account': _account_public(acc), 'token': token})
            break
    return jsonify({'ok': False, 'error': '登录 ID 或密码错误'}), 401


@app.get('/api/community/auth/whoami')
def auth_whoami():
    acc = _account_of_token(request.headers.get('X-Account-Token', ''))
    if not acc:
        # "凭据无效或已过期"从套话变成真实语义：token 可能就是过了 180 天 TTL
        return jsonify({'ok': False, 'error': '凭据无效或已过期（登录凭据有效期 180 天，请重新登录）'}), 401
    return jsonify({'ok': True, 'account': _account_public(acc)})


@app.post('/api/community/auth/logout')
def auth_logout():
    token = request.headers.get('X-Account-Token', '')
    if not token:
        return jsonify({'ok': False, 'error': '缺少凭据'}), 400
    with _AUTH_LOCK:
        data = _load_tokens()
        if data.get('tokens', {}).pop(str(token), None) is not None:
            _save_tokens(data)
    return jsonify({'ok': True})


@app.get('/api/community/health')
def health(): return jsonify({'ok': True, 'service': 'qq-agent-community'})


@app.get('/api/community/skills')
def skills(): return jsonify({'ok': True, 'categories': CATEGORY_NAMES, 'items': list_entries('skills')})


@app.get('/api/community/plugins')
def plugins_list(): return jsonify({'ok': True, 'categories': CATEGORY_NAMES, 'items': list_entries('plugins')})


@app.get('/api/community/personas')
def personas(): return jsonify({'ok': True, 'items': list_entries('personas')})


@app.get('/api/community/blocklist')
def blocklist():
    value = read_json(BLOCKLIST, {'ids': []})
    raw = value.get('ids', []) if isinstance(value, dict) else []
    ids = sorted(set(str(x) for x in raw if re.fullmatch(r'\d{5,12}', str(x))))
    return jsonify({'ok': True, 'ids': ids, 'updatedAt': value.get('updatedAt', '') if isinstance(value, dict) else ''})


def write_blocklist(ids):
    now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    atomic_json(BLOCKLIST, {'ids': ids, 'updatedAt': now})
    return now


def current_blocklist():
    value = read_json(BLOCKLIST, {'ids': []})
    raw = value.get('ids', []) if isinstance(value, dict) else []
    return sorted(set(str(x) for x in raw if re.fullmatch(r'\d{5,12}', str(x))))


@app.put('/api/community/blocklist')
def put_blocklist():
    """整体覆盖：会删条目，必须带管理密钥。"""
    denied = require_key()
    if denied: return denied
    data = request.get_json(silent=True) or {}
    raw = data.get('ids', []) if isinstance(data, dict) else []
    if not isinstance(raw, list): return jsonify({'ok': False, 'error': 'ids 必须是数组'}), 400
    ids = sorted(set(str(x) for x in raw if re.fullmatch(r'\d{5,12}', str(x))))[:20000]
    now = write_blocklist(ids)
    return jsonify({'ok': True, 'ids': ids, 'updatedAt': now})


@app.post('/api/community/blocklist/add')
def add_blocklist():
    """追加屏蔽：公开可用（限流），这样每个安装实例都能把骚扰者送进共享名单。"""
    if not allow_public_write('blocklist-add', limit=20):
        return jsonify({'ok': False, 'error': '操作过于频繁，请稍后再试'}), 429
    data = request.get_json(silent=True) or {}
    raw = data.get('ids', []) if isinstance(data, dict) else []
    if not isinstance(raw, list): return jsonify({'ok': False, 'error': 'ids 必须是数组'}), 400
    incoming = set(str(x) for x in raw if re.fullmatch(r'\d{5,12}', str(x)))
    if not incoming: return jsonify({'ok': False, 'error': '没有合法的 QQ 号'}), 400
    merged = sorted(set(current_blocklist()) | incoming)[:20000]
    now = write_blocklist(merged)
    return jsonify({'ok': True, 'ids': merged, 'added': sorted(incoming), 'updatedAt': now})


def create_persona_payload(data):
    title, prompt = clean_text(data.get('title'), 120), clean_text(data.get('prompt'))
    if not title or not prompt: return jsonify({'ok': False, 'error': '标题和提示词不能为空'}), 400
    ident = clean_text(data.get('id'), 64).lower().replace(' ', '-')
    if not SAFE_ID.fullmatch(ident): ident = 'persona-' + secrets.token_hex(5)
    now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    existing = read_json(PERSONAS / ident / 'entry.json', {})
    if existing:
        return jsonify({'ok': False, 'error': '该人设 id 已存在，请换一个 id'}), 409
    item = {'id': ident, 'title': title, 'description': clean_text(data.get('description'), 500), 'category': clean_text(data.get('category'), 40) or 'custom', 'author': clean_text(data.get('author'), 60) or '社区用户', 'prompt': prompt, 'createdAt': now, 'updatedAt': now}
    target = PERSONAS / ident
    target.mkdir(parents=True, exist_ok=True)
    atomic_json(target / 'entry.json', item)
    atomic_json(target / 'prompt.json', {'prompt': prompt})
    return jsonify({'ok': True, 'item': public_entry('personas', item)})


@app.post('/api/community/personas')
def create_persona():
    if not allow_public_write('persona'):
        return jsonify({'ok': False, 'error': '发布过于频繁，请稍后再试'}), 429
    data = request.get_json(silent=True) or {}
    denied = verify_captcha(data.get('captchaVerifyParam'), _captcha_client_ip())
    if denied:
        return jsonify({'ok': False, 'error': denied}), 403
    return create_persona_payload(data)


@app.get('/api/community/personas/<ident>/prompt')
def get_persona_prompt(ident):
    if not SAFE_ID.fullmatch(ident): return jsonify({'ok': False, 'error': '无效 id'}), 400
    item = read_json(PERSONAS / ident / 'entry.json', {})
    if not item: return jsonify({'ok': False, 'error': '人设不存在'}), 404
    return jsonify({'ok': True, 'item': public_entry('personas', item), 'prompt': item.get('prompt', '')})


@app.get('/api/community/<kind>/<ident>/download')
def download(kind, ident):
    if kind not in ('skills', 'personas', 'plugins') or not SAFE_ID.fullmatch(ident): return jsonify({'ok': False, 'error': '无效资源'}), 400
    root = kind_root(kind)
    target = root / ident
    if not target.is_dir(): return jsonify({'ok': False, 'error': '资源不存在'}), 404
    if kind in ('skills', 'plugins'):
        entry = read_json(target / 'entry.json', {})
        if entry_status(entry) != 'approved':
            denied = require_key()
            if denied: return denied
    # 唯一文件名：固定路径曾被两个并发请求同时打开写，一方拿到半截 zip。
    zip_path = DATA / 'downloads' / f'{kind}-{ident}-{uuid.uuid4().hex[:8]}.zip'
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        if kind == 'personas':
            item = read_json(target / 'entry.json', {})
            meta = {k: v for k, v in item.items() if k != 'prompt'}
            with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
                z.writestr(f'{ident}/prompt.txt', str(item.get('prompt', '')))
                z.writestr(f'{ident}/persona.json', json.dumps(meta, ensure_ascii=False, indent=2))
        else:
            with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
                for p in target.rglob('*'):
                    if not p.is_file(): continue
                    if p.name == 'entry.json': continue
                    z.write(p, f'{ident}/{p.relative_to(target).as_posix()}')
        resp = send_from_directory(zip_path.parent, zip_path.name, as_attachment=True, download_name=f'{kind}-{ident}.zip')
        resp.headers['Cache-Control'] = 'no-store'

        @resp.call_on_close
        def _cleanup_zip():
            try: zip_path.unlink(missing_ok=True)
            except Exception: pass
        return resp
    except Exception:
        try: zip_path.unlink(missing_ok=True)
        except Exception: pass
        raise


def validate_zip(data):
    if len(data) > MAX_UPLOAD: raise ValueError('压缩包最大 8MB')
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        files = [i for i in z.infolist() if not i.is_dir()]
        if len(files) > 100: raise ValueError('文件数量过多')
        total = sum(i.file_size for i in files)
        if total > 32 * 1024 * 1024: raise ValueError('解压后总大小超过 32MB')
        for i in files:
            normalized = i.filename.replace('\\', '/')
            parts = Path(normalized).parts
            if Path(i.filename).is_absolute() or normalized.startswith('/') or '..' in parts: raise ValueError('压缩包包含非法路径')
            if Path(normalized).suffix.lower() in ('.exe', '.dll', '.bat', '.cmd', '.ps1', '.vbs', '.sh'): raise ValueError('禁止上传可执行文件')
        return files


# ── 上传审核机制（线上原版保留）────────────────────────────────
OFFICIAL_AUTHOR = 'QQ Agent'


def entry_status(item):
    """一律以 status 字段为准；没有 status 的一律视为待审核。"""
    return item['status'] if item.get('status') in ('pending', 'approved') else 'pending'


def skill_dir_size(target):
    total = 0
    for p in target.rglob('*'):
        if p.is_file():
            total += p.stat().st_size
    return total


def admin_list(kind):
    root = kind_root(kind)
    items = []
    for p in sorted(root.glob('*/entry.json')):
        item = read_json(p, {})
        if not isinstance(item, dict) or not SAFE_ID.fullmatch(str(item.get('id', ''))):
            continue
        d = root / item['id']
        items.append({
            'id': item['id'], 'name': item.get('name', item['id']),
            'description': item.get('description', ''),
            'category': item.get('category', 'other'),
            'version': item.get('version', ''), 'author': item.get('author', ''),
            'createdAt': item.get('createdAt', ''), 'status': entry_status(item),
            'source': item.get('source', 'community'),
            'installCode': item.get('installCode', ''),
            'size': skill_dir_size(d),
        })
    items.sort(key=lambda x: (x.get('createdAt', ''), x.get('id', '')), reverse=True)
    return items


@app.get('/api/community/admin/uploads')
def admin_uploads():
    denied = require_key()
    if denied: return denied
    return jsonify({'ok': True, 'items': admin_list('skills')})


@app.get('/api/community/admin/plugins')
def admin_plugin_list():
    denied = require_key()
    if denied: return denied
    return jsonify({'ok': True, 'items': admin_list('plugins')})


# ── 通用发布（账号版）：skills 与 plugins 共用 ──────────────────

def _publish_payload(kind, file_storage, account=None, display_name='', description=''):
    """发布公共实现：校验 zip → 解压 → pending entry。
    account 为 None = 旧昵称入口（兼容）；有值 = 账号发布（author 记展示名）。
    id 与市场已有条目重复 → 直接 409 拒绝（不做自动改名：改名会让同一插件
    在市场里出现多个 id 副本，用户分不清哪个是正版）。"""
    if not file_storage:
        return jsonify({'ok': False, 'error': '缺少 file 字段'}), 400
    raw = file_storage.read()
    try:
        files = validate_zip(raw)
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 400
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        if kind == 'plugins':
            manifest_name = next((x.filename for x in files if Path(x.filename).name.lower() == 'plugin.json'), '')
        else:
            manifest_name = next((x.filename for x in files if Path(x.filename).name.lower() in ('skill.json', 'plugin.json')), '')
        if not manifest_name:
            return jsonify({'ok': False, 'error': '压缩包内必须包含 ' + ('plugin.json' if kind == 'plugins' else 'skill.json / plugin.json')}), 400
        try:
            manifest = json.loads(z.read(manifest_name).decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return jsonify({'ok': False, 'error': '清单不是合法 UTF-8 JSON'}), 400
    ident = clean_text(manifest.get('id'), 64).lower()
    if not SAFE_ID.fullmatch(ident):
        return jsonify({'ok': False, 'error': '清单 id 不合法'}), 400
    raw_cat = manifest.get('category')
    if not raw_cat and isinstance(manifest.get('tools'), list) and manifest['tools']:
        raw_cat = (manifest['tools'][0] or {}).get('category')
    # id 查重：与市场已有条目（含待审核）重复直接拒绝。
    # ⚠️ 不做 _1 自动改名：同一插件以两个 id 存在会让"哪个是正版"永远说不清，
    #    用户想要上传就改一个自己的 id。
    root = kind_root(kind)
    if (root / ident / 'entry.json').exists():
        existing = read_json(root / ident / 'entry.json', {})
        existing_name = (existing or {}).get('name', ident)
        return jsonify({'ok': False, 'error': f'市场上已存在同 id 的条目（{existing_name}，id={ident}），无法上传。请换一个 id 后重试。'}), 409
    target = root / ident
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        for info in files:
            safe_name = PurePosixPath(info.filename.replace('\\', '/'))
            if safe_name.is_absolute() or '..' in safe_name.parts:
                _cleanup_dir(target)
                return jsonify({'ok': False, 'error': '压缩包包含非法路径'}), 400
            dest = target.joinpath(*safe_name.parts)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(z.read(info.filename))
    now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    author = (account or {}).get('displayName') or (account or {}).get('username') \
        or clean_text(request.form.get('nickname'), 60) \
        or clean_text(manifest.get('author'), 60) or '社区用户'
    item = {
        'id': ident,
        'name': clean_text(display_name, 120) or clean_text(manifest.get('name'), 120) or ident,
        'description': clean_text(description, 500) or clean_text(manifest.get('description'), 500),
        'category': normalize_category(raw_cat),
        'version': clean_text(manifest.get('version'), 30) or '0.0.0',
        'author': author,
        'authorId': (account or {}).get('id', ''),
        'type': 'plugin' if kind == 'plugins' else 'skill',
        'source': 'community', 'status': 'pending',
        'createdAt': now, 'updatedAt': now,
    }
    try:
        atomic_json(target / 'entry.json', item)
    except Exception:
        _cleanup_dir(target)
        raise
    return jsonify({
        'ok': True, 'item': public_entry(kind, item),
        'sha256': hashlib.sha256(raw).hexdigest()
    })


def _cleanup_dir(target: Path):
    import shutil
    shutil.rmtree(target, ignore_errors=True)


@app.post('/api/community/market/publish')
def market_publish():
    """登录账号发布：multipart（file=zip, kind=skills|plugins, name, description）。
    kind 按清单文件自动判定也可（plugin.json → plugins），显式传优先。"""
    acc = require_account()
    if isinstance(acc, tuple):
        return acc
    if not allow_public_write('market-publish', limit=10):
        return jsonify({'ok': False, 'error': '发布过于频繁，请稍后再试'}), 429
    denied = verify_captcha(request.form.get('captchaVerifyParam'), _captcha_client_ip())
    if denied:
        return jsonify({'ok': False, 'error': denied}), 403
    kind = str(request.form.get('kind') or '').lower()
    if kind not in ('skills', 'plugins'):
        # 未显式指定：按包内清单文件判定
        f = request.files.get('file')
        if not f:
            return jsonify({'ok': False, 'error': '缺少 file 字段'}), 400
        raw_head = f.read(MAX_UPLOAD)
        import io as _io
        try:
            with zipfile.ZipFile(_io.BytesIO(raw_head)) as z:
                names = [Path(x.filename).name.lower() for x in z.infolist() if not x.is_dir()]
        except Exception:
            return jsonify({'ok': False, 'error': '压缩包无效'}), 400
        if 'plugin.json' in names and 'skill.json' not in names:
            kind = 'plugins'
        else:
            kind = 'skills'
        # 重置流指针供后续读取（werkzeug FileStorage 支持 seek）
        f.stream.seek(0)
    return _publish_payload(kind, request.files.get('file'), account=acc,
                            display_name=request.form.get('name', ''),
                            description=request.form.get('description', ''))


# 旧公开上传入口（无账号，昵称署名）：保留兼容，统一走 pending
@app.post('/api/community/skills/upload')
def upload_skill():
    if not allow_public_write('skill-upload'):
        return jsonify({'ok': False, 'error': '上传过于频繁，请稍后再试'}), 429
    denied = verify_captcha(request.form.get('captchaVerifyParam'), _captcha_client_ip())
    if denied:
        return jsonify({'ok': False, 'error': denied}), 403
    nickname = clean_text(request.form.get('nickname'), 60)
    if not nickname: return jsonify({'ok': False, 'error': '请填写上传者昵称'}), 400
    return _publish_payload('skills', request.files.get('file'), account=None)


@app.post('/api/community/plugins/upload')
def upload_plugin_market():
    if not allow_public_write('plugin-upload'):
        return jsonify({'ok': False, 'error': '上传过于频繁，请稍后再试'}), 429
    denied = verify_captcha(request.form.get('captchaVerifyParam'), _captcha_client_ip())
    if denied:
        return jsonify({'ok': False, 'error': denied}), 403
    nickname = clean_text(request.form.get('nickname'), 60)
    if not nickname: return jsonify({'ok': False, 'error': '请填写上传者昵称'}), 400
    return _publish_payload('plugins', request.files.get('file'), account=None)


# ── 审核（approve 时生成口令）────────────────────────────────

def _generate_install_code(occupied):
    for _ in range(200):
        code = ''.join(secrets.choice(INSTALL_CODE_ALPHABET) for _ in range(INSTALL_CODE_LEN))
        if code not in occupied:
            return code
    return None


def _occupied_install_codes():
    codes = set()
    for kind in ('skills', 'plugins'):
        for p in kind_root(kind).glob('*/entry.json'):
            item = read_json(p, {})
            if isinstance(item, dict) and item.get('installCode'):
                codes.add(str(item['installCode']))
    return codes


def _review(kind, ident, action):
    denied = require_key()
    if denied: return denied
    if not SAFE_ID.fullmatch(ident): return jsonify({'ok': False, 'error': '无效 id'}), 400
    if action == 'reject':
        # 拒绝 = 删除目录（与线上原版行为一致）
        target = kind_root(kind) / ident
        if not target.is_dir(): return jsonify({'ok': False, 'error': '不存在'}), 404
        import shutil
        shutil.rmtree(target)
        return jsonify({'ok': True, 'id': ident, 'status': 'rejected'})
    entry_path = kind_root(kind) / ident / 'entry.json'
    item = read_json(entry_path, {})
    if not item: return jsonify({'ok': False, 'error': '不存在'}), 404
    if action == 'approve':
        # 已 approved 且有口令 → 幂等返回（重复点通过不换口令，口令一旦发出要稳定）
        if entry_status(item) == 'approved' and item.get('installCode'):
            return jsonify({'ok': True, 'id': ident, 'status': 'approved', 'installCode': item['installCode']})
        code = _generate_install_code(_occupied_install_codes())
        if not code:
            return jsonify({'ok': False, 'error': '口令空间不足，请联系管理员'}), 500
        item['status'] = 'approved'
        item['installCode'] = code
    else:
        return jsonify({'ok': False, 'error': 'action 必须是 approve 或 reject'}), 400
    item['updatedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    atomic_json(entry_path, item)
    return jsonify({'ok': True, 'id': ident, 'status': 'approved', 'installCode': code,
                    'item': public_entry(kind, item)})


# 兼容旧管理端路径 + 新统一路径
@app.post('/api/community/admin/skills/<ident>/approve')
def admin_approve(ident): return _review('skills', ident, 'approve')


@app.post('/api/community/admin/skills/<ident>/reject')
def admin_reject(ident): return _review('skills', ident, 'reject')


@app.post('/api/community/admin/plugins/<ident>/approve')
def admin_plugin_approve(ident): return _review('plugins', ident, 'approve')


@app.post('/api/community/admin/plugins/<ident>/reject')
def admin_plugin_reject(ident): return _review('plugins', ident, 'reject')


@app.post('/api/community/market/<kind>/<ident>/review')
def market_review(kind, ident):
    """新统一审核入口：body { action: 'approve' | 'reject' }，kind: skills | plugins。"""
    if kind not in ('skills', 'plugins'):
        return jsonify({'ok': False, 'error': 'kind 必须是 skills 或 plugins'}), 400
    data = request.get_json(silent=True) or {}
    return _review(kind, ident, str(data.get('action') or ''))


# ── 口令安装（应用端）────────────────────────────────────────

def _entry_by_install_code(code):
    """口令 → (kind, ident, entry)。只认 approved 条目；skills 与 plugins 都扫。"""
    code = str(code or '').strip().upper()
    if len(code) != INSTALL_CODE_LEN:
        return None
    for kind in ('skills', 'plugins'):
        for p in kind_root(kind).glob('*/entry.json'):
            item = read_json(p, {})
            if isinstance(item, dict) and str(item.get('installCode', '')).upper() == code \
                    and entry_status(item) == 'approved':
                return kind, p.parent.name, item
    return None


@app.post('/api/community/install/verify')
def install_verify():
    """批量校验口令：body { codes: [...] } → 每个口令的条目摘要（type=skill|plugin）。"""
    data = request.get_json(silent=True) or {}
    codes = data.get('codes') if isinstance(data.get('codes'), list) else [data.get('code')]
    results = []
    for c in codes:
        hit = _entry_by_install_code(c)
        if hit:
            kind, ident, item = hit
            results.append({'code': str(c).strip().upper(), 'ok': True,
                            'id': ident, 'name': item.get('name', ident),
                            'author': item.get('author', ''),
                            'type': 'plugin' if kind == 'plugins' else 'skill',
                            'version': item.get('version', '')})
        else:
            results.append({'code': str(c or '').strip().upper(), 'ok': False})
    return jsonify({'ok': True, 'results': results})


@app.get('/api/community/install/<code>/download')
def install_download(code):
    """按口令下载安装包（approved 专用，无需知道 id）。"""
    hit = _entry_by_install_code(code)
    if not hit:
        return jsonify({'ok': False, 'error': '口令无效'}), 404
    kind, ident, _item = hit
    return download(kind, ident)


if __name__ == '__main__':
    DATA.mkdir(parents=True, exist_ok=True)
    app.run(host='127.0.0.1', port=8921)
