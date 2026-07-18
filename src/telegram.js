import { logger } from "./logger.js";

export class TelegramClient {
  constructor(token) {
    this.baseUrl =
      `https://api.telegram.org/bot${token}`;

    this.stopped = false;
    this.offset = 0;
  }

  async call(
    method,
    payload = {},
    timeoutMs = 15_000
  ) {
    const controller =
      new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(
        `${this.baseUrl}/${method}`,
        {
          method: "POST",

          headers: {
            "content-type":
              "application/json"
          },

          body: JSON.stringify(payload),

          signal: controller.signal
        }
      );

      const data =
        await response.json()
          .catch(() => null);

      if (!response.ok || !data?.ok) {
        const error = new Error(
          `Telegram ${method} falhou: ` +
          `${data?.description ?? `HTTP ${response.status}`}`
        );

        error.details = data;

        throw error;
      }

      return data.result;
    } finally {
      clearTimeout(timeout);
    }
  }

  getMe() {
    return this.call("getMe");
  }

  sendMessage(chatId, text, options = {}) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      ...options
    });
  }

  editMessageText(
    chatId,
    messageId,
    text,
    options = {}
  ) {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...options
    });
  }

  answerCallbackQuery(
    callbackQueryId,
    options = {}
  ) {
    return this.call(
      "answerCallbackQuery",
      {
        callback_query_id:
          callbackQueryId,

        ...options
      }
    );
  }

  async sendPhoto(
    chatId,
    imageBuffer,
    options = {}
  ) {
    const formData = new FormData();

    formData.append(
      "chat_id",
      String(chatId)
    );

    formData.append(
      "photo",
      new Blob(
        [imageBuffer],
        { type: "image/png" }
      ),
      "pix.png"
    );

    for (
      const [key, value]
      of Object.entries(options)
    ) {
      if (value == null) {
        continue;
      }

      formData.append(
        key,
        typeof value === "string"
          ? value
          : JSON.stringify(value)
      );
    }

    const response = await fetch(
      `${this.baseUrl}/sendPhoto`,
      {
        method: "POST",
        body: formData
      }
    );

    const data =
      await response.json()
        .catch(() => null);

    if (!response.ok || !data?.ok) {
      throw new Error(
        data?.description ??
        "Não foi possível enviar o QR Code."
      );
    }

    return data.result;
  }

  createChatInviteLink(
    chatId,
    options = {}
  ) {
    return this.call(
      "createChatInviteLink",
      {
        chat_id: chatId,
        ...options
      }
    );
  }

  revokeChatInviteLink(
    chatId,
    inviteLink
  ) {
    return this.call(
      "revokeChatInviteLink",
      {
        chat_id: chatId,
        invite_link: inviteLink
      }
    );
  }

  approveChatJoinRequest(
    chatId,
    userId
  ) {
    return this.call(
      "approveChatJoinRequest",
      {
        chat_id: chatId,
        user_id: userId
      }
    );
  }

  declineChatJoinRequest(
    chatId,
    userId
  ) {
    return this.call(
      "declineChatJoinRequest",
      {
        chat_id: chatId,
        user_id: userId
      }
    );
  }

  async getUpdates() {
    return this.call(
      "getUpdates",
      {
        offset: this.offset,
        timeout: 30,

        allowed_updates: [
          "message",
          "callback_query",
          "chat_join_request",
          "channel_post"
        ]
      },
      40_000
    );
  }

  async start(updateHandler) {
    this.stopped = false;

    while (!this.stopped) {
      try {
        const updates =
          await this.getUpdates();

        for (const update of updates) {
          this.offset =
            update.update_id + 1;

          await updateHandler(update);
        }
      } catch (error) {
        if (this.stopped) {
          break;
        }

        logger.error(
          { err: error },
          "Erro no polling do Telegram"
        );

        await sleep(3000);
      }
    }
  }

  stop() {
    this.stopped = true;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}