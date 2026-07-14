// این فایل، خود Worker است:
// - سایت استاتیک (پوشهٔ public) را سرو می‌کند
// - مسیر /api/submit را مدیریت می‌کند (دریافت فرم و ارسال به تلگرام)
// - مسیر /telegram-webhook را مدیریت می‌کند (دستورهای ادمین: /adduser /deluser /list)
//
// مقادیر حساس (توکن ربات، شناسهٔ ادمین، سکرت webhook) دیگر داخل کد نیستند؛
// باید در Cloudflare Dashboard → پروژهٔ Worker → Settings → Variables and Secrets تعریف شوند:
//   TELEGRAM_BOT_TOKEN
//   ADMIN_CHAT_ID
//   TELEGRAM_WEBHOOK_SECRET
// و یک KV Namespace با نام binding دقیقاً "USERS_KV" باید به Worker متصل شود (در wrangler.jsonc).

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/submit") {
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: CORS_HEADERS });
      }
      if (request.method === "POST") {
        return handleSubmit(request, env);
      }
      return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
    }

    if (url.pathname === "/telegram-webhook" && request.method === "POST") {
      return handleTelegramWebhook(request, env);
    }

    // هر مسیر دیگری: فایل استاتیک متناظر از پوشهٔ public سرو می‌شود
    return env.ASSETS.fetch(request);
  },
};

