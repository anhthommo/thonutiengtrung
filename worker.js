// Worker cho trang học tiếng Trung.
// - Phục vụ trang web trong thư mục public/ (Cloudflare tự làm qua [assets]).
// - /api/tts       : tạo giọng đọc bằng Edge (miễn phí), Azure hoặc ElevenLabs, có lưu đệm.
// - /api/sentences : câu tự nhập, lưu trong Supabase.
// - /api/settings  : giọng mặc định, lưu trong Supabase.
// Toàn bộ mã máy chủ nằm trong một file này cho dễ tải lên.

const EDGE_VERSION = "143.0.3650.75"; // khớp với edge-tts; nếu Edge ngừng chạy, cập nhật theo constants.py của edge-tts
const EDGE_MAJOR = EDGE_VERSION.split(".")[0];
const EDGE_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CACHE_BUCKET = "tts-cache";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const fail = (msg, status = 500) => json({ error: msg }, status);
const xml = s => s.replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
const uuid = () => crypto.randomUUID().replaceAll("-", "");
const pct = r => { const p = Math.round((r - 1) * 100); return (p >= 0 ? "+" : "") + p + "%"; };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    env = withPageKeys(request, env);

    if (env.APP_PASSWORD && request.headers.get("x-app-password") !== env.APP_PASSWORD && url.pathname !== "/api/config")
      return fail("Sai mật khẩu", 401);

    try {
      if (url.pathname === "/api/config") return json(config(env));
      if (url.pathname === "/api/tts") return await tts(url, env, ctx);
      if (url.pathname === "/api/voices/elevenlabs") return await elevenVoices(env);
      if (url.pathname === "/api/elevenlabs/library") return await elevenLibrary(url, env);
      if (url.pathname === "/api/elevenlabs/add") return await elevenAdd(request, env);
      if (url.pathname.startsWith("/api/sentences")) return await sentences(request, url, env);
      if (url.pathname === "/api/settings") return await settings(request, env);
      if (url.pathname === "/api/check") return json(await check(env));
      if (url.pathname === "/api/translate") return await translate(request, env);
      return fail("Không có đường dẫn này", 404);
    } catch (e) {
      return fail(String(e && e.message || e));
    }
  }
};

// Key nhập trên trang web được gửi kèm mỗi yêu cầu qua header "x-app-keys".
// Mỗi dịch vụ có thể có nhiều key: key nào lỗi hoặc hết hạn mức thì tự chuyển sang key tiếp theo.
// Key trong wrangler.toml (nếu có, cách nhau bằng dấu phẩy) được thêm vào cuối danh sách.
function withPageKeys(request, env) {
  let k = {};
  try { k = JSON.parse(decodeURIComponent(request.headers.get("x-app-keys") || "") || "{}"); } catch (_) {}
  const str = v => (typeof v === "string" ? v.trim() : "");
  const list = (arr, legacyKey, legacyRegion, envKey, envRegion, needRegion) => {
    const out = [];
    const push = (key, region) => {
      key = str(key); region = str(region);
      if (!key || out.some(x => x.key === key)) return;
      out.push(needRegion ? { key, region: region || str(envRegion) || "southeastasia" } : { key });
    };
    if (Array.isArray(arr)) arr.forEach(x => x && push(x.key, x.region));
    push(legacyKey, legacyRegion);
    str(envKey).split(",").forEach(x => push(x, envRegion));
    return out;
  };
  const pick = (a, b) => str(a) || str(b);
  return {
    ...env,
    AZURE_KEYS: list(k.azure, k.azureKey, k.azureRegion, env.AZURE_KEY, env.AZURE_REGION, true),
    ELEVEN_KEYS: list(k.eleven, k.elevenKey, "", env.ELEVENLABS_KEY, "", false),
    TR_KEYS: list(k.tr, k.trKey, k.trRegion, env.TRANSLATOR_KEY, env.TRANSLATOR_REGION, true),
    KEY_START: (k.start && typeof k.start === "object") ? k.start : {},
    SUPABASE_URL: pick(k.sbUrl, env.SUPABASE_URL).replace(/\/+$/, ""),
    SUPABASE_KEY: pick(k.sbKey, env.SUPABASE_KEY)
  };
}

