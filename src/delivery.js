import { config } from "./config.js";

import {
  getOrder,
  markInviteNotified,
  setInvite
} from "./db.js";

import { logger } from "./logger.js";

export function createDeliveryService(telegram) {
  async function ensureInviteAndNotify(
    originalOrder,
    options = {}
  ) {
    let order =
      getOrder(originalOrder.order_nsu);

    if (!order) {
      throw new Error(
        "Pedido não encontrado para entrega."
      );
    }

    if (
      !["PAID", "DELIVERED"]
        .includes(order.status)
    ) {
      throw new Error(
        "O pedido ainda não está pago."
      );
    }

    const nowInSeconds =
      Math.floor(Date.now() / 1000);

    const inviteExpired =
      !order.invite_link ||
      !order.invite_expires_at ||
      Number(order.invite_expires_at) <=
        nowInSeconds + 300;

    if (
      inviteExpired ||
      options.forceNew
    ) {
      if (order.invite_link) {
        await telegram
          .revokeChatInviteLink(
            config.privateChannelId,
            order.invite_link
          )
          .catch(() => {});
      }

      const expireDate =
        nowInSeconds +
        config.inviteExpirationHours *
          60 *
          60;

      const invite =
        await telegram.createChatInviteLink(
          config.privateChannelId,
          {
            name:
              `pedido-${order.order_nsu}`
                .slice(0, 32),

            expire_date: expireDate,

            creates_join_request: true
          }
        );

      order = setInvite(
        order.order_nsu,
        invite.invite_link,
        expireDate
      );
    }

    if (order.invite_notified_at) {
      return order;
    }

    await telegram.sendMessage(
      order.telegram_id,

      [
        "✅ PAGAMENTO CONFIRMADO",
        "",
        "Seu acesso está liberado.",
        "",
        "Toque no botão abaixo para solicitar entrada no canal.",
        "",
        `O convite expira em ${config.inviteExpirationHours} horas.`,
        "Ele só será aprovado para a conta do Telegram que realizou a compra."
      ].join("\n"),

      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  "🔓 Solicitar acesso ao pack",

                url: order.invite_link
              }
            ]
          ]
        }
      }
    );

    markInviteNotified(
      order.order_nsu
    );

    logger.info(
      {
        orderNsu: order.order_nsu,
        telegramId:
          order.telegram_id
      },
      "Convite enviado ao comprador"
    );

    return getOrder(
      order.order_nsu
    );
  }

  return {
    ensureInviteAndNotify
  };
}