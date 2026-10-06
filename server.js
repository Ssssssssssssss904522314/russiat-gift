const express = require("express");
const { Telegraf } = require("telegraf");
const { Pool } = require("pg");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || "";
const ADMIN_PANEL_PASSWORD = process.env.ADMIN_PANEL_PASSWORD || "";

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is not configured");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost")
        ? false
        : { rejectUnauthorized: false }
    })
  : null;

const memory = {
  users: new Map(),
  listings: new Map(),
  rentals: new Map(),
  withdrawals: new Map(),
  nextListingId: 1,
  nextRentalId: 1,
  nextWithdrawalId: 1
};

const states = new Map();

async function dbQuery(text, params = []) {
  if (!pool) return null;
  return pool.query(text, params);
}

async function initDb() {
  if (!pool) return;
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      balance NUMERIC(18,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS listings (
      id SERIAL PRIMARY KEY,
      seller_id BIGINT NOT NULL,
      title TEXT NOT NULL,
      price NUMERIC(18,2) NOT NULL,
      duration_days INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS rentals (
      id SERIAL PRIMARY KEY,
      listing_id INTEGER NOT NULL,
      renter_id BIGINT NOT NULL,
      seller_id BIGINT NOT NULL,
      amount NUMERIC(18,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'paid',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      amount NUMERIC(18,2) NOT NULL,
      method TEXT NOT NULL,
      details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function ensureUser(ctx) {
  const id = ctx.from.id;
  const username = ctx.from.username || "";

  if (pool) {
    await dbQuery(
      `INSERT INTO users (telegram_id, username)
       VALUES ($1, $2)
       ON CONFLICT (telegram_id)
       DO UPDATE SET username = EXCLUDED.username`,
      [id, username]
    );
    return;
  }

  if (!memory.users.has(id)) {
    memory.users.set(id, { telegram_id: id, username, balance: 0 });
  } else {
    memory.users.get(id).username = username;
  }
}

async function getBalance(id) {
  if (pool) {
    const r = await dbQuery("SELECT balance FROM users WHERE telegram_id = $1", [id]);
    return Number(r.rows[0]?.balance || 0);
  }
  return Number(memory.users.get(id)?.balance || 0);
}

async function addBalance(id, amount) {
  if (pool) {
    await dbQuery(
      "INSERT INTO users (telegram_id, balance) VALUES ($1, $2) ON CONFLICT (telegram_id) DO UPDATE SET balance = users.balance + $2",
      [id, amount]
    );
    return;
  }
  if (!memory.users.has(id)) memory.users.set(id, { telegram_id: id, username: "", balance: 0 });
  memory.users.get(id).balance += Number(amount);
}

async function subtractBalance(id, amount) {
  if (pool) {
    const r = await dbQuery(
      "UPDATE users SET balance = balance - $2 WHERE telegram_id = $1 AND balance >= $2 RETURNING balance",
      [id, amount]
    );
    return r.rowCount === 1;
  }
  const user = memory.users.get(id);
  if (!user || user.balance < amount) return false;
  user.balance -= Number(amount);
  return true;
}

async function createListing(sellerId, title, price, durationDays) {
  if (pool) {
    const r = await dbQuery(
      "INSERT INTO listings (seller_id, title, price, duration_days) VALUES ($1,$2,$3,$4) RETURNING id",
      [sellerId, title, price, durationDays]
    );
    return r.rows[0].id;
  }
  const id = memory.nextListingId++;
  memory.listings.set(id, { id, seller_id: sellerId, title, price, duration_days: durationDays, status: "active" });
  return id;
}

async function getListings() {
  if (pool) {
    const r = await dbQuery(
      "SELECT id, seller_id, title, price, duration_days FROM listings WHERE status='active' ORDER BY id DESC LIMIT 20"
    );
    return r.rows;
  }
  return [...memory.listings.values()].filter(x => x.status === "active").slice(-20).reverse();
}

async function getListing(id) {
  if (pool) {
    const r = await dbQuery("SELECT * FROM listings WHERE id=$1 AND status='active'", [id]);
    return r.rows[0];
  }
  return memory.listings.get(id);
}

async function createRental(listing) {
  if (pool) {
    const r = await dbQuery(
      "INSERT INTO rentals (listing_id, renter_id, seller_id, amount) VALUES ($1,$2,$3,$4) RETURNING id",
      [listing.id, currentPayment.renterId, listing.seller_id, listing.price]
    );
    return r.rows[0].id;
  }
  const id = memory.nextRentalId++;
  memory.rentals.set(id, {
    id,
    listing_id: listing.id,
    renter_id: currentPayment.renterId,
    seller_id: listing.seller_id,
    amount: Number(listing.price),
    status: "paid"
  });
  return id;
}

let currentPayment = { renterId: 0 };

async function recordRentalAndCredit(listing, renterId) {
  currentPayment.renterId = renterId;
  const rentalId = await createRental(listing);
  await addBalance(listing.seller_id, Number(listing.price));
  return rentalId;
}

async function createWithdrawal(id, amount, method, details) {
  if (pool) {
    const r = await dbQuery(
      "INSERT INTO withdrawals (telegram_id, amount, method, details) VALUES ($1,$2,$3,$4) RETURNING id",
      [id, amount, method, details]
    );
    return r.rows[0].id;
  }
  const wid = memory.nextWithdrawalId++;
  memory.withdrawals.set(wid, { id: wid, telegram_id: id, amount, method, details, status: "pending" });
  return wid;
}

async function getPendingWithdrawals() {
  if (pool) {
    const r = await dbQuery(
      "SELECT id, telegram_id, amount, method, details, created_at FROM withdrawals WHERE status='pending' ORDER BY id ASC LIMIT 50"
    );
    return r.rows;
  }
  return [...memory.withdrawals.values()].filter(x => x.status === "pending").slice(0, 50);
}

async function getWithdrawal(id) {
  if (pool) {
    const r = await dbQuery("SELECT * FROM withdrawals WHERE id=$1", [id]);
    return r.rows[0];
  }
  return memory.withdrawals.get(id);
}

async function updateWithdrawalStatus(id, status) {
  if (pool) {
    const r = await dbQuery(
      "UPDATE withdrawals SET status=$2 WHERE id=$1 AND status='pending' RETURNING telegram_id, amount",
      [id, status]
    );
    return r.rows[0] || null;
  }
  const w = memory.withdrawals.get(id);
  if (!w || w.status !== "pending") return null;
  w.status = status;
  return w;
}

function termsKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Я ознакомился с условиями", callback_data: "accept_terms" }],
        [{ text: "◀️ Назад", callback_data: "home" }]
      ]
    }
  };
}

function termsText() {
  return `📜 Условия сдачи NFT / подарков

Перед размещением подарка в аренду обязательно ознакомьтесь с правилами.

1. 🎁 Подарок должен принадлежать вам. Запрещено размещать чужие подарки без разрешения владельца.

2. 💰 Указывайте реальную и понятную цену аренды и срок аренды.

3. 📅 После начала аренды нельзя самовольно отзывать или передавать подарок другому пользователю до окончания оплаченного срока.

4. 🤝 Запрещены обман, мошенничество, фиктивные объявления и попытки получить оплату без предоставления аренды.

5. 🚫 За нарушение правил объявление может быть удалено, а аккаунт — ограничен или заблокирован.

6. 🛡️ Спорные ситуации рассматриваются администрацией сервиса. Решение принимается по данным об оплате и аренде.

7. 💸 Выплата продавцу производится на внутренний баланс бота после успешной оплаты аренды.

8. 🧾 При выводе средств пользователь обязан указывать корректные реквизиты. Ответственность за ошибочные реквизиты несёт пользователь.

9. ⚠️ Администрация может запросить дополнительную проверку по спорной операции.

10. 🔐 Никому не передавайте пароль, коды входа, коды Telegram или другие секретные данные.

Нажимая «Я ознакомился с условиями», вы подтверждаете, что прочитали и принимаете эти правила.`;
}

function rentalInstructionText() {
  return `📦 Как сдать NFT / подарок в аренду

Перед созданием объявления сначала передайте подарок боту.

🎁 Как передать подарок:
1. Откройте свой Telegram-подарок в профиле.
2. Нажмите кнопку действий с подарком.
3. Выберите действие передачи/отправки подарка.
4. В качестве получателя выберите этого бота.
5. После передачи вернитесь сюда и нажмите «✅ Подарок передан боту».

⚠️ Важно:
• Передавайте только тот подарок, которым вы действительно владеете.
• Не отправляйте пароль, код входа, код подтверждения или другие секретные данные.
• Если Telegram не показывает возможность передать этот подарок боту, не пытайтесь обходить ограничения — обратитесь в поддержку.
• Не размещайте один и тот же подарок одновременно в другом месте.

После этого бот попросит название, цену и срок аренды.`;
}

function rentalInstructionKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Подарок передан боту", callback_data: "continue_rent" }],
        [{ text: "📜 Условия сдачи NFT", callback_data: "terms" }],
        [{ text: "◀️ Назад", callback_data: "home" }]
      ]
    }
  };
}

function mainKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🎁 Арендовать подарок", callback_data: "catalog" }],
        [{ text: "🎁 Сдать в аренду", callback_data: "rent_out" }],
        [{ text: "📜 Условия сдачи NFT", callback_data: "terms" }],
        [{ text: "📦 Мои аренды", callback_data: "rentals" }],
        [{ text: "💰 Мой баланс", callback_data: "balance" }],
        [{ text: "💸 Вывести средства", callback_data: "withdraw" }],
        [{ text: "⭐ Пополнить Stars", callback_data: "stars" }],
        [{ text: "💬 Поддержка", callback_data: "support" }]
      ]
    }
  };
}

bot.start(async (ctx) => {
  await ensureUser(ctx);
  await ctx.reply(
    "🎁 Добро пожаловать в аренду уникальных Telegram-подарков!\n\nВыберите действие:",
    mainKeyboard()
  );
});

bot.action("terms", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(termsText(), termsKeyboard());
});

bot.action("accept_terms", async (ctx) => {
  await ctx.answerCbQuery("Условия приняты");
  await ensureUser(ctx);
  states.set(ctx.from.id, { step: "awaiting_gift", termsAccepted: true });
  await ctx.editMessageText(
    "✅ Условия приняты.\n\n" + rentalInstructionText(),
    rentalInstructionKeyboard()
  );
});

