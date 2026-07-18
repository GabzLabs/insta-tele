import {
  getOrderByTxid,
  listPaidOrdersWithoutNotification,
  listPendingEvents,
  markEventDone,
  markEventProcessing,
  markEventRetry,
  markOrderPaid
} from "./db.js";

import {
  detailPixCharge,
  getPaymentData,
  isChargePaid
} from "./efi.js";

import { logger } from "./logger.js";

export async function confirmOrderPayment(
  order,
  deliveryService
) {
  if (!order?.txid) {
    return {
      paid: false,
      reason: "missing_txid"
    };
  }

  const charge =
    await detailPixCharge(
      order.txid
    );

  const paid = isChargePaid(
    charge,
    order.amount_cents
  );

  if (!paid) {
    return {
      paid: false,
      charge
    };
  }

  const payment =
    getPaymentData(charge);

  const paidOrder =
    markOrderPaid({
      orderNsu:
        order.order_nsu,

      endToEndId:
        payment.endToEndId,

      paidAt:
        payment.paidAt
    });

  await deliveryService
    .ensureInviteAndNotify(
      paidOrder
    );

  return {
    paid: true,
    order: paidOrder,
    charge
  };
}

export function createPaymentWorker(
  deliveryService
) {
  let running = false;
  let timer;

  async function processEvent(event) {
    markEventProcessing(event.id);

    try {
      const order =
        getOrderByTxid(
          event.txid
        );

      if (!order) {
        throw new Error(
          "Webhook recebido para txid desconhecido."
        );
      }

      const result =
        await confirmOrderPayment(
          order,
          deliveryService
        );

      if (!result.paid) {
        throw new Error(
          "Cobrança ainda não consta como CONCLUIDA na Efí."
        );
      }

      markEventDone(event.id);

      logger.info(
        {
          txid: event.txid,
          orderNsu:
            order.order_nsu
        },
        "Pix confirmado e acesso processado"
      );
    } catch (error) {
      markEventRetry(
        event.id,
        error?.message ?? error
      );

      logger.error(
        {
          err: error,
          eventId: event.id
        },
        "Falha ao processar webhook Pix"
      );
    }
  }

  async function tick() {
    if (running) {
      return;
    }

    running = true;

    try {
      const events =
        listPendingEvents(10);

      for (const event of events) {
        await processEvent(event);
      }

      const paidOrders =
        listPaidOrdersWithoutNotification(
          10
        );

      for (
        const order
        of paidOrders
      ) {
        try {
          await deliveryService
            .ensureInviteAndNotify(
              order
            );
        } catch (error) {
          logger.error(
            {
              err: error,
              orderNsu:
                order.order_nsu
            },
            "Falha ao reenviar convite"
          );
        }
      }
    } finally {
      running = false;
    }
  }

  function start() {
    timer = setInterval(() => {
      void tick();
    }, 5000);

    timer.unref?.();

    void tick();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
    }
  }

  return {
    start,
    stop,
    tick
  };
}