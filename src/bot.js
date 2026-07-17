import crypto from "node:crypto";
import { config } from "./config.js";
import {
  confirmAge,
  createOrder,
  getActiveOrder,
  getLatestPendingOrder,
  getOrder,
  getOrderByInvite,
  getStats,
  getUser,
  markDelivered,
  setCheckoutUrl,
  setOrderFailed,
  upsertUser
} from "./db.js";
import { createCheckoutLink } from "./infinitepay.js";
import { logger } from "./logger.js";

const CALLBACKS = Object.freeze({
  AGE_YES: "age_yes",
  AGE_NO: "age_no",
  BUY: "buy_pack",
  STATUS: "payment_status"
});

export function createBotController(telegram, deliveryService) {
  let botUsername = "";

  function setBotUsername(username) {
    botUsername = username ?? "";
  }

  async function handleUpdate(update) {
    if (update.message) return handleMessage(update.message);
    if (update.callback_query) return handleCallback(update.callback_query);
    if (update.chat_join_request) return handleJoinRequest(update.chat_join_request);
    if (update.channel_post) return handleChannelPost(update.channel_post);
  }

  function registerUser(from) {
    if (!from) return;
    upsertUser({
      telegramId: from.id,
      username: from.username,
      firstName: from.first_name
    });
  }

  async function handleMessage(message) {
    if (!message.from || message.chat?.type !== "private") return;
    registerUser(message.from);

    const text = message.text?.trim() ?? "";
    const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();

    try {
      if (command === "/start") return start(message);
      if (command === "/comprar") return comprar(message);
      if (command === "/status") return sendStatus(message.chat.id, message.from.id);
      if (command === "/ajuda") return ajuda(message.chat.id);
      if (command === "/stats") return stats(message);
    } catch (error) {
      logger.error({ err: error, userId: message.from.id }, "Erro em comando do bot");
      await telegram
        .sendMessage(message.chat.id, "Ocorreu um erro temporário. Tente novamente em instantes.")
        .catch(() => {});
    }
  }

  async function start(message) {
    const user = getUser(message.from.id);
    if (user?.age_confirmed) return showStore(message.chat.id);

    await telegram.sendMessage(
      message.chat.id,
      [
        "🔞 Área restrita para maiores de 18 anos.",
        "",
        "Ao continuar, você declara ter 18 anos ou mais e concorda em não compartilhar o conteúdo adquirido."
      ].join("\n"),
      { reply_markup: ageKeyboard() }
    );
  }

  async function comprar(message) {
    const user = getUser(message.from.id);
    if (!user?.age_confirmed) {
      await telegram.sendMessage(message.chat.id, "Confirme sua idade primeiro com /start.");
      return;
    }
    await showStore(message.chat.id);
  }

  async function ajuda(chatId) {
    await telegram.sendMessage(
      chatId,
      [
        "Comandos:",
        "/start — abrir o bot",
        "/comprar — gerar pagamento",
        "/status — consultar seu acesso",
        "/ajuda — mostrar esta mensagem"
      ].join("\n")
    );
  }

  async function stats(message) {
    if (!config.adminTelegramId || String(message.from.id) !== config.adminTelegramId) return;
    const values = getStats();
    await telegram.sendMessage(
      message.chat.id,
      [
        "📊 Estatísticas",
        `Usuários: ${values.users}`,
        `Pedidos: ${values.orders}`,
        `Pendentes: ${values.pending}`,
        `Pagos: ${values.paid}`,
        `Entregues: ${values.delivered}`,
        `Receita: ${money(values.revenue_cents)}`
      ].join("\n")
    );
  }

  async function handleCallback(callback) {
    if (!callback.from || !callback.message) return;
    registerUser(callback.from);
    const chatId = callback.message.chat.id;

    try {
      if (callback.data === CALLBACKS.AGE_YES) {
        await telegram.answerCallbackQuery(callback.id);
        confirmAge(callback.from.id);
        await telegram
          .editMessageText(chatId, callback.message.message_id, "✅ Idade confirmada.")
          .catch(() => {});
        return showStore(chatId);
      }

      if (callback.data === CALLBACKS.AGE_NO) {
        await telegram.answerCallbackQuery(callback.id);
        return telegram
          .editMessageText(chatId, callback.message.message_id, "Acesso encerrado.")
          .catch(() => {});
      }

      if (callback.data === CALLBACKS.BUY) {
        await telegram.answerCallbackQuery(callback.id, { text: "Gerando pagamento…" });
        return createPayment(chatId, callback.from.id);
      }

      if (callback.data === CALLBACKS.STATUS) {
        await telegram.answerCallbackQuery(callback.id);
        return sendStatus(chatId, callback.from.id);
      }

      await telegram.answerCallbackQuery(callback.id);
    } catch (error) {
      logger.error({ err: error, userId: callback.from.id }, "Erro em callback do bot");
      await telegram.sendMessage(chatId, "Ocorreu um erro temporário. Tente novamente.").catch(() => {});
    }
  }

  async function createPayment(chatId, telegramId) {
    const user = getUser(telegramId);
    if (!user?.age_confirmed) {
      await telegram.sendMessage(chatId, "Confirme sua idade primeiro com /start.");
      return;
    }

    const activeOrder = getActiveOrder(telegramId);
    if (activeOrder?.status === "DELIVERED") {
      await telegram.sendMessage(chatId, "✅ Seu acesso já está ativo no canal privado.");
      return;
    }

    if (activeOrder?.status === "PAID") {
      await deliveryService.ensureInviteAndNotify(activeOrder, {
        forceNew: isInviteExpired(activeOrder)
      });
      await telegram.sendMessage(chatId, "✅ Seu pagamento já foi confirmado.");
      return;
    }

    const previousPending = getLatestPendingOrder(telegramId);
    if (previousPending?.checkout_url && isRecent(previousPending.created_at, 6)) {
      await sendCheckout(chatId, previousPending);
      return;
    }

    const orderNsu = `pk_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    createOrder({
      orderNsu,
      telegramId,
      amountCents: config.packPriceCents,
      title: config.packTitle
    });

    try {
      const checkoutUrl = await createCheckoutLink({ orderNsu });
      setCheckoutUrl(orderNsu, checkoutUrl);
      await sendCheckout(chatId, getOrder(orderNsu));
    } catch (error) {
      setOrderFailed(orderNsu);
      logger.error({ err: error, orderNsu }, "Falha ao criar checkout");
      await telegram.sendMessage(chatId, "Não consegui gerar o pagamento agora. Tente novamente em instantes.");
    }
  }

  async function showStore(chatId) {
    await telegram.sendMessage(
      chatId,
      [
        `🔥 ${config.packTitle}`,
        "",
        `• ${config.packDescription}`,
        `• Valor único: ${money(config.packPriceCents)}`,
        "• Entrega automática após a confirmação",
        "• Acesso por canal privado",
        "",
        "Conteúdo destinado exclusivamente a maiores de 18 anos."
      ].join("\n"),
      { reply_markup: shopKeyboard() }
    );
  }

  async function sendCheckout(chatId, order) {
    await telegram.sendMessage(
      chatId,
      [
        "💳 Pagamento criado.",
        "",
        `Valor: ${money(order.amount_cents)}`,
        "Abra o checkout, escolha Pix e finalize o pagamento.",
        "A liberação acontece automaticamente após a confirmação da InfinitePay."
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: `💠 Pagar ${money(order.amount_cents)}`, url: order.checkout_url }],
            [{ text: "🔄 Já paguei / verificar", callback_data: CALLBACKS.STATUS }]
          ]
        }
      }
    );
  }

  async function sendStatus(chatId, telegramId) {
    const activeOrder = getActiveOrder(telegramId);
    if (activeOrder?.status === "DELIVERED") {
      await telegram.sendMessage(chatId, "✅ Pagamento confirmado e acesso ao canal já entregue.");
      return;
    }

    if (activeOrder?.status === "PAID") {
      const refreshed = await deliveryService.ensureInviteAndNotify(activeOrder, {
        forceNew: isInviteExpired(activeOrder)
      });
      if (refreshed?.invite_link) {
        await telegram.sendMessage(chatId, "✅ Pagamento confirmado. Use seu link de entrada:", {
          reply_markup: {
            inline_keyboard: [[{ text: "🔓 Solicitar acesso", url: refreshed.invite_link }]]
          }
        });
      } else {
        await telegram.sendMessage(chatId, "✅ Pagamento confirmado. Seu convite está sendo preparado.");
      }
      return;
    }

    const pendingOrder = getLatestPendingOrder(telegramId);
    if (pendingOrder) {
      await telegram.sendMessage(
        chatId,
        "⏳ Pagamento ainda não confirmado. Aguarde alguns segundos após pagar e tente novamente."
      );
      return;
    }

    await telegram.sendMessage(chatId, "Você ainda não possui uma compra. Use /comprar.");
  }

  async function handleJoinRequest(request) {
    if (String(request.chat.id) !== String(config.privateChannelId)) return;

    const inviteUrl = request.invite_link?.invite_link;
    const order = inviteUrl ? getOrderByInvite(inviteUrl) : null;
    const sameBuyer = order && String(order.telegram_id) === String(request.from.id);
    const paid = order && ["PAID", "DELIVERED"].includes(order.status);

    if (!sameBuyer || !paid) {
      await telegram.declineChatJoinRequest(request.chat.id, request.from.id);
      logger.warn({ userId: request.from.id }, "Solicitação de entrada recusada");
      return;
    }

    await telegram.approveChatJoinRequest(request.chat.id, request.from.id);
    markDelivered(order.order_nsu);

    if (inviteUrl) {
      await telegram.revokeChatInviteLink(request.chat.id, inviteUrl).catch(() => {});
    }

    await telegram
      .sendMessage(
        request.from.id,
        "✅ Acesso aprovado. O canal privado já está disponível na sua lista de conversas."
      )
      .catch(() => {});

    logger.info({ orderNsu: order.order_nsu, userId: request.from.id }, "Acesso entregue");
  }

  async function handleChannelPost(post) {
    const text = post.text?.trim();
    const addressed = botUsername && text === `/id@${botUsername}`;
    if (text === "/id" || addressed) {
      await telegram.sendMessage(post.chat.id, `ID deste canal: ${post.chat.id}`);
    }
  }

  return { handleUpdate, setBotUsername };
}

function ageKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🔞 Tenho 18 anos ou mais", callback_data: CALLBACKS.AGE_YES }],
      [{ text: "Sair", callback_data: CALLBACKS.AGE_NO }]
    ]
  };
}

function shopKeyboard() {
  return {
    inline_keyboard: [
      [{ text: `🔥 Comprar por ${money(config.packPriceCents)}`, callback_data: CALLBACKS.BUY }],
      [{ text: "🔄 Verificar pagamento", callback_data: CALLBACKS.STATUS }]
    ]
  };
}

function money(cents) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(cents / 100);
}

function isInviteExpired(order) {
  const nowUnix = Math.floor(Date.now() / 1000);
  return !order.invite_link || !order.invite_expires_at || Number(order.invite_expires_at) <= nowUnix + 300;
}

function isRecent(isoDate, hours) {
  const created = Date.parse(isoDate);
  return Number.isFinite(created) && Date.now() - created < hours * 60 * 60 * 1000;
}
