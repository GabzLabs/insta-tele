import { createBotController } from "./bot.js";
import { config } from "./config.js";
import { createDeliveryService } from "./delivery.js";
import { logger } from "./logger.js";
import { createPaymentWorker } from "./payment-worker.js";
import { createServer } from "./server.js";
import { TelegramClient } from "./telegram.js";

const telegram = new TelegramClient(config.botToken);
const deliveryService = createDeliveryService(telegram);
const paymentWorker = createPaymentWorker(deliveryService);
const botController = createBotController(telegram, deliveryService);
const server = createServer(paymentWorker);

server.listen(config.port, () => {
  logger.info({ port: config.port }, "Servidor HTTP iniciado");
});

paymentWorker.start();

const me = await telegram.getMe();
botController.setBotUsername(me.username);
logger.info({ username: me.username }, "Bot conectado ao Telegram");

void telegram.start(botController.handleUpdate);

async function shutdown(signal) {
  logger.info({ signal }, "Encerrando aplicação");
  paymentWorker.stop();
  telegram.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8_000).unref();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
