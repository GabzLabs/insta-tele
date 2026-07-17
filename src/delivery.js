import { config } from "./config.js";
import { getOrder, markInviteNotified, setInvite } from "./db.js";
import { logger } from "./logger.js";

export function createDeliveryService(telegram) {
  async function ensureInviteAndNotify(orderInput, { forceNew = false } = {}) {
    let order = getOrder(orderInput.order_nsu);
    if (!order || !["PAID", "DELIVERED"].includes(order.status)) return null;
    if (order.status === "DELIVERED") return order;

    const nowUnix = Math.floor(Date.now() / 1000);
    const validExistingInvite =
      !forceNew &&
      order.invite_link &&
      order.invite_expires_at &&
      Number(order.invite_expires_at) > nowUnix + 300;

    if (!validExistingInvite) {
      if (order.invite_link) {
        await telegram
          .revokeChatInviteLink(config.privateChannelId, order.invite_link)
          .catch(() => {});
      }

      const expireDate = nowUnix + config.inviteExpirationHours * 60 * 60;
      const invite = await telegram.createChatInviteLink(config.privateChannelId, {
        name: `pedido_${order.order_nsu.slice(-12)}`.slice(0, 32),
        expire_date: expireDate,
        creates_join_request: true
      });

      order = setInvite(order.order_nsu, invite.invite_link, expireDate);
    }

    if (order.invite_notified_at && !forceNew) return order;

    await telegram.sendMessage(
      order.telegram_id,
      [
        "✅ Pagamento confirmado!",
        "",
        `Seu acesso ao ${config.packTitle} foi liberado.`,
        "Toque no botão abaixo e solicite a entrada no canal privado.",
        "",
        `⏳ O link expira em ${config.inviteExpirationHours} horas e funciona somente para a conta que comprou.`
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔓 Solicitar acesso ao pack", url: order.invite_link }]
          ]
        }
      }
    );

    markInviteNotified(order.order_nsu);
    logger.info({ orderNsu: order.order_nsu }, "Convite enviado ao comprador");
    return getOrder(order.order_nsu);
  }

  return { ensureInviteAndNotify };
}
