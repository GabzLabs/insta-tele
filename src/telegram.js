import { logger } from "./logger.js";

export class TelegramClient {
  constructor(token) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.stopped = false;
    this.offset = 0;
  }

  async call(method, payload = {}, timeoutMs = 15_000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        const error = new Error(
          `Telegram ${method} falhou: ${data?.description ?? `HTTP ${response.status}`}`
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
    return this.call("sendMessage", { chat_id: chatId, text, ...options });
  }

  answerCallbackQuery(callbackQueryId, options = {}) {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...options
    });
  }

  editMessageText(chatId, messageId, text, options = {}) {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...options
    });
  }

  createChatInviteLink(chatId, options = {}) {
    return this.call("createChatInviteLink", { chat_id: chatId, ...options });
  }

  approveChatJoinRequest(chatId, userId) {
    return this.call("approveChatJoinRequest", { chat_id: chatId, user_id: userId });
  }

  declineChatJoinRequest(chatId, userId) {
    return this.call("declineChatJoinRequest", { chat_id: chatId, user_id: userId });
  }

  revokeChatInviteLink(chatId, inviteLink) {
    return this.call("revokeChatInviteLink", {
      chat_id: chatId,
      invite_link: inviteLink
    });
  }

  stop() {
    this.stopped = true;
  }

  async start(handleUpdate) {
    this.stopped = false;

    while (!this.stopped) {
      try {
        const updates = await this.call(
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

        for (const update of updates) {
          this.offset = update.update_id + 1;
          try {
            await handleUpdate(update);
          } catch (error) {
            logger.error({ err: error, updateId: update.update_id }, "Falha ao tratar update");
          }
        }
      } catch (error) {
        if (this.stopped) break;
        logger.error({ err: error }, "Falha no long polling do Telegram");
        await sleep(2_000);
      }
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