// Lỗi kèm mã HTTP, để biết vì sao một key không dùng được
class KeyError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
function keyReason(service, status, body) {
  const raw = String(body || "");
  const b = raw.toLowerCase();
  // ElevenLabs trả lỗi dạng {"detail":{"status":"…","message":"…"}}: đọc đúng mã để báo đúng nguyên nhân
  let code = "", msg = "";
  try { const d = JSON.parse(raw).detail || {}; code = String(d.status || d.code || "").toLowerCase(); msg = String(d.message || ""); } catch (_) {}
  if (service === "elevenlabs") {
    if (code.includes("unusual_activity") || b.includes("unusual activity"))
      return "ElevenLabs đã khoá gói miễn phí của tài khoản này vì phát hiện \u201choạt động bất thường\u201d (nhiều tài khoản miễn phí, hoặc gọi qua máy chủ/VPN)";
    if (code.includes("payment_required") || code.includes("paid_plan") || b.includes("library voices") || b.includes("free users cannot"))
      return "gói miễn phí không được dùng giọng lấy từ Voice Library qua API; hãy chọn giọng mặc định (premade) hoặc nâng cấp gói";
    if (code.includes("quota_exceeded") || b.includes("exceeds your quota") || b.includes("credits remaining"))
      return "hết ký tự của tháng" + (msg ? " (" + msg.slice(0, 120) + ")" : "");
    if (code.includes("voice_not_found") || b.includes("voice_not_found")) return "tài khoản này không có giọng đã chọn";
    if (code.includes("invalid_api_key") || code.includes("unauthorized")) return "sai key";
    if (code.includes("missing_permissions")) return "key thiếu quyền (bật quyền Text to Speech và Voices khi tạo key)";
    if (status === 429) return "gọi quá nhiều cùng lúc, thử lại sau";
    return `lỗi ${status}` + (msg ? ": " + msg.slice(0, 140) : (raw ? ": " + raw.slice(0, 140) : ""));
  }
  if (b.includes("quota") || status === 402) return "hết hạn mức";
  if (status === 429) return "quá giới hạn (hết hạn mức hoặc gọi quá nhanh)";
  if (status === 401) return "sai key hoặc sai vùng";
  if (status === 403) return "hết hạn mức hoặc key bị khoá";
  return `lỗi ${status}`;
}

// Thử lần lượt các key, bắt đầu từ key dùng được gần nhất; vòng lại từ đầu nếu cần
async function rotate(service, keys, start, fn) {
  if (!keys.length) throw new Error(`Chưa nhập key ${service}`);
  const errs = [];
  const first = Number.isInteger(start) && start >= 0 ? start % keys.length : 0;
  for (let n = 0; n < keys.length; n++) {
    const i = (first + n) % keys.length;
    try {
      const value = await fn(keys[i], i);
      return { value, index: i, skipped: errs };
    } catch (e) {
      errs.push({ index: i, msg: e instanceof KeyError ? e.message : "không kết nối được (" + e.message + ")" });
    }
  }
  throw new Error(keys.length === 1 ? errs[0].msg : `Cả ${keys.length} key ${service} đều không dùng được: ` + errs.map(e => `key ${e.index + 1}: ${e.msg}`).join("; "));
}

// Kiểm tra từng dịch vụ và từng key, trả về trạng thái để hiện trên trang
async function check(env) {
  const out = {};
  const safe = async fn => {
    try { return await fn(); }
    catch (e) { return { ok: false, msg: e instanceof KeyError ? e.message : "Không kết nối được: " + String(e.message || e) }; }
  };
  await Promise.all([
    (async () => {
      out.supabase = await safe(async () => {
        if (!env.SUPABASE_URL || !env.SUPABASE_KEY) return { ok: null, msg: "Chưa nhập" };
        if (sbKeyKind(env.SUPABASE_KEY) === "public") return { ok: false, msg: SB_WRONG_KEY };
        const r = await fetch(`${env.SUPABASE_URL}/rest/v1/sentences?select=id&limit=1`, { headers: sbHeaders(env) });
        if (r.status === 401 || r.status === 403) return { ok: false, msg: "Sai khoá Supabase" };
        if (r.status === 404 || r.status === 400) return { ok: false, msg: "Chưa có bảng sentences. Hãy chạy file supabase.sql trong SQL Editor." };
        if (!r.ok) return { ok: false, msg: `Lỗi ${r.status}` };
        const b = await fetch(`${env.SUPABASE_URL}/storage/v1/bucket/${CACHE_BUCKET}`, { headers: sbHeaders(env) });
        return b.ok ? { ok: true, msg: "Đã kết nối" } : { ok: true, msg: "Đã kết nối, nhưng chưa có kho tts-cache (âm thanh sẽ không được lưu lại)" };
      });
    })(),
    (async () => {
      // Azure Speech: đọc thử 1 chữ để phát hiện cả trường hợp hết hạn mức
      out.azure = await Promise.all(env.AZURE_KEYS.map(k => safe(async () => {
        await azureOnce("好", "zh-CN-XiaoxiaoNeural", 1, k);
        return { ok: true, msg: `Dùng được (vùng ${k.region})` };
      })));
    })(),
    (async () => {
      out.elevenlabs = await Promise.all(env.ELEVEN_KEYS.map(k => safe(async () => {
        const r = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": k.key } });
        if (r.ok) {
          const d = await r.json();
          const left = Math.max(0, (d.character_limit || 0) - (d.character_count || 0));
          const reset = d.next_character_count_reset_unix ? new Date(d.next_character_count_reset_unix * 1000).toLocaleDateString("vi-VN") : "";
          return { ok: left > 0, msg: left > 0 ? `Còn ${left.toLocaleString("vi-VN")} / ${(d.character_limit || 0).toLocaleString("vi-VN")} ký tự` + (reset ? `, làm mới ngày ${reset}` : "") : "Đã hết ký tự" + (reset ? `, làm mới ngày ${reset}` : "") };
        }
        // Key không có quyền xem gói cước: kiểm tra bằng danh sách giọng
        const v = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": k.key } });
        if (v.ok) return { ok: true, msg: "Dùng được (key không có quyền xem số ký tự còn lại)" };
        return { ok: false, msg: keyReason("elevenlabs", v.status, await v.text()) };
      })));
    })(),
    (async () => {
      out.translator = await Promise.all(env.TR_KEYS.map(k => safe(async () => {
        await translatorOnce(["好"], k);
        return { ok: true, msg: `Dùng được (vùng ${k.region})` };
      })));
    })(),
    (async () => {
      out.edge = await safe(async () => { await edgeTTS("好", "zh-CN-XiaoxiaoNeural", 1); return { ok: true, msg: "Hoạt động" }; });
    })()
  ]);
  return out;
}

