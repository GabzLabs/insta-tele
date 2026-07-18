import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const absoluteDataFile = path.resolve(config.dataFile);

fs.mkdirSync(path.dirname(absoluteDataFile), {
  recursive: true
});

function freshDatabase() {
  return {
    version: 2,
    users: {},
    orders: {},
    paymentEvents: {},
    nextEventId: 1
  };
}

let state = loadDatabase();

function now() {
  return new Date().toISOString();
}

function clone(value) {
  return value == null
    ? value
    : structuredClone(value);
}

function loadDatabase() {
  if (!fs.existsSync(absoluteDataFile)) {
    const database = freshDatabase();
    persist(database);
    return database;
  }

  try {
    const database = JSON.parse(
      fs.readFileSync(absoluteDataFile, "utf8")
    );

    return {
      ...freshDatabase(),
      ...database,
      users: database.users ?? {},
      orders: database.orders ?? {},
      paymentEvents: database.paymentEvents ?? {}
    };
  } catch (error) {
    throw new Error(
      `Falha ao ler banco de dados: ${error.message}`
    );
  }
}

function persist(database) {
  const temporaryFile = `${absoluteDataFile}.tmp`;

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(database, null, 2)
  );

  fs.renameSync(temporaryFile, absoluteDataFile);
}

function mutate(callback) {
  callback(state);
  persist(state);
}

export function upsertUser({
  telegramId,
  username,
  firstName
}) {
  const id = String(telegramId);
  const timestamp = now();

  mutate((database) => {
    const previous = database.users[id];

    database.users[id] = {
      telegram_id: id,

      username:
        username ??
        previous?.username ??
        null,

      first_name:
        firstName ??
        previous?.first_name ??
        null,

      age_confirmed:
        previous?.age_confirmed ?? 0,

      created_at:
        previous?.created_at ?? timestamp,

      updated_at: timestamp
    };
  });
}

export function confirmAge(telegramId) {
  mutate((database) => {
    const user =
      database.users[String(telegramId)];

    if (!user) {
      return;
    }

    user.age_confirmed = 1;
    user.updated_at = now();
  });
}

export function getUser(telegramId) {
  return clone(
    state.users[String(telegramId)] ?? null
  );
}

export function createOrder({
  orderNsu,
  telegramId,
  amountCents,
  title
}) {
  const timestamp = now();

  mutate((database) => {
    database.orders[orderNsu] = {
      order_nsu: orderNsu,
      telegram_id: String(telegramId),
      amount_cents: amountCents,
      title,

      status: "PENDING",

      txid: null,
      location_id: null,
      pix_copy_paste: null,
      qr_data_url: null,
      visualization_url: null,

      expires_at: null,

      end_to_end_id: null,
      paid_at: null,

      invite_link: null,
      invite_expires_at: null,
      invite_notified_at: null,
      joined_at: null,

      created_at: timestamp,
      updated_at: timestamp
    };
  });

  return getOrder(orderNsu);
}

export function attachPix(orderNsu, pix) {
  mutate((database) => {
    const order = database.orders[orderNsu];

    if (!order) {
      throw new Error("Pedido não encontrado.");
    }

    Object.assign(order, {
      txid: pix.txid,
      location_id: pix.locationId,
      pix_copy_paste: pix.pixCopyPaste,
      qr_data_url: pix.qrDataUrl,
      visualization_url: pix.visualizationUrl,
      expires_at: pix.expiresAt,
      updated_at: now()
    });
  });

  return getOrder(orderNsu);
}

export function setOrderFailed(orderNsu) {
  mutate((database) => {
    const order = database.orders[orderNsu];

    if (!order) {
      return;
    }

    order.status = "FAILED";
    order.updated_at = now();
  });
}

export function markExpired(orderNsu) {
  mutate((database) => {
    const order = database.orders[orderNsu];

    if (order?.status !== "PENDING") {
      return;
    }

    order.status = "EXPIRED";
    order.updated_at = now();
  });
}

export function getOrder(orderNsu) {
  return clone(state.orders[orderNsu] ?? null);
}

export function getOrderByTxid(txid) {
  const order = Object.values(state.orders)
    .find((item) => item.txid === txid);

  return clone(order ?? null);
}

export function getLatestPendingOrder(telegramId) {
  const order = Object.values(state.orders)
    .filter((item) => {
      return (
        item.telegram_id === String(telegramId) &&
        item.status === "PENDING" &&
        item.txid
      );
    })
    .sort((a, b) =>
      b.created_at.localeCompare(a.created_at)
    )[0];

  return clone(order ?? null);
}

export function getActiveOrder(telegramId) {
  const order = Object.values(state.orders)
    .filter((item) => {
      return (
        item.telegram_id === String(telegramId) &&
        ["PAID", "DELIVERED"].includes(item.status)
      );
    })
    .sort((a, b) =>
      b.created_at.localeCompare(a.created_at)
    )[0];

  return clone(order ?? null);
}

