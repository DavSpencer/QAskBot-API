// این فایل به‌صورت خودکار روی مسیر  /api/submit  در Cloudflare Pages اجرا می‌شود.
// نیازی به دیپلوی جدا یا سرور جدا نیست؛ همراه خود سایت روی Cloudflare اجرا می‌شود.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // این دو مقدار باید در تنظیمات پروژه‌ی Cloudflare Pages
  // به‌عنوان Environment Variables (Secret) ست شوند:
  // TELEGRAM_BOT_TOKEN  و  TELEGRAM_CHAT_ID
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return json({ ok: false, error: "TELEGRAM_BOT_TOKEN یا TELEGRAM_CHAT_ID تنظیم نشده است." }, 500);
  }

  let data;
  try {
    data = await request.json();
  } catch (e) {
    return json({ ok: false, error: "بدنه درخواست نامعتبر است." }, 400);
  }

  const chunks = buildMessageChunks(data);

  try {
    for (const chunk of chunks) {
      const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: "HTML",
        }),
      });

      if (!tgRes.ok) {
        const errBody = await tgRes.text();
        return json({ ok: false, error: `تلگرام خطا داد: ${errBody}` }, 502);
      }
    }
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
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

function buildMessageChunks(data) {
  const lines = [];
  lines.push("📋 <b>پرسشنامه جدید طراحی سایت</b>");
  lines.push("");
  lines.push(`👤 <b>نام:</b> ${esc(data.name)}`);
  lines.push(`📞 <b>شماره تماس:</b> ${esc(data.phone)}`);
  lines.push("");
  lines.push(esc(data.summary));

  const full = lines.join("\n");
  const LIMIT = 3800; // Telegram limit is 4096, keep margin
  const chunks = [];
  let rest = full;
  while (rest.length > LIMIT) {
    let cut = rest.lastIndexOf("\n", LIMIT);
    if (cut <= 0) cut = LIMIT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  return chunks;
}