function config(env) {
  return {
    edge: true,
    azure: env.AZURE_KEYS.length > 0,
    elevenlabs: env.ELEVEN_KEYS.length > 0,
    translator: env.TR_KEYS.length > 0,
    supabase: !!(env.SUPABASE_URL && env.SUPABASE_KEY),
    password: !!env.APP_PASSWORD,
    counts: { azure: env.AZURE_KEYS.length, elevenlabs: env.ELEVEN_KEYS.length, translator: env.TR_KEYS.length }
  };
}

/* ---------------- Giọng đọc ---------------- */
async function tts(url, env, ctx) {
  const p = url.searchParams.get("p") || "edge";
  const voice = url.searchParams.get("v") || "zh-CN-XiaoxiaoNeural";
  const rate = Math.min(1.5, Math.max(0.5, parseFloat(url.searchParams.get("r") || "1")));
  const model = url.searchParams.get("m") || "eleven_multilingual_v2";
  const text = (url.searchParams.get("t") || "").trim().slice(0, 500);
  if (!text) return fail("Thiếu nội dung cần đọc", 400);

  const keyStr = [p, voice, rate, p === "elevenlabs" ? model : "", text].join("|");
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(keyStr)))]
    .map(b => b.toString(16).padStart(2, "0")).join("");
  const path = `${p}/${hash}.mp3`;
  const headers = { "content-type": "audio/mpeg", "cache-control": "public, max-age=2592000" };

  // 1) Bộ đệm Supabase Storage (giữ lâu dài, đỡ tốn ký tự Azure/ElevenLabs)
  const sb = config(env).supabase;
  if (sb) {
    const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${CACHE_BUCKET}/${path}`, { headers: sbHeaders(env) });
    if (r.ok) return new Response(r.body, { headers: { ...headers, "x-cache": "HIT" } });
  }

  // 2) Tạo mới (Azure và ElevenLabs: tự chuyển key khi một key lỗi hoặc hết hạn mức)
  let audio, used = null;
  if (p === "edge") audio = await edgeTTS(text, voice, rate);
  else if (p === "azure") {
    used = await rotate("Azure", env.AZURE_KEYS, env.KEY_START.azure, k => azureOnce(text, voice, rate, k));
    audio = used.value;
  } else if (p === "elevenlabs") {
    used = await rotate("ElevenLabs", env.ELEVEN_KEYS, env.KEY_START.elevenlabs, k => elevenOnce(text, voice, rate, model, k));
    audio = used.value;
  } else return fail("Nguồn giọng không hợp lệ", 400);
  if (used) {
    headers["x-key-index"] = String(used.index);
    headers["x-key-skipped"] = String(used.skipped.length);
    if (used.skipped.length) headers["x-key-note"] = encodeURIComponent(used.skipped.map(e => `key ${e.index + 1}: ${e.msg}`).join("; "));
  }

  if (sb) {
    ctx.waitUntil(fetch(`${env.SUPABASE_URL}/storage/v1/object/${CACHE_BUCKET}/${path}`, {
      method: "POST",
      headers: { ...sbHeaders(env), "content-type": "audio/mpeg", "x-upsert": "true" },
      body: audio
    }).catch(() => {}));
  }
  return new Response(audio, { headers: { ...headers, "x-cache": "MISS", "access-control-expose-headers": "x-key-index, x-key-skipped, x-key-note, x-cache" } });
}

// Edge: cùng giao thức với thư viện Python edge-tts, chạy qua WebSocket
async function edgeTTS(text, voice, rate) {
  const qs = `TrustedClientToken=${EDGE_TOKEN}&ConnectionId=${uuid()}` +
    `&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=2-${EDGE_VERSION}`;
  const resp = await fetch(`https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?${qs}`, {
    headers: {
      Upgrade: "websocket",
      Pragma: "no-cache",
      "Cache-Control": "no-cache",
      Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${EDGE_MAJOR}.0.0.0 Safari/537.36 Edg/${EDGE_MAJOR}.0.0.0`,
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: `muid=${uuid().toUpperCase()};`
    }
  });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`Edge từ chối kết nối (mã ${resp.status}). Có thể Microsoft đã đổi cách xác thực; hãy cập nhật EDGE_VERSION theo edge-tts mới nhất.`);
  ws.accept();

  const date = edgeDate();
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Edge không phản hồi (quá 20 giây)")), 20000);
    ws.addEventListener("message", ev => {
      if (typeof ev.data === "string") {
        if (ev.data.includes("Path:turn.end")) { clearTimeout(timer); resolve(); }
        return;
      }
      const buf = new Uint8Array(ev.data);
      if (buf.length < 2) return;
      const hl = (buf[0] << 8) | buf[1];
      const head = new TextDecoder().decode(buf.slice(2, 2 + hl));
      if (head.includes("Path:audio") && buf.length > hl + 2) chunks.push(buf.slice(hl + 2));
    });
    ws.addEventListener("close", () => { clearTimeout(timer); resolve(); });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Lỗi WebSocket với Edge")); });
  });

  ws.send(`X-Timestamp:${date}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
    `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`);
  const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${xml(voice)}'><prosody pitch='+0Hz' rate='${pct(rate)}' volume='+0%'>${xml(text)}</prosody></voice></speak>`;
  ws.send(`X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${date}Z\r\nPath:ssml\r\n\r\n${ssml}`);

  await done;
  try { ws.close(); } catch (_) {}
  if (!chunks.length) throw new Error("Edge không trả về âm thanh");
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}