export function markOrderPaid({
  orderNsu,
  endToEndId,
  paidAt
}) {
  mutate((database) => {
    const order = database.orders[orderNsu];

    if (!order) {
      throw new Error("Pedido não encontrado.");
    }

    if (order.status !== "DELIVERED") {
      order.status = "PAID";
    }

    order.end_to_end_id =
      order.end_to_end_id ?? endToEndId;

    order.paid_at =
      order.paid_at ?? paidAt;

    order.updated_at = now();
  });

  return getOrder(orderNsu);
}

export function setInvite(
  orderNsu,
  inviteLink,
  expiresAt
) {
  mutate((database) => {
    const order = database.orders[orderNsu];

    if (!order) {
      throw new Error("Pedido não encontrado.");
    }

    order.invite_link = inviteLink;
    order.invite_expires_at = expiresAt;
    order.invite_notified_at = null;
    order.updated_at = now();
  });

  return getOrder(orderNsu);
}

export function markInviteNotified(orderNsu) {
  mutate((database) => {
    const order = database.orders[orderNsu];

    if (!order) {
      return;
    }

    order.invite_notified_at = now();
    order.updated_at = now();
  });
}

export function getOrderByInvite(inviteLink) {
  const order = Object.values(state.orders)
    .find((item) => {
      return item.invite_link === inviteLink;
    });

  return clone(order ?? null);
}

export function markDelivered(orderNsu) {
  mutate((database) => {
    const order = database.orders[orderNsu];

    if (!order) {
      return;
    }

    order.status = "DELIVERED";
    order.joined_at =
      order.joined_at ?? now();

    order.updated_at = now();
  });
}

export function enqueuePaymentEvent(payload) {
  const txids = [
    ...new Set(
      (payload?.pix ?? [])
        .map((pix) =>
          String(pix.txid ?? "")
        )
        .filter(Boolean)
    )
  ];

  const createdEvents = [];

  mutate((database) => {
    for (const txid of txids) {
      const endToEndId =
        payload.pix?.find(
          (pix) => pix.txid === txid
        )?.endToEndId ?? "";

      const key = `${txid}:${endToEndId}`;

      const alreadyExists =
        Object.values(database.paymentEvents)
          .some((event) => event.key === key);

      if (alreadyExists) {
        continue;
      }

      const id = database.nextEventId++;

      const event = {
        id,
        key,
        txid,
        payload: JSON.stringify(payload),

        status: "PENDING",
        attempts: 0,
        last_error: null,

        created_at: now(),
        processed_at: null
      };

      database.paymentEvents[id] = event;
      createdEvents.push(event);
    }
  });

  return clone(createdEvents);
}

export function listPendingEvents(limit = 20) {
  return clone(
    Object.values(state.paymentEvents)
      .filter((event) => {
        return (
          ["PENDING", "RETRY"].includes(event.status) &&
          event.attempts < 10
        );
      })
      .sort((a, b) => a.id - b.id)
      .slice(0, limit)
  );
}

function mutateEvent(id, callback) {
  mutate((database) => {
    const event = database.paymentEvents[id];

    if (event) {
      callback(event);
    }
  });
}

export function markEventProcessing(id) {
  mutateEvent(id, (event) => {
    event.status = "PROCESSING";
    event.attempts++;
  });
}

export function markEventDone(id) {
  mutateEvent(id, (event) => {
    event.status = "DONE";
    event.processed_at = now();
    event.last_error = null;
  });
}

export function markEventRetry(id, error) {
  mutateEvent(id, (event) => {
    event.status = "RETRY";
    event.last_error =
      String(error).slice(0, 1000);
  });
}

export function listPaidOrdersWithoutNotification(
  limit = 20
) {
  return clone(
    Object.values(state.orders)
      .filter((order) => {
        return (
          order.status === "PAID" &&
          !order.invite_notified_at
        );
      })
      .slice(0, limit)
  );
}

export function getStats() {
  const orders = Object.values(state.orders);

  const paidOrders = orders.filter((order) =>
    ["PAID", "DELIVERED"].includes(order.status)
  );

  return {
    users: Object.keys(state.users).length,
    orders: orders.length,

    pending: orders.filter(
      (order) => order.status === "PENDING"
    ).length,

    paid: paidOrders.length,

    delivered: orders.filter(
      (order) => order.status === "DELIVERED"
    ).length,

    revenue_cents: paidOrders.reduce(
      (total, order) =>
        total + order.amount_cents,
      0
    )
  };
}

export function databaseHealthCheck() {
  return Boolean(
    state?.users &&
    state?.orders &&
    state?.paymentEvents
  );
}