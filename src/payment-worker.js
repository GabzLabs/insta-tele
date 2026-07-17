import { config } from "./config.js";
import {
  getOrder,
  listPaidOrdersWithoutNotification,
  listPendingEvents,
  markEventDone,
  markEventProcessing,
  markEventRetry,
  markOrderPaid
} from "./db.js";
import { checkPayment } from "./infinitepay.js";
import { logger } from "./logger.js";

export function createPaymentWorker(deliveryService) {
  let running = false;
  let timer;

  async function processEvent(event) {
    markEventProcessing(event.id);

    try {
      const payload = JSON.parse(event.payload);
      const order = getOrder(event.order_nsu);

      if (!order) {
        throw new Error("Pedido do webhook não existe no banco.");
      }

      const invoiceSlug = String(payload.invoice_slug ?? "");
      const transactionNsu = String(payload.transaction_nsu ?? "");

      if (!invoiceSlug || !transactionNsu) {
        throw new Error("Webhook sem invoice_slug ou transaction_nsu.");
      }

      const confirmation = await checkPayment({
        orderNsu: order.order_nsu,
        transactionNsu,
        invoiceSlug
      });

      if (!confirmation?.success || !confirmation?.paid) {
        throw new Error("Pagamento ainda não confirmado pela InfinitePay.");
      }

      if (Number(confirmation.amount) !== Number(order.amount_cents)) {
        throw new Error(
          `Valor divergente. Esperado ${order.amount_cents}, recebido ${confirmation.amount}.`
        );
      }

      const captureMethod = String(confirmation.capture_method ?? payload.capture_method ?? "");
      if (!config.allowedCaptureMethods.includes(captureMethod)) {
        throw new Error(`Método de pagamento não permitido: ${captureMethod}`);
      }

      const paidOrder = markOrderPaid({
        orderNsu: order.order_nsu,
        transactionNsu,
        invoiceSlug,
        receiptUrl: payload.receipt_url ?? null,
        captureMethod
      });

      await deliveryService.ensureInviteAndNotify(paidOrder);
      markEventDone(event.id);

      logger.info(
        { orderNsu: order.order_nsu, transactionNsu, captureMethod },
        "Pagamento confirmado e acesso processado"
      );
    } catch (error) {
      markEventRetry(event.id, error?.message ?? error);
      logger.error({ err: error, eventId: event.id }, "Falha ao processar pagamento");
    }
  }

  async function tick() {
    if (running) return;
    running = true;

    try {
      const events = listPendingEvents(10);
      for (const event of events) {
        await processEvent(event);
      }

      const paidWithoutNotification = listPaidOrdersWithoutNotification(10);
      for (const order of paidWithoutNotification) {
        try {
          await deliveryService.ensureInviteAndNotify(order);
        } catch (error) {
          logger.error({ err: error, orderNsu: order.order_nsu }, "Falha ao reenviar convite");
        }
      }
    } finally {
      running = false;
    }
  }

  function start() {
    timer = setInterval(() => void tick(), 5_000);
    timer.unref?.();
    void tick();
  }

  function stop() {
    if (timer) clearInterval(timer);
  }

  return { start, stop, tick };
}