// Định dạng ngày giống JavaScript, ví dụ "Sat Oct 31 2026 09:05:00 GMT+0000 (Coordinated Universal Time)"
function edgeDate(d = new Date()) {
  const D = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], Mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const z = n => String(n).padStart(2, "0");
  return `${D[d.getUTCDay()]} ${Mo[d.getUTCMonth()]} ${z(d.getUTCDate())} ${d.getUTCFullYear()} ` +
    `${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

async function azureOnce(text, voice, rate, k) {
  const ssml = `<speak version='1.0' xml:lang='zh-CN'><voice name='${xml(voice)}'>` +
    `<prosody rate='${pct(rate)}'>${xml(text)}</prosody></voice></speak>`;
  const r = await fetch(`https://${k.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": k.key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "hoc-tieng-trung"
    },
    body: ssml
  });
  if (!r.ok) {
    const body = await r.text();
    throw new KeyError(r.status === 400 ? "giọng không có ở vùng này hoặc nội dung không hợp lệ" : keyReason("azure", r.status, body), r.status);
  }
  return await r.arrayBuffer();
}

async function elevenOnce(text, voice, rate, model, k) {
  const speed = Math.min(1.2, Math.max(0.7, 0.4 + rate * 0.6)); // ElevenLabs chỉ nhận 0.7–1.2
  const body = { text, model_id: model, voice_settings: { stability: 0.6, similarity_boost: 0.8, speed } };
  if (/_v2_5$/.test(model)) body.language_code = "zh";
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": k.key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new KeyError(keyReason("elevenlabs", r.status, await r.text()), r.status);
  return await r.arrayBuffer();
}

// Gộp giọng của mọi tài khoản ElevenLabs (mỗi key một tài khoản)
async function elevenVoices(env) {
  if (!env.ELEVEN_KEYS.length) return json({ voices: [] });
  const lists = await Promise.allSettled(env.ELEVEN_KEYS.map(async (k, i) => {
    const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": k.key } });
    if (!r.ok) throw new Error(`key ${i + 1}: ${keyReason("elevenlabs", r.status, await r.text())}`);
    return { i, voices: (await r.json()).voices || [] };
  }));
  const map = new Map();
  const errors = [];
  lists.forEach(res => {
    if (res.status !== "fulfilled") { errors.push(res.reason.message); return; }
    res.value.voices.forEach(v => {
      if (!map.has(v.voice_id)) map.set(v.voice_id, {
        id: v.voice_id, name: v.name,
        gender: (v.labels && v.labels.gender) || "",
        lang: (v.labels && (v.labels.language || v.labels.accent)) || "",
        category: v.category || "",
        keys: []
      });
      map.get(v.voice_id).keys.push(res.value.i + 1);
    });
  });
  if (!map.size && errors.length) return fail("ElevenLabs: " + errors.join("; "), 502);
  return json({ voices: [...map.values()], total: env.ELEVEN_KEYS.length, errors });
}