bot.action("continue_rent", async (ctx) => {
  await ctx.answerCbQuery();
  await ensureUser(ctx);
  states.set(ctx.from.id, { step: "title", termsAccepted: true });
  await ctx.editMessageText(
    "🎁 Отлично! Теперь напишите название подарка, который хотите сдать в аренду.\n\nНапример: «Весенний мишка» или название вашего NFT."
  );
});

bot.action("balance", async (ctx) => {
  await ctx.answerCbQuery();
  await ensureUser(ctx);
  const balance = await getBalance(ctx.from.id);
  await ctx.editMessageText(
    `💰 Ваш баланс\n\nДоступно: ${balance.toFixed(2)} RUB\n\nЭтот баланс пополняется после успешной аренды ваших подарков.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💸 Вывести средства", callback_data: "withdraw" }],
          [{ text: "◀️ Назад", callback_data: "home" }]
        ]
      }
    }
  );
});

bot.action("catalog", async (ctx) => {
  await ctx.answerCbQuery();
  await ensureUser(ctx);
  const listings = await getListings();

  if (!listings.length) {
    await ctx.editMessageText(
      "🎁 Сейчас нет доступных подарков для аренды.\n\nВладелец подарка может нажать «🎁 Сдать в аренду».",
      { reply_markup: { inline_keyboard: [[{ text: "◀️ Назад", callback_data: "home" }]] } }
    );
    return;
  }

  const rows = listings.map(item => [{
    text: `🎁 ${item.title} — ${Number(item.price).toFixed(2)} ₽ / ${item.duration_days} д.`,
    callback_data: `rent:${item.id}`
  }]);

  rows.push([{ text: "◀️ Назад", callback_data: "home" }]);
  await ctx.editMessageText("🎁 Доступные подарки:", { reply_markup: { inline_keyboard: rows } });
});

bot.action(/^rent:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ensureUser(ctx);
  const listing = await getListing(Number(ctx.match[1]));

  if (!listing) {
    await ctx.editMessageText("❌ Это объявление больше недоступно.");
    return;
  }

  await ctx.replyWithInvoice({
    title: `Аренда: ${listing.title}`,
    description: `Аренда уникального подарка на ${listing.duration_days} д.`,
    payload: JSON.stringify({ type: "rental", listingId: listing.id, renterId: ctx.from.id }),
    currency: "XTR",
    prices: [{ label: `Аренда ${listing.title}`, amount: Math.max(1, Math.round(Number(listing.price))) }]
  });
});

bot.on("pre_checkout_query", async (ctx) => {
  const payload = JSON.parse(ctx.update.pre_checkout_query.invoice_payload || "{}");
  if (payload.type !== "rental") {
    await ctx.answerPreCheckoutQuery(false, "Неизвестный платёж.");
    return;
  }
  const listing = await getListing(Number(payload.listingId));
  if (!listing) {
    await ctx.answerPreCheckoutQuery(false, "Подарок уже недоступен.");
    return;
  }
  await ctx.answerPreCheckoutQuery(true);
});

bot.on("successful_payment", async (ctx) => {
  try {
    const payment = ctx.message.successful_payment;
    const payload = JSON.parse(payment.invoice_payload || "{}");
    if (payload.type !== "rental") return;

    const listing = await getListing(Number(payload.listingId));
    if (!listing) {
      await ctx.reply("⚠️ Платёж получен, но объявление уже недоступно. Обратитесь в поддержку.");
      return;
    }

    const rentalId = await recordRentalAndCredit(listing, ctx.from.id);
    await ctx.reply(
      `✅ Аренда оплачена!\n\n🎁 ${listing.title}\n📅 Срок: ${listing.duration_days} д.\n💰 Владелец получил ${Number(listing.price).toFixed(2)} ₽ на баланс бота.\n🧾 Аренда №${rentalId}`,
      mainKeyboard()
    );
  } catch (err) {
    console.error("successful_payment error:", err);
    await ctx.reply("⚠️ Платёж получен, но обработка аренды завершилась с ошибкой. Обратитесь в поддержку.");
  }
});

bot.action("rent_out", async (ctx) => {
  await ctx.answerCbQuery();
  await ensureUser(ctx);
  await ctx.editMessageText(
    termsText(),
    termsKeyboard()
  );
});

bot.on("text", async (ctx, next) => {
  const state = states.get(ctx.from.id);
  if (!state) return next();

  const text = ctx.message.text.trim();

  if (state.step === "admin_password") {
    if (!ADMIN_TELEGRAM_ID || String(ctx.from.id) !== String(ADMIN_TELEGRAM_ID)) {
      states.delete(ctx.from.id);
      return;
    }
    if (!ADMIN_PANEL_PASSWORD || text !== ADMIN_PANEL_PASSWORD) {
      states.delete(ctx.from.id);
      await ctx.reply("❌ Неверный пароль. Доступ к админ-панели закрыт.");
      return;
    }
    states.delete(ctx.from.id);
    const list = await getPendingWithdrawals();
    if (!list.length) {
      await ctx.reply("🔐 Админ-панель открыта.\n\n💸 Заявок на вывод нет.");
      return;
    }
    await ctx.reply(`🔐 Админ-панель открыта.\n\n💸 Ожидающих заявок: ${list.length}`);
    for (const w of list) {
      await ctx.reply(
        `💸 Заявка №${w.id}\\n\\n👤 ID: ${w.telegram_id}\\n💰 Сумма: ${Number(w.amount).toFixed(2)} ₽\\n💳 Способ: ${w.method}\\n📋 Реквизиты: ${w.details}`,
        { reply_markup: { inline_keyboard: [[
          { text: "✅ Одобрить", callback_data: `wd:approve:${w.id}` },
          { text: "❌ Отклонить", callback_data: `wd:reject:${w.id}` }
        ]] } }
      );
    }
    return;
  }

  if (state.step === "title") {
    state.title = text.slice(0, 100);
    state.step = "price";
    await ctx.reply("💰 Напишите цену аренды в рублях за выбранный срок:");
    return;
  }

  if (state.step === "price") {
    const price = Number(text.replace(",", "."));
    if (!Number.isFinite(price) || price <= 0) {
      await ctx.reply("❌ Введите корректную цену, например: 150");
      return;
    }
    state.price = price;
    state.step = "duration";
    await ctx.reply("📅 Напишите срок аренды в днях, например: 1, 7 или 30:");
    return;
  }

  if (state.step === "duration") {
    const days = Number(text);
    if (!Number.isInteger(days) || days <= 0 || days > 365) {
      await ctx.reply("❌ Введите целое число дней от 1 до 365.");
      return;
    }

    const listingId = await createListing(ctx.from.id, state.title, state.price, days);
    states.delete(ctx.from.id);

    await ctx.reply(
      `✅ Подарок выставлен в аренду!\n\n🎁 ${state.title}\n💰 Цена: ${state.price.toFixed(2)} ₽\n📅 Срок: ${days} д.\n\nПосле успешной оплаты аренды деньги будут зачислены на ваш баланс бота.`,
      mainKeyboard()
    );
    return;
  }

  if (state.step === "withdraw_amount") {
    const amount = Number(text.replace(",", "."));
    const balance = await getBalance(ctx.from.id);

    if (!Number.isFinite(amount) || amount <= 0) {
      await ctx.reply("❌ Введите корректную сумму.");
      return;
    }
    if (amount > balance) {
      await ctx.reply(`❌ Недостаточно средств. Ваш баланс: ${balance.toFixed(2)} ₽`);
      return;
    }

    state.amount = amount;
    state.step = "withdraw_method";
    await ctx.reply("💳 Напишите способ получения выплаты (например, СБП или банковская карта):");
    return;
  }

  if (state.step === "withdraw_method") {
    state.method = text.slice(0, 50);
    state.step = "withdraw_details";
    await ctx.reply("🔐 Напишите реквизиты для выплаты. Не отправляйте сюда пароль или код подтверждения Telegram.");
    return;
  }

  if (state.step === "withdraw_details") {
    const ok = await subtractBalance(ctx.from.id, state.amount);
    if (!ok) {
      states.delete(ctx.from.id);
      await ctx.reply("❌ Не удалось зарезервировать сумму для вывода. Попробуйте ещё раз.");
      return;
    }

    const wid = await createWithdrawal(ctx.from.id, state.amount, state.method, text.slice(0, 300));
    states.delete(ctx.from.id);

    await ctx.reply(
      `✅ Заявка на вывод №${wid} создана.\n\n💰 Сумма: ${state.amount.toFixed(2)} ₽\n💳 Способ: ${state.method}\n\nПосле проверки заявка будет обработана.`,
      mainKeyboard()
    );

    if (ADMIN_TELEGRAM_ID) {
      await bot.telegram.sendMessage(
        ADMIN_TELEGRAM_ID,
        `💸 Новая заявка на вывод №${wid}\n\n👤 Пользователь: ${ctx.from.username ? "@" + ctx.from.username : ctx.from.id}\n🆔 ID: ${ctx.from.id}\n💰 Сумма: ${state.amount.toFixed(2)} ₽\n💳 Способ: ${state.method}\n📋 Реквизиты: ${text.slice(0, 300)}`
      );
    }
  }
});

bot.action("withdraw", async (ctx) => {
  await ctx.answerCbQuery();
  await ensureUser(ctx);
  const balance = await getBalance(ctx.from.id);

  if (balance <= 0) {
    await ctx.editMessageText(
      "💸 Вывод средств\n\nУ вас пока нет доступных средств для вывода.",
      { reply_markup: { inline_keyboard: [[{ text: "◀️ Назад", callback_data: "home" }]] } }
    );
    return;
  }

  states.set(ctx.from.id, { step: "withdraw_amount" });
  await ctx.editMessageText(
    `💸 Вывод средств\n\nДоступно: ${balance.toFixed(2)} ₽\n\nВведите сумму вывода:`
  );
});

bot.command("withdrawals", async (ctx) => {
  if (!ADMIN_TELEGRAM_ID || String(ctx.from.id) !== String(ADMIN_TELEGRAM_ID)) return;
  states.set(ctx.from.id, { step: "admin_password" });
  await ctx.reply("🔐 Введите пароль для доступа к админ-панели:");
});
bot.action(/^wd:(approve|reject):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!ADMIN_TELEGRAM_ID || String(ctx.from.id) !== String(ADMIN_TELEGRAM_ID)) {
    await ctx.reply("⛔ Нет доступа.");
    return;
  }

  const action = ctx.match[1];
  const id = Number(ctx.match[2]);
  const w = await getWithdrawal(id);

  if (!w || w.status !== "pending") {
    await ctx.editMessageText("ℹ️ Эта заявка уже обработана.");
    return;
  }

  if (action === "approve") {
    await updateWithdrawalStatus(id, "approved");
    await ctx.editMessageText(`✅ Заявка №${id} одобрена. Сумма: ${Number(w.amount).toFixed(2)} ₽`);
    try {
      await bot.telegram.sendMessage(
        String(w.telegram_id),
        `✅ Ваша заявка на вывод №${id} одобрена. Сумма: ${Number(w.amount).toFixed(2)} ₽. Выплата производится администратором.`
      );
    } catch (e) {
      console.error("withdrawal notification error:", e);
    }
    return;
  }

  const changed = await updateWithdrawalStatus(id, "rejected");
  if (!changed) {
    await ctx.editMessageText("ℹ️ Эта заявка уже обработана.");
    return;
  }

  await addBalance(w.telegram_id, Number(w.amount));
  await ctx.editMessageText(`❌ Заявка №${id} отклонена. Сумма возвращена пользователю.`);
  try {
    await bot.telegram.sendMessage(
      String(w.telegram_id),
      `❌ Заявка на вывод №${id} отклонена. ${Number(w.amount).toFixed(2)} ₽ возвращены на ваш баланс.`
    );
  } catch (e) {
    console.error("withdrawal notification error:", e);
  }
});

bot.action("home", async (ctx) => {
  await ctx.answerCbQuery();
  await ensureUser(ctx);
  await ctx.editMessageText("🎁 Главное меню:", mainKeyboard());
});

bot.action("rentals", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText("📦 Раздел «Мои аренды» будет расширен после подключения полноценного управления сроком аренды.");
});

bot.action("stars", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText("⭐ Пополнение Stars подключается через официальные Telegram Payments.");
});

bot.action("support", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText("💬 Поддержка: напишите сюда свой вопрос.");
});

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "Telegram Gift Rental Bot" });
});

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`Web server listening on ${PORT}`);
    });

    await bot.launch();
    console.log("Telegram bot started");
  } catch (err) {
    console.error("Startup failed:", err);
    process.exit(1);
  }
}

start();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
