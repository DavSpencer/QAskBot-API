// این فایل به‌صورت خودکار روی مسیر  /api/submit  در Cloudflare Pages اجرا می‌شود.
// نیازی به دیپلوی جدا یا سرور جدا نیست؛ همراه خود سایت روی Cloudflare اجرا می‌شود.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// توکن ربات و شناسه چت، مستقیم اینجا نوشته شده تا نیازی به
// تنظیم متغیر محیطی در داشبورد Cloudflare نباشد.
const TELEGRAM_BOT_TOKEN = "8866202792:AAHn54Z6CD3YekJkqzP0ly23btW54Zs8rlU";
const TELEGRAM_CHAT_ID = "2071415040";

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request } = context;
  const token = TELEGRAM_BOT_TOKEN;
  const chatId = TELEGRAM_CHAT_ID;

  console.log("[submit] incoming request");

  let data;
  try {
    data = await request.json();
    console.log("[submit] parsed body, name:", data.name, "phone:", data.phone, "summary length:", (data.summary||"").length);
  } catch (e) {
    console.log("[submit] JSON parse failed:", e.message);
    return json({ ok: false, error: "بدنه درخواست نامعتبر است." }, 400);
  }

  const chunks = buildMessageChunks(data);
  console.log("[submit] sending", chunks.length, "chunk(s) to chat_id:", chatId);

  try {
    for (const [i, chunk] of chunks.entries()) {
      const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: "HTML",
        }),
      });

      console.log("[submit] chunk", i, "telegram status:", tgRes.status);

      if (!tgRes.ok) {
        const errBody = await tgRes.text();
        console.log("[submit] telegram error body:", errBody);
        return json({ ok: false, error: `تلگرام خطا داد: ${errBody}` }, 502);
      }
    }
    console.log("[submit] all chunks sent successfully");
    return json({ ok: true });
  } catch (err) {
    console.log("[submit] fetch to telegram threw:", err.message);
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