/* =========================================================
   دریافت فرم و ارسال به همهٔ گیرنده‌ها (ادمین + کاربران لیست)
========================================================= */
async function handleSubmit(request, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const adminId = env.ADMIN_CHAT_ID;

  if (!token || !adminId) {
    return json({ ok: false, error: "TELEGRAM_BOT_TOKEN یا ADMIN_CHAT_ID تنظیم نشده است." }, 500);
  }

  let data;
  try {
    data = await request.json();
  } catch (e) {
    return json({ ok: false, error: "بدنه درخواست نامعتبر است." }, 400);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "نامشخص";
  const datetime = formatShamsiDateTime(new Date());
  const meta = { ip, datetime };
  const chunks = buildMessageChunks(data, meta);

  const users = await getUsers(env);
  const recipients = [String(adminId), ...users.filter((u) => u !== String(adminId))];

  let adminOk = false;
  const failedRecipients = [];

  for (const rid of recipients) {
    let recipientOk = true;
    for (const chunk of chunks) {
      const sent = await sendTelegramRaw(token, rid, chunk);
      if (!sent.ok) {
        recipientOk = false;
        console.log("[submit] send failed for", rid, sent.error);
      }
    }
    if (rid === String(adminId)) adminOk = recipientOk;
    if (!recipientOk) failedRecipients.push(rid);
  }

  if (!adminOk) {
    return json({ ok: false, error: "ارسال پیام به ادمین ناموفق بود؛ توکن یا ADMIN_CHAT_ID را بررسی کنید." }, 502);
  }

  return json({ ok: true, meta, failedRecipients });
}

/* =========================================================
   Webhook تلگرام: پاسخ به /start و دستورهای ادمین
========================================================= */
async function handleTelegramWebhook(request, env) {
  // تایید اینکه درخواست واقعاً از طرف تلگرام است (نه یک درخواست جعلی)
  const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!env.TELEGRAM_WEBHOOK_SECRET || secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  let update;
  try {
    update = await request.json();
  } catch (e) {
    return new Response("ok"); // همیشه ۲۰۰ برمی‌گردانیم تا تلگرام دوباره تلاش نکند
  }

  const msg = update.message;
  if (!msg || !msg.text) return new Response("ok");

  const fromId = String(msg.from.id);
  const chatId = String(msg.chat.id);
  const text = msg.text.trim();
  const adminId = String(env.ADMIN_CHAT_ID || "");
  const token = env.TELEGRAM_BOT_TOKEN;

  if (text === "/start") {
    await sendTelegramRaw(
      token,
      chatId,
      `👋 سلام!\nشناسهٔ عددی شما: <code>${esc(fromId)}</code>\n\nاگر می‌خواهید نتیجهٔ پرسشنامه‌های تکمیل‌شده را دریافت کنید، این عدد را برای مدیر بفرستید تا شما را اضافه کند.`
    );
    return new Response("ok");
  }

  // از این به بعد فقط ادمین اجازهٔ دستور دارد
  if (fromId !== adminId) {
    if (text.startsWith("/")) {
      await sendTelegramRaw(token, chatId, "⛔ شما اجازهٔ استفاده از این دستور را ندارید.");
    }
    return new Response("ok");
  }

  const parts = text.split(/\s+/);
  const cmd = parts[0];

  if (cmd === "/adduser") {
    const targetId = parts[1];
    if (!targetId || !/^-?\d+$/.test(targetId)) {
      await sendTelegramRaw(token, chatId, "فرمت درست: <code>/adduser 123456789</code>\nشناسهٔ عددی را از خود شخص بگیرید (با فرستادن /start به ربات، شناسه‌اش را می‌بیند).");
      return new Response("ok");
    }
    const users = await getUsers(env);
    if (users.includes(targetId)) {
      await sendTelegramRaw(token, chatId, `این کاربر (<code>${esc(targetId)}</code>) از قبل در لیست بود.`);
    } else {
      users.push(targetId);
      await saveUsers(env, users);
      await sendTelegramRaw(token, chatId, `✅ کاربر <code>${esc(targetId)}</code> اضافه شد و از این پس فرم‌های تکمیل‌شده برایش هم ارسال می‌شود.`);
    }
    return new Response("ok");
  }

  if (cmd === "/deluser") {
    const targetId = parts[1];
    const users = await getUsers(env);
    const next = users.filter((u) => u !== targetId);
    await saveUsers(env, next);
    await sendTelegramRaw(
      token,
      chatId,
      next.length < users.length
        ? `🗑 کاربر <code>${esc(targetId)}</code> حذف شد.`
        : `کاربری با شناسهٔ <code>${esc(targetId)}</code> در لیست نبود.`
    );
    return new Response("ok");
  }

  if (cmd === "/list") {
    const users = await getUsers(env);
    const lines = [`👑 ادمین: <code>${esc(adminId)}</code>`];
    if (users.length) {
      lines.push("", "👥 کاربران اضافه‌شده:");
      users.forEach((u) => lines.push(`• <code>${esc(u)}</code>`));
    } else {
      lines.push("", "هیچ کاربر دیگری اضافه نشده.");
    }
    await sendTelegramRaw(token, chatId, lines.join("\n"));
    return new Response("ok");
  }

  await sendTelegramRaw(
    token,
    chatId,
    "دستورهای موجود:\n<code>/adduser [شناسه]</code> — افزودن گیرنده\n<code>/deluser [شناسه]</code> — حذف گیرنده\n<code>/list</code> — نمایش لیست گیرنده‌ها"
  );
  return new Response("ok");
}

/* =========================================================
   کمکی‌ها
========================================================= */
async function getUsers(env) {
  const raw = await env.USERS_KV.get("users");
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

async function saveUsers(env, users) {
  await env.USERS_KV.put("users", JSON.stringify(users));
}

async function sendTelegramRaw(token, chatId, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      return { ok: false, error: errBody };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function formatShamsiDateTime(date) {
  try {
    const dtf = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
      timeZone: "Asia/Tehran",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    return dtf.format(date);
  } catch (e) {
    return date.toISOString();
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// هر «بلوک» یک واحد کامل و قابل‌بستن از تگ‌هاست (هرگز وسط یک بلوک بریده نمی‌شود)
// تا وقتی پیام به چند تکه تقسیم می‌شود، تگ‌های HTML همیشه بسته و سالم بمانند.
function buildBlocks(data) {
  const blocks = [];

  blocks.push("📋 <b>پرسشنامه جدید طراحی سایت</b>");

  blocks.push(
    `👤 <b>نام:</b>\n<blockquote>${esc(data.name || "—")}</blockquote>\n` +
    `📞 <b>شماره تماس:</b>\n<blockquote>${esc(data.phone || "—")}</blockquote>`
  );

  (data.sections || []).forEach((sec) => {
    const rows = (sec.rows || [])
      .map((r) => `<b>${esc(r.q)}</b>\n<blockquote>${esc(r.a || "—")}</blockquote>`)
      .join("\n\n");
    blocks.push(`<b>▸ ${esc(sec.title)}</b>\n\n${rows}`);
  });

  return blocks;
}

function buildMessageChunks(data, meta) {
  const blocks = buildBlocks(data);

  if (meta) {
    blocks.push(
      `🕒 <b>تاریخ و ساعت تکمیل:</b>\n<blockquote>${esc(meta.datetime)}</blockquote>\n` +
      `🌐 <b>آی‌پی:</b>\n<blockquote>${esc(meta.ip)}</blockquote>`
    );
  }

  const LIMIT = 3800; // Telegram limit is 4096, keep margin
  const chunks = [];
  let current = "";

  for (const block of blocks) {
    const candidate = current ? current + "\n\n" + block : block;
    if (candidate.length > LIMIT && current) {
      chunks.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