// Tìm giọng tiếng Trung trong Voice Library của ElevenLabs
async function elevenLibrary(url, env) {
  if (!env.ELEVEN_KEYS.length) return fail("Chưa nhập key ElevenLabs", 400);
  const q = new URLSearchParams({ page_size: "30", language: "zh", sort: "trending" });
  const g = url.searchParams.get("gender"); if (g === "male" || g === "female") q.set("gender", g);
  const search = (url.searchParams.get("q") || "").trim(); if (search) q.set("search", search);
  q.set("page", String(Math.max(0, parseInt(url.searchParams.get("page") || "0", 10) || 0)));
  const used = await rotate("ElevenLabs", env.ELEVEN_KEYS, env.KEY_START.elevenlabs, async k => {
    const r = await fetch("https://api.elevenlabs.io/v1/shared-voices?" + q, { headers: { "xi-api-key": k.key } });
    if (!r.ok) throw new KeyError(keyReason("elevenlabs", r.status, await r.text()), r.status);
    return r.json();
  });
  const d = used.value;
  return json({
    has_more: !!d.has_more,
    voices: (d.voices || []).map(v => ({
      voice_id: v.voice_id, owner: v.public_owner_id, name: v.name,
      gender: v.gender || "", age: v.age || "", accent: v.accent || "", locale: v.locale || "",
      description: (v.description || "").slice(0, 200), use_case: v.use_case || "",
      preview: v.preview_url || "", uses: v.cloned_by_count || v.usage_character_count_1y || 0
    }))
  });
}

// Thêm một giọng từ Voice Library vào My Voices của mọi tài khoản (mọi key), để tự chuyển key vẫn giữ được giọng
async function elevenAdd(request, env) {
  if (!env.ELEVEN_KEYS.length) return fail("Chưa nhập key ElevenLabs", 400);
  const b = await request.json();
  if (!b.owner || !b.voice_id) return fail("Thiếu thông tin giọng", 400);
  const name = String(b.name || "Giọng tiếng Trung").slice(0, 60);
  const results = await Promise.all(env.ELEVEN_KEYS.map(async (k, i) => {
    try {
      const r = await fetch(`https://api.elevenlabs.io/v1/voices/add/${encodeURIComponent(b.owner)}/${encodeURIComponent(b.voice_id)}`, {
        method: "POST",
        headers: { "xi-api-key": k.key, "content-type": "application/json" },
        body: JSON.stringify({ new_name: name })
      });
      const txt = await r.text();
      if (!r.ok) {
        const already = txt.includes("already") ;
        return { key: i + 1, ok: already, voice_id: already ? b.voice_id : "", msg: already ? "đã có sẵn" : (txt.includes("voice_limit") || txt.includes("limit") ? "tài khoản đã đầy chỗ chứa giọng" : keyReason("elevenlabs", r.status, txt)) };
      }
      let id = b.voice_id; try { id = JSON.parse(txt).voice_id || id; } catch (_) {}
      return { key: i + 1, ok: true, voice_id: id, msg: "đã thêm" };
    } catch (e) { return { key: i + 1, ok: false, msg: "không kết nối được" }; }
  }));
  return json({ results });
}

/* ---------------- Dịch sang tiếng Việt ---------------- */
// Có key Azure Translator thì dùng Azure (chính thức, 2 triệu ký tự/tháng miễn phí);
// không có thì dùng Google Translate miễn phí (không chính thức).
async function translatorOnce(texts, k) {
  const headers = { "Ocp-Apim-Subscription-Key": k.key, "content-type": "application/json" };
  if (k.region) headers["Ocp-Apim-Subscription-Region"] = k.region;
  const r = await fetch("https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=zh-Hans&to=vi", {
    method: "POST", headers, body: JSON.stringify(texts.map(t => ({ Text: t || " " })))
  });
  if (!r.ok) throw new KeyError(keyReason("translator", r.status, await r.text()), r.status);
  const d = await r.json();
  return d.map((x, i) => texts[i] ? (x.translations[0].text || "") : "");
}

async function googleTranslate(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 5) {
    out.push(...await Promise.all(texts.slice(i, i + 5).map(async t => {
      if (!t) return "";
      const r = await fetch("https://translate.googleapis.com/translate_a/single?client=gtx&sl=zh-CN&tl=vi&dt=t&q=" + encodeURIComponent(t));
      if (!r.ok) throw new Error(`Google Dịch lỗi ${r.status}`);
      const d = await r.json();
      return (d[0] || []).map(x => x[0]).join("").trim();
    })));
  }
  return out;
}

