import {
  createBotController
} from "./bot.js";

import { config } from "./config.js";

import {
  createDeliveryService
} from "./delivery.js";

import {
  configurePixWebhook
} from "./efi.js";

import { logger } from "./logger.js";

import {
  createPaymentWorker
} from "./payment-worker.js";

import {
  createServer
} from "./server.js";

import {
  TelegramClient
} from "./telegram.js";

const telegram =
  new TelegramClient(
    config.botToken
  );

const deliveryService =
  createDeliveryService(
    telegram
  );

const paymentWorker =
  createPaymentWorker(
    deliveryService
  );

const botController =
  createBotController(
    telegram,
    deliveryService
  );

const server =
  createServer(
    paymentWorker
  );

server.listen(
  config.port,
  () => {
    logger.info(
      {
        port: config.port
      },
      "Servidor iniciado"
    );
  }
);

paymentWorker.start();

if (
  config.efiConfigureWebhookOnStart
) {
  try {
    const result =
      await configurePixWebhook();

    logger.info(
      {
        webhookUrl:
          result.webhookUrl
      },
      "Webhook Pix Efí configurado"
    );
  } catch (error) {
    logger.error(
      {
        err: error
      },
      "Não foi possível configurar o webhook Efí automaticamente"
    );
  }
}

const bot =
  await telegram.getMe();

botController.setBotUsername(
  bot.username
);

logger.info(
  {
    username: bot.username
  },
  "Bot conectado"
);

void telegram.start(
  botController.handleUpdate
);

async function shutdown(signal) {
  logger.info(
    { signal },
    "Encerrando aplicação"
  );

  paymentWorker.stop();
  telegram.stop();

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 8000).unref();
}

process.once(
  "SIGINT",
  () => {
    void shutdown("SIGINT");
  }
);

process.once(
  "SIGTERM",
  () => {
    void shutdown("SIGTERM");
  }
);