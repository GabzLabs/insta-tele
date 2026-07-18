import http from "node:http";

import { config } from "./config.js";

import {
  databaseHealthCheck,
  enqueuePaymentEvent
} from "./db.js";

import { logger } from "./logger.js";

export function createServer(
  paymentWorker
) {
  return http.createServer(
    async (request, response) => {
      try {
        const url = new URL(
          request.url ?? "/",
          `http://${request.headers.host ?? "localhost"}`
        );

        if (
          request.method === "GET" &&
          url.pathname === "/health"
        ) {
          const healthy =
            databaseHealthCheck();

          return sendJson(
            response,
            healthy ? 200 : 503,
            {
              ok: healthy,
              provider: "efi"
            }
          );
        }

        const webhookBase =
          `/webhooks/efi/${config.webhookSecret}`;

        const isWebhook =
          request.method === "POST" &&
          (
            url.pathname === webhookBase ||
            url.pathname ===
              `${webhookBase}/pix`
          );

        if (isWebhook) {
          const payload =
            await readJson(
              request,
              256 * 1024
            );

          /*
           * A Efí faz uma chamada de teste
           * ao configurar o webhook.
           * Essa chamada pode não possuir pix[].
           */
          if (!Array.isArray(payload?.pix)) {
            return sendJson(
              response,
              200,
              {
                ok: true,
                test: true
              }
            );
          }

          const events =
            enqueuePaymentEvent(
              payload
            );

          sendJson(
            response,
            200,
            {
              ok: true
            }
          );

          if (events.length) {
            setImmediate(() => {
              void paymentWorker.tick();
            });
          }

          return;
        }

        return sendJson(
          response,
          404,
          {
            ok: false,
            error: "not_found"
          }
        );
      } catch (error) {
        logger.error(
          { err: error },
          "Erro HTTP"
        );

        return sendJson(
          response,
          error?.statusCode ?? 500,
          {
            ok: false,
            error: "internal_error"
          }
        );
      }
    }
  );
}

async function readJson(
  request,
  maximumSize
) {
  const chunks = [];
  let totalSize = 0;

  for await (
    const chunk
    of request
  ) {
    totalSize += chunk.length;

    if (totalSize > maximumSize) {
      const error =
        new Error(
          "Payload grande demais."
        );

      error.statusCode = 413;

      throw error;
    }

    chunks.push(chunk);
  }

  const text =
    Buffer.concat(chunks)
      .toString("utf8");

  try {
    return text
      ? JSON.parse(text)
      : {};
  } catch {
    const error =
      new Error("JSON inválido.");

    error.statusCode = 400;

    throw error;
  }
}

function sendJson(
  response,
  status,
  body
) {
  const data =
    JSON.stringify(body);

  response.writeHead(status, {
    "content-type":
      "application/json; charset=utf-8",

    "content-length":
      Buffer.byteLength(data),

    "cache-control":
      "no-store",

    "x-content-type-options":
      "nosniff"
  });

  response.end(data);
}