import crypto from "node:crypto";

import { config } from "./config.js";

import {
  attachPix,
  confirmAge,
  createOrder,
  getActiveOrder,
  getLatestPendingOrder,
  getOrderByInvite,
  getStats,
  getUser,
  markDelivered,
  markExpired,
  setOrderFailed,
  upsertUser
} from "./db.js";

import {
  createPixCharge
} from "./efi.js";

import {
  confirmOrderPayment
} from "./payment-worker.js";

import { logger } from "./logger.js";

const CALLBACKS = {
  AGE_YES: "age_yes",
  AGE_NO: "age_no",
  BUY: "buy_pack",
  STATUS: "payment_status"
};

export function createBotController(
  telegram,
  deliveryService
) {
  let botUsername = "";

  function setBotUsername(username) {
    botUsername = username ?? "";
  }

  async function handleUpdate(update) {
    if (update.message) {
      return handleMessage(
        update.message
      );
    }

    if (update.callback_query) {
      return handleCallback(
        update.callback_query
      );
    }

    if (update.chat_join_request) {
      return handleJoinRequest(
        update.chat_join_request
      );
    }

    if (update.channel_post) {
      return handleChannelPost(
        update.channel_post
      );
    }
  }

  function registerUser(from) {
    if (!from) {
      return;
    }

    upsertUser({
      telegramId: from.id,
      username: from.username,
      firstName: from.first_name
    });
  }

  async function handleMessage(message) {
    if (
      !message.from ||
      message.chat?.type !== "private"
    ) {
      return;
    }

    registerUser(message.from);

    const command = (
      message.text
        ?.trim()
        .split(/\s+/)[0] ??
      ""
    )
      .split("@")[0]
      .toLowerCase();

    try {
      if (command === "/start") {
        return startCommand(message);
      }

      if (command === "/comprar") {
        return buyCommand(message);
      }

      if (command === "/status") {
        return sendStatus(
          message.chat.id,
          message.from.id
        );
      }

      if (command === "/ajuda") {
        return sendHelp(
          message.chat.id
        );
      }

      if (command === "/stats") {
        return sendStats(message);
      }
    } catch (error) {
      logger.error(
        {
          err: error,
          userId: message.from.id
        },
        "Erro no bot"
      );

      await telegram
        .sendMessage(
          message.chat.id,
          "Erro temporário. Tente novamente."
        )
        .catch(() => {});
    }
  }

  async function startCommand(message) {
    const user =
      getUser(message.from.id);

    if (user?.age_confirmed) {
      return showStore(
        message.chat.id
      );
    }

    return telegram.sendMessage(
      message.chat.id,

      [
        "🔞 Área restrita para maiores de 18 anos.",
        "",
        "Ao continuar, você declara ter 18 anos ou mais.",
        "",
        "Você também concorda em não compartilhar ou redistribuir o conteúdo adquirido."
      ].join("\n"),

      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  "🔞 Tenho 18 anos ou mais",

                callback_data:
                  CALLBACKS.AGE_YES
              }
            ],
            [
              {
                text: "Sair",

                callback_data:
                  CALLBACKS.AGE_NO
              }
            ]
          ]
        }
      }
    );
  }

  async function buyCommand(message) {
    const user =
      getUser(message.from.id);

    if (!user?.age_confirmed) {
      return telegram.sendMessage(
        message.chat.id,
        "Confirme sua idade primeiro usando /start."
      );
    }

    return showStore(
      message.chat.id
    );
  }

  async function sendHelp(chatId) {
    return telegram.sendMessage(
      chatId,

      [
        "Comandos disponíveis:",
        "",
        "/start — abrir o bot",
        "/comprar — comprar o pack",
        "/status — verificar pagamento",
        "/ajuda — mostrar ajuda"
      ].join("\n")
    );
  }

  async function sendStats(message) {
    if (
      !config.adminTelegramId ||
      String(message.from.id) !==
        String(config.adminTelegramId)
    ) {
      return;
    }

    const stats = getStats();

    return telegram.sendMessage(
      message.chat.id,

      [
        "📊 Estatísticas",
        "",
        `Usuários: ${stats.users}`,
        `Pedidos: ${stats.orders}`,
        `Pendentes: ${stats.pending}`,
        `Pagos: ${stats.paid}`,
        `Entregues: ${stats.delivered}`,
        `Receita: ${money(stats.revenue_cents)}`
      ].join("\n")
    );
  }

  async function handleCallback(
    callback
  ) {
    if (
      !callback.from ||
      !callback.message
    ) {
      return;
    }

    registerUser(callback.from);

    const chatId =
      callback.message.chat.id;

    try {
      if (
        callback.data ===
        CALLBACKS.AGE_YES
      ) {
        await telegram
          .answerCallbackQuery(
            callback.id
          );

        confirmAge(
          callback.from.id
        );

        await telegram
          .editMessageText(
            chatId,
            callback.message.message_id,
            "✅ Idade confirmada."
          )
          .catch(() => {});

        return showStore(chatId);
      }

      if (
        callback.data ===
        CALLBACKS.AGE_NO
      ) {
        await telegram
          .answerCallbackQuery(
            callback.id
          );

        return telegram
          .editMessageText(
            chatId,
            callback.message.message_id,
            "Acesso encerrado."
          )
          .catch(() => {});
      }

      if (
        callback.data ===
        CALLBACKS.BUY
      ) {
        await telegram
          .answerCallbackQuery(
            callback.id,
            {
              text: "Gerando Pix…"
            }
          );

        return createPayment(
          chatId,
          callback.from.id
        );
      }

      if (
        callback.data ===
        CALLBACKS.STATUS
      ) {
        await telegram
          .answerCallbackQuery(
            callback.id,
            {
              text:
                "Consultando a Efí…"
            }
          );

        return sendStatus(
          chatId,
          callback.from.id
        );
      }

      return telegram
        .answerCallbackQuery(
          callback.id
        );
    } catch (error) {
      logger.error(
        {
          err: error,
          userId: callback.from.id
        },
        "Erro no callback"
      );

      return telegram
        .sendMessage(
          chatId,
          "Não consegui concluir agora. Tente novamente."
        )
        .catch(() => {});
    }
  }

  async function createPayment(
    chatId,
    telegramId
  ) {
    const user =
      getUser(telegramId);

    if (!user?.age_confirmed) {
      return telegram.sendMessage(
        chatId,
        "Confirme sua idade primeiro usando /start."
      );
    }

    const activeOrder =
      getActiveOrder(
        telegramId
      );

    if (
      activeOrder?.status ===
      "DELIVERED"
    ) {
      return telegram.sendMessage(
        chatId,
        "✅ Seu acesso já está ativo."
      );
    }

    if (
      activeOrder?.status ===
      "PAID"
    ) {
      await deliveryService
        .ensureInviteAndNotify(
          activeOrder,
          {
            forceNew:
              isInviteExpired(
                activeOrder
              )
          }
        );

      return;
    }

    const pendingOrder =
      getLatestPendingOrder(
        telegramId
      );

    if (
      pendingOrder &&
      !isExpired(pendingOrder)
    ) {
      return sendPix(
        chatId,
        pendingOrder
      );
    }

    if (
      pendingOrder &&
      isExpired(pendingOrder)
    ) {
      markExpired(
        pendingOrder.order_nsu
      );
    }

    const orderNsu =
      `pk_${crypto.randomUUID()
        .replaceAll("-", "")
        .slice(0, 24)}`;

    createOrder({
      orderNsu,
      telegramId,

      amountCents:
        config.packPriceCents,

      title:
        config.packTitle
    });

    try {
      const pix =
        await createPixCharge();

      const order =
        attachPix(
          orderNsu,
          pix
        );

      await sendPix(
        chatId,
        order
      );
    } catch (error) {
      setOrderFailed(orderNsu);

      logger.error(
        {
          err: error,
          orderNsu
        },
        "Falha ao gerar Pix Efí"
      );

      return telegram.sendMessage(
        chatId,

        [
          "Não consegui gerar o Pix.",
          "",
          "Confira:",
          "• credenciais da Efí;",
          "• certificado de produção;",
          "• chave Pix cadastrada;",
          "• escopos da aplicação."
        ].join("\n")
      );
    }
  }

  async function showStore(chatId) {
    return telegram.sendMessage(
      chatId,

      [
        `🔥 ${config.packTitle}`,
        "",
        `• ${config.packDescription}`,
        `• Valor único: ${money(config.packPriceCents)}`,
        "• Pix direto no Telegram",
        "• Entrega automática",
        "",
        "Conteúdo exclusivo para maiores de 18 anos."
      ].join("\n"),

      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  `🔥 Comprar por ${money(config.packPriceCents)}`,

                callback_data:
                  CALLBACKS.BUY
              }
            ],
            [
              {
                text:
                  "🔄 Verificar pagamento",

                callback_data:
                  CALLBACKS.STATUS
              }
            ]
          ]
        }
      }
    );
  }

  async function sendPix(
    chatId,
    order
  ) {
    const qrCodeBuffer =
      dataUrlToBuffer(
        order.qr_data_url
      );

    const caption = [
      "✅ PIX GERADO",
      "",
      `Valor: ${money(order.amount_cents)}`,
      `Expira em: ${Math.round(config.pixExpirationSeconds / 60)} minutos`,
      "",
      "Escaneie o QR Code ou copie o código enviado abaixo."
    ].join("\n");

    if (qrCodeBuffer) {
      await telegram.sendPhoto(
        chatId,
        qrCodeBuffer,
        {
          caption
        }
      );
    } else {
      await telegram.sendMessage(
        chatId,
        caption
      );
    }

    await telegram.sendMessage(
      chatId,

      `<code>${escapeHtml(order.pix_copy_paste)}</code>`,

      {
        parse_mode: "HTML",

        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  "✅ Já fiz o pagamento",

                callback_data:
                  CALLBACKS.STATUS
              }
            ],
            [
              {
                text:
                  "🔥 Gerar outro Pix",

                callback_data:
                  CALLBACKS.BUY
              }
            ]
          ]
        }
      }
    );
  }

  async function sendStatus(
    chatId,
    telegramId
  ) {
    const activeOrder =
      getActiveOrder(
        telegramId
      );

    if (
      activeOrder?.status ===
      "DELIVERED"
    ) {
      return telegram.sendMessage(
        chatId,
        "✅ Pagamento confirmado e acesso já entregue."
      );
    }

    if (
      activeOrder?.status ===
      "PAID"
    ) {
      await deliveryService
        .ensureInviteAndNotify(
          activeOrder,
          {
            forceNew:
              isInviteExpired(
                activeOrder
              )
          }
        );

      return telegram.sendMessage(
        chatId,
        "✅ Pagamento confirmado."
      );
    }

    const pendingOrder =
      getLatestPendingOrder(
        telegramId
      );

    if (!pendingOrder) {
      return telegram.sendMessage(
        chatId,
        "Você ainda não possui uma compra. Use /comprar."
      );
    }

    if (isExpired(pendingOrder)) {
      markExpired(
        pendingOrder.order_nsu
      );

      return telegram.sendMessage(
        chatId,
        "⌛ Esse Pix expirou. Use /comprar para gerar outro."
      );
    }

    try {
      const result =
        await confirmOrderPayment(
          pendingOrder,
          deliveryService
        );

      if (result.paid) {
        return telegram.sendMessage(
          chatId,
          "✅ Pagamento confirmado! Seu acesso foi enviado."
        );
      }

      return telegram.sendMessage(
        chatId,

        [
          "⏳ O pagamento ainda não apareceu na Efí.",
          "",
          "Depois de pagar, aguarde alguns segundos e tente novamente."
        ].join("\n")
      );
    } catch (error) {
      logger.error(
        {
          err: error,
          txid:
            pendingOrder.txid
        },
        "Erro ao consultar Pix"
      );

      return telegram.sendMessage(
        chatId,
        "Não consegui consultar a Efí agora. Tente novamente em instantes."
      );
    }
  }

  async function handleJoinRequest(
    request
  ) {
    if (
      String(request.chat.id) !==
      String(config.privateChannelId)
    ) {
      return;
    }

    const inviteLink =
      request.invite_link
        ?.invite_link;

    const order =
      inviteLink
        ? getOrderByInvite(
            inviteLink
          )
        : null;

    const allowed =
      order &&
      String(order.telegram_id) ===
        String(request.from.id) &&
      ["PAID", "DELIVERED"]
        .includes(order.status);

    if (!allowed) {
      await telegram
        .declineChatJoinRequest(
          request.chat.id,
          request.from.id
        );

      return;
    }

    await telegram
      .approveChatJoinRequest(
        request.chat.id,
        request.from.id
      );

    markDelivered(
      order.order_nsu
    );

    if (inviteLink) {
      await telegram
        .revokeChatInviteLink(
          request.chat.id,
          inviteLink
        )
        .catch(() => {});
    }

    await telegram
      .sendMessage(
        request.from.id,
        "✅ Acesso aprovado. O canal já está na sua lista."
      )
      .catch(() => {});
  }

  async function handleChannelPost(
    post
  ) {
    const text =
      post.text?.trim();

    const isIdCommand =
      text === "/id" ||
      (
        botUsername &&
        text === `/id@${botUsername}`
      );

    if (isIdCommand) {
      await telegram.sendMessage(
        post.chat.id,
        `ID deste canal: ${post.chat.id}`
      );
    }
  }

  return {
    handleUpdate,
    setBotUsername
  };
}

function money(cents) {
  return new Intl.NumberFormat(
    "pt-BR",
    {
      style: "currency",
      currency: "BRL"
    }
  ).format(cents / 100);
}

function isExpired(order) {
  return (
    !order.expires_at ||
    Date.parse(order.expires_at) <=
      Date.now()
  );
}

function isInviteExpired(order) {
  const now =
    Math.floor(Date.now() / 1000);

  return (
    !order.invite_link ||
    !order.invite_expires_at ||
    Number(order.invite_expires_at) <=
      now + 300
  );
}

function dataUrlToBuffer(value) {
  if (!value) {
    return null;
  }

  const match =
    String(value).match(
      /^data:image\/png;base64,(.+)$/
    );

  if (!match) {
    return null;
  }

  return Buffer.from(
    match[1],
    "base64"
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}