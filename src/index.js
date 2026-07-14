// این فایل، خود Worker است. هم سایت استاتیک (پوشهٔ public) را سرو می‌کند
// و هم مسیر /api/submit را مدیریت می‌کند تا پیام را به تلگرام بفرستد.
// چون این Worker کد واقعی دارد (نه فقط فایل استاتیک)، متغیرهای محیطی
// (TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID) به‌درستی روی آن قابل تعریف هستند.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// توکن ربات و شناسه چت، مستقیم اینجا نوشته شده تا نیازی به
// تنظیم متغیر محیطی در داشبورد Cloudflare نباشد.
const TELEGRAM_BOT_TOKEN = "8866202792:AAHn54Z6CD3YekJkqzP0ly23btW54Zs8rlU";
const TELEGRAM_CHAT_ID = "2071415040";

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

    // هر مسیر دیگری: فایل استاتیک متناظر از پوشهٔ public سرو می‌شود
    return env.ASSETS.fetch(request);
  },
};

async function handleSubmit(request, env) {
  const token = TELEGRAM_BOT_TOKEN;
  const chatId = TELEGRAM_CHAT_ID;

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
