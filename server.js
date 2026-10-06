const express = require("express");
const { Telegraf } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is not configured");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

bot.start(async (ctx) => {
  await ctx.reply(
    "🎁 Добро пожаловать в аренду уникальных Telegram-подарков!\n\nВыберите действие:",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎁 Арендовать подарок", callback_data: "catalog" }],
          [{ text: "📦 Мои аренды", callback_data: "rentals" }],
          [{ text: "⭐ Пополнить Stars", callback_data: "stars" }],
          [{ text: "💬 Поддержка", callback_data: "support" }]
        ]
      }
    }
  );
});

bot.action("catalog", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    "🎁 Каталог пока пуст.\n\nСледующим шагом добавим реальные уникальные подарки, сроки аренды и цены."
  );
});

bot.action("rentals", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText("📦 У вас пока нет активных аренд.");
});

bot.action("stars", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText("⭐ Пополнение Stars подключим через официальные Telegram Payments.");
});

bot.action("support", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText("💬 Поддержка: напишите сюда свой вопрос.");
});

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "Telegram Gift Rental Bot" });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Web server listening on ${PORT}`);
});

bot.launch().then(() => {
  console.log("Telegram bot started");
}).catch((err) => {
  console.error("Telegram bot failed to start:", err);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