async function translate(request, env) {
  let texts = [];
  if (request.method === "POST") texts = (await request.json()).texts || [];
  else texts = [new URL(request.url).searchParams.get("t") || ""];
  texts = texts.map(t => String(t).trim().slice(0, 1000)).slice(0, 100);
  if (!texts.some(Boolean)) return json({ texts: texts.map(() => "") });

  // Có key Azure Translator thì thử lần lượt từng key; hết key dùng được thì chuyển sang Google Dịch miễn phí
  if (env.TR_KEYS.length) {
    try {
      const used = await rotate("Translator", env.TR_KEYS, env.KEY_START.translator, k => translatorOnce(texts, k));
      return json({ texts: used.value, by: "azure", keyIndex: used.index, skipped: used.skipped });
    } catch (e) {
      const t = await googleTranslate(texts);
      return json({ texts: t, by: "google", note: e.message });
    }
  }
  return json({ texts: await googleTranslate(texts), by: "google" });
}

/* ---------------- Supabase ---------------- */
// Khoá kiểu mới (sb_secret_…) chỉ gửi qua header apikey; khoá kiểu cũ (JWT service_role) gửi cả Authorization
const sbHeaders = env => String(env.SUPABASE_KEY).startsWith("sb_")
  ? { apikey: env.SUPABASE_KEY }
  : { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}` };

// Nhận biết khoá công khai (anon / publishable): khoá này bị chặn bởi row-level security
function sbKeyKind(key) {
  key = String(key || "");
  if (key.startsWith("sb_secret_")) return "secret";
  if (key.startsWith("sb_publishable_")) return "public";
  try {
    const p = JSON.parse(atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (p.role === "service_role") return "secret";
    if (p.role === "anon") return "public";
  } catch (_) {}
  return "unknown";
}
const SB_WRONG_KEY = "Bạn đang dùng khoá công khai (anon / publishable) nên Supabase chặn ghi dữ liệu. Hãy dùng khoá bí mật: Project Settings > API Keys > Secret keys (sb_secret_…), hoặc khoá service_role ở mục Legacy API keys.";

async function sb(env, path, init = {}) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...sbHeaders(env), "content-type": "application/json", Prefer: "return=representation", ...(init.headers || {}) }
  });
  const txt = await r.text();
  if (!r.ok) {
    if (txt.includes("row-level security") || txt.includes("42501")) throw new Error(SB_WRONG_KEY);
    throw new Error(`Supabase lỗi ${r.status}: ${txt.slice(0, 200)}`);
  }
  return txt ? JSON.parse(txt) : null;
}

async function sentences(request, url, env) {
  if (!config(env).supabase) return fail("Chưa cấu hình Supabase", 501);
  const id = url.pathname.split("/")[3];
  const pick = b => ({
    hanzi: String(b.hanzi || "").trim(),
    pinyin: String(b.pinyin || "").trim(),
    meaning: String(b.meaning || "").trim(),
    topic: String(b.topic || "").trim() || "Câu của tôi"
  });
  if (request.method === "GET") return json(await sb(env, "sentences?select=*&order=created_at.asc"));
  if (request.method === "POST") {
    const raw = await request.json();
    if (Array.isArray(raw)) { // dán nhiều câu một lúc
      const rows = raw.map(pick).filter(r => r.hanzi).slice(0, 500);
      if (!rows.length) return fail("Không có câu nào để lưu", 400);
      return json(await sb(env, "sentences", { method: "POST", body: JSON.stringify(rows) }));
    }
    const b = pick(raw);
    if (!b.hanzi) return fail("Chưa nhập câu tiếng Trung", 400);
    return json((await sb(env, "sentences", { method: "POST", body: JSON.stringify(b) }))[0]);
  }
  if (request.method === "PATCH" && id) {
    return json((await sb(env, `sentences?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(pick(await request.json())) }))[0]);
  }
  if (request.method === "DELETE" && id) {
    await sb(env, `sentences?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
    return json({ ok: true });
  }
  return fail("Phương thức không hợp lệ", 405);
}

async function settings(request, env) {
  if (!config(env).supabase) return fail("Chưa cấu hình Supabase", 501);
  if (request.method === "GET") {
    const rows = await sb(env, "app_settings?key=eq.default&select=value");
    return json(rows && rows[0] ? rows[0].value : null);
  }
  if (request.method === "PUT") {
    const rows = await sb(env, "app_settings?key=eq.default&select=value");
    const value = { ...((rows && rows[0] && rows[0].value) || {}), ...(await request.json()) };
    await sb(env, "app_settings", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ key: "default", value, updated_at: new Date().toISOString() })
    });
    return json({ ok: true });
  }
  return fail("Phương thức không hợp lệ", 405);
}

/* ---------------- Mã xác thực cho giọng Edge ---------------- */
// Port of edge-tts drm.py (generate_sec_ms_gec_v2) — tạo token Sec-MS-GEC cho dịch vụ đọc của Microsoft Edge.
// Dùng BigInt để giữ đúng phép tính số nguyên như bản Python.
const M = 0xFFFFFFFFn;
const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WIN_EPOCH = 11644473600;
const B = a => a.map(BigInt);
const INIT = B([0x6A09E667,0xBB67AE85,0x3C6EF372,0xA54FF53A,0x510E527F,0x9B05688C,0x1F83D9AB,0x5BE0CD19]);
const STATE = B([0xFD9FBEA2,0x91243CE7,0xBE499094,0xCD2E1E0A,0x6C006F49,0x04BD35AB,0xFEB0A7E4,0x03EFFBD2]);
const SCHED = B([0xEB24BF9E,0x1558691F,0xA0C09EE2,0x0CFA32BA,0xA622EE8C,0xD1DD9491,0xC0DD25A0,0xF9E70AB6,0xF0C31573,0x7058CE4E,0x7188E606,0x00E5AB33,0xD258B060,0x72766564]);
const K = B([0x428A2F98,0x71374491,0xB5C0FBCF,0xE9B5DBA5,0x3956C25B,0x59F111F1,0x923F82A4,0xAB1C5ED5,0xD807AA98,0x12835B01,0x243185BE,0x550C7DC3,0x72BE5D74,0x80DEB1FE,0x9BDC06A7,0xC19BF174,0xE49B69C1,0xEFBE4786,0x0FC19DC6,0x240CA1CC,0x2DE92C6F,0x4A7484AA,0x5CB0A9DC,0x76F988DA,0x983E5152,0xA831C66D,0xB00327C8,0xBF597FC7,0xC6E00BF3,0xD5A79147,0x06CA6351,0x14292967,0x27B70A85,0x2E1B2138,0x4D2C6DFC,0x53380D13,0x650A7354,0x766A0ABB,0x81C2C92E,0x92722C85,0xA2BFE8A1,0xA81A664B,0xC24B8B70,0xC76C51A3,0xD192E819,0xD6990624,0xF40E3585,0x106AA070,0x19A4C116,0x1E376C08,0x2748774C,0x34B0BCB5,0x391C0CB3,0x4ED8AA4A,0x5B9CCA4F,0x682E6FF3,0x748F82EE,0x78A5636F,0x84C87814,0x8CC70208,0x90BEFFFA,0xA4506CEB,0xBEF9A3F7,0xC67178F2]);
const ADJ = 0xC9DC06A7n;
const KB = [...K.slice(0,14), ADJ, ...K.slice(15)];
const SIG0_ADJ = 0x059C0B80n, SIG1_ADJ = 0x000B92C0n;
const CS = [[0xE82E91B1,0xB32700D0],[0x44DE24C6,0x88DFF51D],[0x3BEB65BC,0x29514038],[0xC89C5933,0xB328CBDF],[0x8D1EC211,0xD405B4D5],[0x314EF5D5,0x26E55F3C],[0xE92491B1,0x607801C6],[0xF0A5B9D5,0x82B2C1FB],[0x06064CF3,0xFA51A3DA],[0xDA79FA60,0x207CC464],[0xBED20560,0x3C3C74F3],[0x89F9C9F8,0xD2D14B61],[0x35FA38C6,0xBB04A2C1],[0xCB49E3C6,0xC5626167]].map(B);
const CS_F = 0x82893933n, CS_A0 = 0xF2F90B1An, CS_A1 = 0x0B1A0000n;

const rol16 = v => { v &= M; return ((v << 16n) | (v >> 16n)) & M; };
const sigma0 = v => ((v >> 7n) ^ (v << 25n) ^ (v >> 18n) ^ (v << 14n) ^ (v >> 3n)) & M;
const sigma1 = v => ((v >> 17n) ^ (v << 15n) ^ (v >> 19n) ^ (v << 13n) ^ (v >> 10n)) & M;
const beInt = bytes => bytes.reduce((a, b) => (a << 8n) | BigInt(b), 0n);

function rounds(state, w, first = 0) {
  let [a,b,c,d,e,f,g,h] = state;
  const k = first === 14 ? KB : K;
  for (let i = first; i < 64; i++) {
    const re = e * 0x100000001n, ra = a * 0x100000001n;
    const t1 = h + ((re >> 6n) ^ (re >> 11n) ^ (re >> 25n)) + (g ^ (e & (f ^ g))) + k[i] + w[i];
    const t2 = ((ra >> 2n) ^ (ra >> 13n) ^ (ra >> 22n)) + ((a & b) | (c & (a | b)));
    [a,b,c,d,e,f,g,h] = [(t1 + t2) & M, a, b, c, (d + t1) & M, e, f, g];
  }
  return [a,b,c,d,e,f,g,h];
}
function expand(w, first = 16) {
  for (let i = first; i < 64; i++) {
    const x = w[i-2], y = w[i-15];
    const s1 = (x >> 17n) ^ (x << 15n) ^ (x >> 19n) ^ (x << 13n) ^ (x >> 10n);
    const s0 = (y >> 7n) ^ (y << 25n) ^ (y >> 18n) ^ (y << 14n) ^ (y >> 3n);
    w.push((s1 + w[i-7] + s0 + w[i-16]) & M);
  }
}
function shaInit(d7) {
  const w = Array(14).fill(0n);
  w.push(beInt(d7.slice(0,3)), beInt(d7.slice(3,7)));
  for (let i = 16; i < 30; i++) {
    let v = SCHED[i-16];
    if (i - 2 >= 14) v += i === 16 ? (sigma1(w[i-2]) ^ SIG1_ADJ) : sigma1(w[i-2]);
    if (i - 7 >= 14) v += w[i-7];
    if (i - 15 >= 14) v += i === 29 ? (sigma0(w[i-15]) ^ SIG0_ADJ) : sigma0(w[i-15]);
    w.push(v & M);
  }
  w.push((sigma1(w[28]) + w[23] + sigma0(w[15]) + w[14] + ADJ - K[14]) & M);
  expand(w, 31);
  const wk = rounds(STATE, w, 14);
  return INIT.map((x, i) => (x + wk[i]) & M);
}
function shaDigest(data) {
  const len = 57 + data.length;
  const padLen = (((55 - len) % 64) + 64) % 64;
  const p = [...data.slice(7), 0x80, ...Array(padLen).fill(0)];
  let bits = BigInt(len * 8);
  const lb = []; for (let i = 0; i < 8; i++) { lb.unshift(Number(bits & 0xFFn)); bits >>= 8n; }
  p.push(...lb);
  let st = shaInit(data.slice(0,7));
  for (let o = 0; o < p.length; o += 64) {
    const w = []; for (let j = 0; j < 16; j++) w.push(beInt(p.slice(o + j*4, o + j*4 + 4)));
    expand(w);
    const wk = rounds(st, w);
    st = st.map((x, i) => (x + wk[i]) & M);
  }
  const out = []; for (const x of st) for (let s = 24n; s >= 0n; s -= 8n) out.push(Number((x >> s) & 0xFFn));
  return out;
}
const leInt = b => b.reduceRight((a, x) => (a << 8n) | BigInt(x), 0n);
function cs64(data, digest) {
  let ka = leInt(digest.slice(0,4)) | 1n, kb = leInt(digest.slice(4,8)) | 1n;
  const fac = [(ka * CS_F) & M, (kb * CS_F) & M];
  const terms = CS.map(([c], i) => (c * fac[i % 2]) & M);
  const offs = CS.map(([, o]) => o);
  const raw = [0, ...data]; while (raw.length % 4) raw.push(0);
  const words = []; for (let i = 0; i < raw.length; i += 4) words.push(leInt(raw.slice(i, i+4)));
  if (words.length % 2) words.push(0n);
  words.forEach((wd, i) => {
    let term = wd * (i % 2 === 0 ? ka : kb);
    let off = rol16(wd) * (i % 2 === 0 ? 0xEF0569FBn : 0xC31713DBn);
    if (i === 0) { term += CS_A0 * fac[0]; off += CS_A1; }
    terms.push(term & M); offs.push(off & M);
  });
  let sAcc = 0n, sLast = 0n, st = 0n, acc = 0n;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i+1];
    let t = rol16((offs[i] + x) & M), q = (t * 0x76F50F34n) & M;
    sAcc += (rol16(q) * 0xC3EFEA97n + q) & M;
    t = rol16((offs[i+1] + y) & M); q = (t * 0x1881CE3Cn) & M;
    sLast = (rol16(q) * 0x35BD1EC9n + q) & M;
    sAcc = (sAcc + sLast) & M;
    st = (st * ka + x) & M;
    st = (rol16(st) * 0xCF98B111n) & M; st = (rol16(st) * 0x87085B9Fn) & M;
    st = (rol16(st) * 0x12CEB96Dn) & M; st = (rol16(st) * 0x257E1D83n) & M;
    acc += st;
    t = (st * kb + y) & M; t = (rol16(t) * 0xA27416F5n) & M; t = (rol16(t) * 0xD38396FFn) & M;
    st = (rol16((rol16(t) * 0x7C932B89n) & M) * 0xBFA49F69n) & M;
    acc = (acc + st) & M;
  }
  return [sLast ^ st, sAcc ^ acc];
}
const hex = bytes => bytes.map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
const le32 = v => [0,8,16,24].map(s => Number((v >> BigInt(s)) & 0xFFn));

function generateSecMsGec(unixSeconds = Date.now() / 1000) {
  let ticks = unixSeconds + WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= 1e9 / 100;
  const str = BigInt(Math.round(ticks)).toString() + TOKEN;
  const data = [...new TextEncoder().encode(str)];
  const dg = shaDigest(data);
  const [c1, c2] = cs64(data, dg);
  return hex([...le32(c1), ...le32(c2)]) + "-" + hex(dg);
}
