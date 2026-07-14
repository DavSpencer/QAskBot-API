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

  const ip = request.headers.get("CF-Connecting-IP") || "نامشخص";
  const datetime = formatShamsiDateTime(new Date());
  const meta = { ip, datetime };

  const chunks = buildMessageChunks(data, meta);

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
    return json({ ok: true, meta });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
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
