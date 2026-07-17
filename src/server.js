import http from "node:http";
import { config } from "./config.js";
import { databaseHealthCheck, enqueuePaymentEvent } from "./db.js";
import { logger } from "./logger.js";

export function createServer(paymentWorker) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, databaseHealthCheck() ? 200 : 503, {
          ok: databaseHealthCheck()
        });
      }

      if (req.method === "GET" && url.pathname === "/payment-success") {
        return html(res, 200, successPage());
      }

      if (
        req.method === "POST" &&
        url.pathname === `/webhooks/infinitepay/${config.webhookSecret}`
      ) {
        const payload = await readJson(req, 256 * 1024);
        const required = ["transaction_nsu", "order_nsu", "invoice_slug"];
        const missing = required.filter((field) => !payload?.[field]);

        if (missing.length > 0) {
          logger.warn({ missing }, "Webhook InfinitePay inválido");
          return json(res, 400, { ok: false, error: "invalid_payload" });
        }

        const { event } = enqueuePaymentEvent(payload);
        json(res, 200, { ok: true });
        if (event) setImmediate(() => void paymentWorker.tick());
        return;
      }

      json(res, 404, { ok: false, error: "not_found" });
    } catch (error) {
      logger.error({ err: error }, "Erro HTTP não tratado");
      json(res, error?.statusCode ?? 500, { ok: false });
    }
  });
}

async function readJson(req, maxBytes) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("Payload grande demais.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    const error = new Error("JSON inválido.");
    error.statusCode = 400;
    throw error;
  }
}

function json(res, status, body) {
  if (res.writableEnded) return;
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(data);
}

function html(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'"
  });
  res.end(body);
}

function successPage() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pagamento concluído</title>
  <style>
    body{margin:0;background:#0b0b0f;color:#fff;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px}
    main{max-width:520px;background:#17171f;border:1px solid #2b2b38;border-radius:20px;padding:32px;text-align:center}
    h1{margin-top:0}.ok{font-size:52px}p{color:#c8c8d2;line-height:1.55}
  </style>
</head>
<body>
  <main>
    <div class="ok">✅</div>
    <h1>Pagamento enviado</h1>
    <p>Volte ao Telegram. Assim que a InfinitePay confirmar, o bot enviará automaticamente o link de acesso ao canal privado.</p>
  </main>
</body>
</html>`;
}
