require("dotenv").config();
const http = require("http");
const TelegramBot = require("node-telegram-bot-api");
const {
  init,
  addUser,
  getUserById,
  getAllUsers,
  updateLastActivity,
  addMovie,
  getMovieByCode,
  getAllMovies,
  deleteMovieByCode,
  isAdmin,
  getAdminRole,
  addAdmin,
  removeAdmin,
  getAllAdmins,
  addChannel,
  getAllChannels,
  deleteChannel,
  close,
} = require("./db");
const PORT = process.env.PORT || 3000;
const MOVIES_CHANNEL_ID = process.env.MOVIES_CHANNEL_ID;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID; // Admin ID .env dan
const token = process.env.TELEGRAM_BOT_TOKEN;

http
  .createServer((req, res) => {
    if (req.url === "/healthz") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain");
      res.end("OK");
      return;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain");
    res.end("Not Found");
  })
  .listen(PORT);

let bot = new TelegramBot(token, { polling: false });

// After all handlers are registered, initialize DB and start polling
(async () => {
  try {
    await init();

    // Debug: Token qabul qilindi
    console.log("🤖 Bot ishga tushmoqda...");
    console.log("✅ Token qabul qilindi:", token ? "✓" : "✗");
    console.log("✅ Kanal ID:", MOVIES_CHANNEL_ID);
    console.log("✅ Admin ID:", ADMIN_USER_ID);

    if (bot && typeof bot.startPolling === "function") {
      bot.startPolling();
    } else if (bot && typeof bot._polling === "object") {
      // fallback: enable polling by setting option (older versions may auto-start)
      // nothing to do
    }
  } catch (err) {
    console.error("DB init error:", err);
    process.exit(1);
  }
})();

// Foydalanuvchilar holatini saqlash uchun
const userStates = {};

// note: startup logs printed after DB init

// Bot ready
bot.on("polling_error", (error) => {
  console.error("❌ Polling xatosi:", error);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down...");
  try {
    await close();
  } catch (err) {}
  process.exit(0);
});
process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  try {
    await close();
  } catch (err) {}
  process.exit(0);
});

// Kinoni oblashka bilan kanal saqlash funksiyasi
async function saveMovieWithPoster(
  fileId,
  fileType,
  movieName,
  movieCode,
  posterFileId,
  msgOrQuery,
  chatId,
  userId,
  movieGenre = null,
  movieYear = null,
  movieLanguage = null,
  movieDuration = null,
) {
  const uploadedBy = msgOrQuery.from.username || msgOrQuery.from.first_name;
  const caption = `📽️ <b>${movieName}</b>\n🔑 Kod: <code>${movieCode}</code>\n🎭 Janr: ${movieGenre || "Noma'lum"}\n📅 Yili: ${movieYear || "Noma'lum"}\n🌍 Tili: ${movieLanguage || "Noma'lum"}\n⏱️ Davomiyligi: ${movieDuration || "Noma'lum"}\n📤 Yuklagan: ${uploadedBy}\n⏰ Vaqti: ${new Date().toLocaleString("uz-UZ")}`;

  const sendMethod =
    fileType === "video"
      ? "sendVideo"
      : fileType === "photo"
        ? "sendPhoto"
        : "sendDocument";

  try {
    const sendOptions = {
      caption: caption,
      parse_mode: "HTML",
    };

    // Agar oblashka bo'lsa qo'shish
    if (posterFileId) {
      sendOptions.thumb = posterFileId;
    }

    const sentMessage = await bot[sendMethod](
      MOVIES_CHANNEL_ID,
      fileId,
      sendOptions,
    );

    // Kinoni DB ga saqlash (channel message id ham saqlaymiz)
    await addMovie(
      movieCode,
      movieName,
      fileId,
      fileType,
      posterFileId || null,
      userId,
      movieGenre,
      movieYear,
      movieLanguage,
      movieDuration,
      sentMessage.message_id,
    );

    let successMsg = `✨ Kino muvaffaqiyatli saqlandi!\n\n🎬 <b>${movieName}</b>\n🔑 Kod: <code>${movieCode}</code>`;
    if (posterFileId) {
      successMsg += `\n🎨 Obloshka qo'shildi`;
    }
    successMsg += `\n\nFoydalanuvchilar bu kodi yuborsalar, kino ularni keladi!`;

    bot.sendMessage(chatId, successMsg, { parse_mode: "HTML" });

    // Holatni tozalash
    delete userStates[userId];
  } catch (err) {
    console.error("Kanal xatosi:", err);
    bot.sendMessage(
      chatId,
      "❌ Kino kanalga saqlashda xato! Iltimos keyinroq urinib ko'ring.",
    );
    delete userStates[userId];
  }
}

// Helper: Check if user is subscribed to all required channels
async function isSubscribedToAllChannels(userId) {
  const channels = await getAllChannels();
  if (channels.length === 0) return true; // No channels required

  try {
    for (const channel of channels) {
      const member = await bot.getChatMember(channel.channel_id, userId);
      const status = member.status;
      if (
        status !== "member" &&
        status !== "administrator" &&
        status !== "creator"
      ) {
        return false;
      }
    }
    return true;
  } catch (err) {
    console.error("Channel check error:", err.message);
    return false;
  }
}

// Helper: Get subscription buttons
async function getSubscriptionButtons() {
  const channels = await getAllChannels();
  if (channels.length === 0) return [];

  const buttons = [];
  for (const ch of channels) {
    const channelId = ch.channel_id;
    const username = ch.channel_username;
    const title = ch.channel_title || username || channelId;

    let link;
    if (username) {
      link = `https://t.me/${username}`;
    } else if (String(channelId).startsWith("-100")) {
      link = `https://t.me/c/${String(channelId).slice(4)}`;
    } else {
      // fallback: no public link
      link = `https://t.me/c/${String(channelId).replace(/[^0-9]/g, "")}`;
    }

    buttons.push([
      {
        text: `📢 ${title}`,
        url: link,
      },
    ]);
  }

  buttons.push([
    { text: "✅ Tekshirish", callback_data: "check_subscription" },
  ]);
  return buttons;
}

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const userState = userStates[userId];

  // Foydalanuvchini DB ga qo'shish
  await addUser(userId, msg.from.first_name, msg.from.username || "");
  await updateLastActivity(userId);

  // Mandatory subscription check (applies to all non-admin interactions)
  // Allow admins to use the bot even if they're not subscribed.
  const adminRoleForSubCheck = await getAdminRole(userId);
  const isMainAdminForSubCheck = String(userId) === String(ADMIN_USER_ID);
  const isAdminForSubCheck =
    isMainAdminForSubCheck ||
    adminRoleForSubCheck === "katta_admin" ||
    adminRoleForSubCheck === "kichkina_admin";

  const isStart = msg.text === "/start";
  const isPanel = msg.text === "/panel";
  const isMyId = msg.text === "/myid";

  if (!isAdminForSubCheck && !isStart && !isPanel && !isMyId) {
    const isSubbed = await isSubscribedToAllChannels(userId);
    if (!isSubbed) {
      const subButtons = await getSubscriptionButtons();
      await bot.sendMessage(
        chatId,
        "⚠️ Bot-ni ishlatish uchun barcha kanallarga obuna bo'lishingiz kerak:",
        {
          reply_markup: { inline_keyboard: subButtons },
          parse_mode: "HTML",
        },
      );
      delete userStates[userId];
      return;
    }
  }

  // Admin komandalar
  if (msg.text && msg.text.startsWith("/")) {
    const command = msg.text.split(" ")[0];
    const args = msg.text.split(" ").slice(1);

    // Admin bo'lish tekshirish
    if (command === "/setadmin") {
      // Olib tashlandi
      bot.sendMessage(chatId, "❌ Notogri buydaomish!");
      return;
    }

    if (command === "/myid") {
      bot.sendMessage(chatId, `🆔 Sizning ID: <code>${userId}</code>`, {
        parse_mode: "HTML",
      });
      return;
    }
  }

  // Broadcast handler
  if (userState && userState.status === "waiting_broadcast") {
    if (userId !== ADMIN_USER_ID) {
      bot.sendMessage(chatId, "❌ Notogri buydaomish!");
      delete userStates[userId];
      return;
    }

    const broadcastMsg = msg.text;
    const allUsers = await getAllUsers();

    bot.sendMessage(
      chatId,
      `📢 Reklama ${allUsers.length} ta foydalanuvchiga jo'natilmoqda...`,
    );

    let successCount = 0;
    let errorCount = 0;

    // Barcha userlarga yuborish
    for (const user of allUsers) {
      try {
        await bot.sendMessage(
          user.user_id,
          `📢 <b>Yangilik</b>\n\n${broadcastMsg}`,
          {
            parse_mode: "HTML",
          },
        );
        successCount++;
      } catch (err) {
        errorCount++;
        console.log(`Broadcast xatosi ${user.user_id} ga:`, err.message);
      }
    }

    bot.sendMessage(
      chatId,
      `✅ Broadcast tugallandi!\n\n✔️ Muvaffaq: ${successCount}\n❌ Xato: ${errorCount}`,
    );

    delete userStates[userId];
    return;
  } else if (userState && userState.status === "waiting_channel_link") {
    // Kanal linkini qabul qilish
    try {
      // Best option: user forwards a post/message from the channel
      // This works for private/public channels without relying on getChat(username)
      if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
        const channelId = String(msg.forward_from_chat.id);
        const channelUsername = msg.forward_from_chat.username
          ? String(msg.forward_from_chat.username)
          : null;
        const channelTitle =
          msg.forward_from_chat.title || channelUsername || channelId;

        await addChannel(channelId, channelUsername, channelTitle);

        const sourceView = userState.sourceView || "subscription_manage";
        delete userStates[userId];

        const options = {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔙 Orqaga", callback_data: sourceView }],
            ],
          },
        };

        await bot.sendMessage(
          chatId,
          `✅ Kanal muvaffaqiyatli qo'shildi!\n\n📢 <b>${channelTitle}</b>\n🔑 ID: <code>${channelId}</code>${channelUsername ? `\n🔗 @${channelUsername}` : ""}`,
          { parse_mode: "HTML", reply_markup: options.reply_markup },
        );
        return;
      }

      throw new Error(
        "Kanal qo'shish uchun kanaldan bitta post/xabarni botga FORWARD qiling.",
      );
    } catch (err) {
      console.error("Channel add error:", err);
      const options = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 Orqaga", callback_data: "subscription_manage" }],
          ],
        },
      };

      await bot.sendMessage(
        chatId,
        `❌ Kanal qo'shishda xato! Iltimos to'g'ri link yuboring.\n\nXato: ${err.message}`,
        { parse_mode: "HTML", reply_markup: options.reply_markup },
      );
      delete userStates[userId];
    }
    return;
  } else if (userState && userState.status === "waiting_admin_id_to_add") {
    // Admin ID qabul qilish
    const adminIdToAdd = msg.text.trim();

    // Validatsiya
    if (!/^\d+$/.test(adminIdToAdd)) {
      bot.sendMessage(
        chatId,
        "❌ Noto'g'ri format! Iltimos faqat raqamlar kiriting.",
      );
      return;
    }

    // Admin qo'shish role bilan
    const adminType = userState.adminType || "kichkina_admin";
    await addAdmin(adminIdToAdd, adminType);
    delete userStates[userId];

    const roleText =
      adminType === "katta_admin" ? "🔴 Katta Admin" : "🔵 Kichkina Admin";
    bot.sendMessage(
      chatId,
      `✅ Admin muvaffaqiyatli qo'shildi! (ID: <code>${adminIdToAdd}</code>)\n\nTuri: ${roleText}`,
      { parse_mode: "HTML" },
    );
    return;
  } else if (userState && userState.status === "waiting_delete_code") {
    // Kino o'chirish uchun kodni qabul qilish (faqat Main yoki Head admin)
    const adminRole = await getAdminRole(userId);
    const isMainAdmin = String(userId) === String(ADMIN_USER_ID);
    const isHeadAdmin = adminRole === "katta_admin";
    const hasDeleteAccess = isMainAdmin || isHeadAdmin;

    if (!hasDeleteAccess) {
      bot.sendMessage(chatId, "❌ Sizda bu amalni bajarish huquqi yo'q!");
      delete userStates[userId];
      return;
    }

    const movieCode = (msg.text || "").toUpperCase().trim();
    if (!movieCode) {
      bot.sendMessage(
        chatId,
        "❌ Iltimos o'chirish uchun kino kodini yuboring.",
      );
      return;
    }

    const movie = await getMovieByCode(movieCode);
    if (!movie) {
      bot.sendMessage(chatId, `❌ Kod <code>${movieCode}</code> topilmadi.`, {
        parse_mode: "HTML",
      });
      return;
    }

    // Try to delete channel message if we have stored message id
    try {
      if (movie.channel_message_id) {
        await bot.deleteMessage(MOVIES_CHANNEL_ID, movie.channel_message_id);
      }
    } catch (err) {
      console.error(
        "Channel message delete error:",
        err && err.message ? err.message : err,
      );
      // continue to delete from DB even if channel delete failed
    }

    const res = await deleteMovieByCode(movieCode);
    const deleted = (res && (res.changes > 0 || res.rowCount > 0)) || false;

    if (deleted) {
      bot.sendMessage(
        chatId,
        `✅ Kino o'chirildi: <b>${movie.name}</b>\n🔑 Kod: <code>${movie.code}</code>`,
        { parse_mode: "HTML" },
      );
    } else {
      bot.sendMessage(chatId, "❌ Kino o'chirilmadi — ichki xato yuz berdi.");
    }

    delete userStates[userId];
    return;
  }

  if (msg.text === "/start") {
    // Check subscription
    const isSubbed = await isSubscribedToAllChannels(userId);

    if (!isSubbed) {
      const subButtons = await getSubscriptionButtons();
      bot.sendMessage(
        chatId,
        `⚠️ Bot-ni ishlatish uchun barcha kanallarga obuna bo'lishingiz kerak:`,
        {
          reply_markup: { inline_keyboard: subButtons },
          parse_mode: "HTML",
        },
      );
      delete userStates[userId];
      return;
    }

    // Holatni tozalash
    delete userStates[userId];

    let startMsg = `Salom 👋 Xush kelibsiz! Kinolar botiga xush kelibsiz!\n\n🆔 Sizning ID: <code>${userId}</code>`;

    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📋 Kinolarni ko'r", callback_data: "list_movies" }],
          [{ text: "🔍 Kino qidirish", callback_data: "search_movie" }],
        ],
      },
    };

    bot.sendMessage(chatId, startMsg, {
      parse_mode: "HTML",
      ...options,
    });
  } else if (msg.text === "/panel") {
    // Admin panel - ID tekshirish
    const adminRole = await getAdminRole(userId);
    const isMainAdmin = String(userId) === String(ADMIN_USER_ID);
    const isHeadAdmin = adminRole === "katta_admin";
    const isSmallAdmin = adminRole === "kichkina_admin";

    console.log(
      `Admin check: userId=${userId}, ADMIN_USER_ID=${ADMIN_USER_ID}, isMainAdmin=${isMainAdmin}`,
    );

    if (!isMainAdmin && !isHeadAdmin && !isSmallAdmin) {
      bot.sendMessage(chatId, "❌ Notogri buydaomish yoki tilla topildi!");
      return;
    }

    // Clear any states
    delete userStates[userId];

    if (isSmallAdmin) {
      // Small admin - only kino qo'shish
      const options = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🎬 Kino qo'shish", callback_data: "upload_movie" }],
            [{ text: "🏠 Bosh menu", callback_data: "admin_panel" }],
          ],
        },
      };

      bot.sendMessage(
        chatId,
        "🔐 Admin paneli\n\n📝 Faqat kino qo'shish imkoni bor:",
        options,
      );
    } else {
      // Main or Head admin - full panel
      const options = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🎬 Kino qo'shish", callback_data: "upload_movie" },
              { text: "🗑️ Kino o'chirish", callback_data: "delete_movie" },
            ],
            [
              { text: "📢 Reklama", callback_data: "broadcast_menu" },
              { text: "📊 Statistika", callback_data: "admin_stats" },
            ],
            [
              { text: "👤 Admin boshqaruvi", callback_data: "admin_manage" },
              {
                text: "🔐 Majburiy obuna",
                callback_data: "subscription_manage",
              },
            ],
            [{ text: "❌ Yopish", callback_data: "close_panel" }],
          ],
        },
      };

      bot.sendMessage(
        chatId,
        "🔐 Admin paneli\n\nQuyidagi amallari ishlata olasiz:",
        options,
      );
    }
  } else if (
    userState &&
    userState.status === "waiting_name" &&
    !(userId === ADMIN_USER_ID || (await getAdminRole(userId)))
  ) {
    // Kino qo'shish - FAQAT ADMIN
    bot.sendMessage(
      chatId,
      "❌ Siz kino qo'sha olmaysiz! Faqat admin qo'sha oladi.",
    );
    delete userStates[userId];
  } else if (userState && userState.status === "waiting_name") {
    // Kino nomini kutayotgan vaqt
    const movieName = msg.text;

    // Holatni yangilash - janr kutishga o'tish
    userStates[userId] = {
      status: "waiting_genre",
      fileId: userState.fileId,
      fileType: userState.fileType,
      movieName: movieName,
    };

    bot.sendMessage(
      chatId,
      `✅ Kino nomi: <b>${movieName}</b>\n\n🎭 Endi kino janrini kiriting (masalan: Fantastik, Drama, Komediya, Jangari):`,
      { parse_mode: "HTML" },
    );
  } else if (userState && userState.status === "waiting_genre") {
    // Kino janrini kutayotgan vaqt
    const movieGenre = msg.text;

    // Holatni yangilash - yil kutishga o'tish
    userStates[userId] = {
      status: "waiting_year",
      fileId: userState.fileId,
      fileType: userState.fileType,
      movieName: userState.movieName,
      movieGenre: movieGenre,
    };

    bot.sendMessage(
      chatId,
      `✅ Janr: <b>${movieGenre}</b>\n\n📅 Endi chiqqan yilini kiriting (masalan: 2024):`,
      { parse_mode: "HTML" },
    );
  } else if (userState && userState.status === "waiting_year") {
    // Kino yilini kutayotgan vaqt
    const movieYear = msg.text;

    // Holatni yangilash - til kutishga o'tish
    userStates[userId] = {
      status: "waiting_language",
      fileId: userState.fileId,
      fileType: userState.fileType,
      movieName: userState.movieName,
      movieGenre: userState.movieGenre,
      movieYear: movieYear,
    };

    bot.sendMessage(
      chatId,
      `✅ Yil: <b>${movieYear}</b>\n\n🌍 Endi tilini kiriting (masalan: O'zbek, Rus, Ingliz, Turk):`,
      { parse_mode: "HTML" },
    );
  } else if (userState && userState.status === "waiting_language") {
    // Kino tilini kutayotgan vaqt
    const movieLanguage = msg.text;

    // Holatni yangilash - davomiyligi kutishga o'tish
    userStates[userId] = {
      status: "waiting_duration",
      fileId: userState.fileId,
      fileType: userState.fileType,
      movieName: userState.movieName,
      movieGenre: userState.movieGenre,
      movieYear: userState.movieYear,
      movieLanguage: movieLanguage,
    };

    bot.sendMessage(
      chatId,
      `✅ Til: <b>${movieLanguage}</b>\n\n⏱️ Endi davomiyligini kiriting (masalan: 2 soat 15 daqiqa yoki 135 daqiqa):`,
      { parse_mode: "HTML" },
    );
  } else if (userState && userState.status === "waiting_duration") {
    // Kino davomiyligini kutayotgan vaqt
    const movieDuration = msg.text;

    // Holatni yangilash - kod kutishga o'tish
    userStates[userId] = {
      status: "waiting_code",
      fileId: userState.fileId,
      fileType: userState.fileType,
      movieName: userState.movieName,
      movieGenre: userState.movieGenre,
      movieYear: userState.movieYear,
      movieLanguage: userState.movieLanguage,
      movieDuration: movieDuration,
    };

    bot.sendMessage(
      chatId,
      `✅ Davomiyligi: <b>${movieDuration}</b>\n\n🔑 Endi kino uchun kod kiriting (masalan: ABC123):`,
      { parse_mode: "HTML" },
    );
  } else if (userState && userState.status === "waiting_code") {
    // Kino kodini kutayotgan vaqt
    const movieCode = msg.text.toUpperCase().trim();
    const movieName = userState.movieName;
    const fileType = userState.fileType;
    const fileId = userState.fileId;

    // Kod validatsiyasi (minimal uzunlik olib tashlandi)
    if (movieCode.length < 1) {
      bot.sendMessage(
        chatId,
        "❌ Kod bo'sh bo'lishi mumkin emas! Iltimos kod kiriting.",
      );
      return;
    }

    // Kodning takrorlanishini tekshirish
    const existingMovie = await getMovieByCode(movieCode);
    if (existingMovie) {
      bot.sendMessage(
        chatId,
        `❌ Bu kod allaqachon ishlatilgan! Boshqa kod tanlang.\n\n🎬 Kino: ${existingMovie.name}\n🔑 Kod: ${existingMovie.code}`,
      );
      return;
    }

    // Kinoni darhol saqlash (poster shart emas)
    delete userStates[userId];
    await saveMovieWithPoster(
      fileId,
      fileType,
      movieName,
      movieCode,
      null,
      msg,
      chatId,
      userId,
      userState.movieGenre,
      userState.movieYear,
      userState.movieLanguage,
      userState.movieDuration,
    );
  } else if (msg.video || msg.document) {
    // Video yoki fayl yuborilgan
    const fileId = msg.video?.file_id || msg.document?.file_id;
    const fileType = msg.video ? "video" : "document";

    // Foydalanuvchi holatini saqlash
    userStates[userId] = {
      status: "waiting_name",
      fileId: fileId,
      fileType: fileType,
    };

    bot.sendMessage(
      chatId,
      "📝 Kino uchun nom kiriting (masalan: Titanic, Avatar va h.k.):",
    );
  } else if (msg.photo) {
    // Photo yuborilgan
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const fileType = "photo";

    // Foydalanuvchi holatini saqlash
    userStates[userId] = {
      status: "waiting_name",
      fileId: fileId,
      fileType: fileType,
    };

    bot.sendMessage(
      chatId,
      "📝 Kino uchun nom kiriting (masalan: Titanic, Avatar va h.k.):",
    );
  } else if (msg.text) {
    // Kino kodini yordamida qidirish
    const movieCode = msg.text.toUpperCase().trim();
    const found = await getMovieByCode(movieCode);

    if (found) {
      const sendMethod =
        found.file_type === "video"
          ? "sendVideo"
          : found.file_type === "photo"
            ? "sendPhoto"
            : "sendDocument";

      const sendOptions = {
        caption: `🎬 <b>${found.name}</b>\n🔑 Kod: <code>${found.code}</code>\n🎭 Janr: ${found.genre || "Noma'lum"}\n📅 Yili: ${found.year || "Noma'lum"}\n🌍 Tili: ${found.language || "Noma'lum"}\n⏱️ Davomiyligi: ${found.duration || "Noma'lum"}\n⏰ Sana: ${new Date(found.uploaded_at).toLocaleString("uz-UZ")}`,
        parse_mode: "HTML",
      };

      // Agar obloshka bo'lsa qo'shish
      if (found.poster_file_id) {
        sendOptions.thumb = found.poster_file_id;
      }

      bot[sendMethod](chatId, found.file_id, sendOptions);
    } else {
      bot.sendMessage(
        chatId,
        `❌ Kod <code>${movieCode}</code> topilmadi!\n\n💡 Iltimos to'g'ri kino kodini yuboring yoki "📋 Kinolarni ko'r" tugmasini bosing.`,
        { parse_mode: "HTML" },
      );
    }
  }
});

// Tugma bosilganligi uchun handler
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const userId = String(query.from.id);
  const userState = userStates[userId];

  // Mandatory subscription check for button actions as well
  const adminRoleForSubCheck = await getAdminRole(userId);
  const isMainAdminForSubCheck = String(userId) === String(ADMIN_USER_ID);
  const isAdminForSubCheck =
    isMainAdminForSubCheck ||
    adminRoleForSubCheck === "katta_admin" ||
    adminRoleForSubCheck === "kichkina_admin";

  if (!isAdminForSubCheck && query.data !== "check_subscription") {
    const isSubbed = await isSubscribedToAllChannels(userId);
    if (!isSubbed) {
      const subButtons = await getSubscriptionButtons();
      await bot.answerCallbackQuery(query.id, {
        text: "❌ Avval kanallarga obuna bo'ling!",
        show_alert: true,
      });
      await bot.sendMessage(
        chatId,
        "⚠️ Bot-ni ishlatish uchun barcha kanallarga obuna bo'lishingiz kerak:",
        {
          reply_markup: { inline_keyboard: subButtons },
          parse_mode: "HTML",
        },
      );
      return;
    }
  }

  if (query.data === "close_panel") {
    // Panel yopish
    bot.deleteMessage(chatId, query.message.message_id);
  } else if (query.data === "start_menu") {
    // Bosh menyu - /start komandasi
    delete userStates[userId];

    let startMsg = `Salom 👋 Xush kelibsiz! Kinolar botiga xush kelibsiz!\n\n🆔 Sizning ID: <code>${userId}</code>`;

    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📋 Kinolarni ko'r", callback_data: "list_movies" }],
          [{ text: "🔍 Kino qidirish", callback_data: "search_movie" }],
        ],
      },
    };

    if (userId === ADMIN_USER_ID || (await getAdminRole(userId))) {
      options.reply_markup.inline_keyboard.push([
        { text: "🔐 Admin paneli", callback_data: "admin_panel" },
      ]);
    }

    bot.editMessageText(startMsg, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: "HTML",
      ...options,
    });
  } else if (query.data === "admin_panel") {
    // Admin panelga qaytish
    const adminRole = await getAdminRole(userId);
    const isMainAdmin = String(userId) === String(ADMIN_USER_ID);
    const isHeadAdmin = adminRole === "katta_admin";
    const isSmallAdmin = adminRole === "kichkina_admin";

    console.log(
      `Admin check callback: userId=${userId}, ADMIN_USER_ID=${ADMIN_USER_ID}, isMainAdmin=${isMainAdmin}`,
    );

    if (!isMainAdmin && !isHeadAdmin && !isSmallAdmin) {
      bot.answerCallbackQuery(query.id, {
        text: "❌ Notogri buydaomish!",
        show_alert: true,
      });
      return;
    }

    delete userStates[userId];

    if (isSmallAdmin) {
      // Small admin - only kino qo'shish
      const options = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🎬 Kino qo'shish", callback_data: "upload_movie" }],
            [{ text: "🏠 Bosh menu", callback_data: "admin_panel" }],
          ],
        },
      };

      bot.editMessageText(
        "🔐 Admin paneli\n\n📝 Faqat kino qo'shish imkoni bor:",
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          ...options,
        },
      );
    } else {
      // Main or Head admin - full panel
      const options = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🎬 Kino qo'shish", callback_data: "upload_movie" },
              { text: "🗑️ Kino o'chirish", callback_data: "delete_movie" },
            ],
            [
              { text: "📢 Reklama", callback_data: "broadcast_menu" },
              { text: "📊 Statistika", callback_data: "admin_stats" },
            ],
            [
              { text: "👤 Admin boshqaruvi", callback_data: "admin_manage" },
              {
                text: "🔐 Majburiy obuna",
                callback_data: "subscription_manage",
              },
            ],
            [{ text: "❌ Yopish", callback_data: "close_panel" }],
          ],
        },
      };

      bot.editMessageText(
        "🔐 Admin paneli\n\nQuyidagi amallari ishlata olasiz:",
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          ...options,
        },
      );
    }
  } else if (query.data === "upload_movie") {
    // Admin check
    const adminRole = await getAdminRole(userId);
    const isMainAdmin = userId === ADMIN_USER_ID;
    const isAdmin =
      isMainAdmin ||
      adminRole === "katta_admin" ||
      adminRole === "kichkina_admin";

    if (!isAdmin) {
      bot.answerCallbackQuery(query.id, {
        text: "❌ Notogri buydaomish!",
        show_alert: true,
      });
      return;
    }

    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Orqaga", callback_data: "admin_panel" }],
          [{ text: "🏠 Bosh menu", callback_data: "admin_panel" }],
        ],
      },
    };

    bot.editMessageText(
      "🎬 Video yoki rasm faylini yuboring.\n\nKeyin bot siz kino uchun nom sorashi va kod yaratadi.",
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        ...options,
      },
    );
  } else if (query.data === "delete_movie") {
    // Kino o'chirish — faqat Main yoki Head adminlar uchun
    const adminRole = await getAdminRole(userId);
    const isMainAdmin = userId === ADMIN_USER_ID;
    const isHeadAdmin = adminRole === "katta_admin";
    const hasDeleteAccess = isMainAdmin || isHeadAdmin;

    if (!hasDeleteAccess) {
      bot.answerCallbackQuery(query.id, {
        text: "❌ Notogri buydaomish!",
        show_alert: true,
      });
      return;
    }

    const movies = await getAllMovies();

    // Show simple list with codes (no per-item delete buttons) and ask for code
    if (movies.length === 0) {
      const options = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 Orqaga", callback_data: "admin_panel" }],
          ],
        },
      };
      bot.editMessageText("📭 Hozircha kinolar yo'q.", {
        chat_id: chatId,
        message_id: query.message.message_id,
        ...options,
      });
      return;
    }

    let movieList = "🗑️ <b>Kino o'chirish</b> — Kino kodini yuboring:\n\n";
    movies.forEach((m, idx) => {
      movieList += `${idx + 1}. <b>${m.name}</b> — 🔑 <code>${m.code}</code>\n`;
    });
    movieList +=
      "\n🔎 Iltimos o'chirmoqchi bo'lgan kinoning `kod`ini yuboring.";

    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Orqaga", callback_data: "admin_panel" }],
        ],
      },
      parse_mode: "HTML",
    };

    // Set state so next text message is treated as delete-code
    userStates[userId] = { status: "waiting_delete_code" };

    bot.editMessageText(movieList, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: "HTML",
      ...options,
    });
  } else if (query.data === "list_movies") {
    const movies = await getAllMovies();
    if (movies.length === 0) {
      bot.sendMessage(chatId, "📭 Hozircha kinolar yo'q.");
    } else {
      let movieList = "📽️ <b>Barcha kinolar:</b>\n\n";
      movies.forEach((movie, index) => {
        movieList += `${index + 1}. <b>${movie.name}</b>\n   🔑 Kod: <code>${movie.code}</code>\n\n`;
      });
      movieList += "⬇️ Kino kodini yuboring kinoni yuklab olish uchun!";
      bot.sendMessage(chatId, movieList, { parse_mode: "HTML" });
    }
  } else if (query.data === "search_movie") {
    bot.sendMessage(
      chatId,
      "🔍 Kino kodini yuboring (masalan: <code>KINO5F7A9B2C</code>):",
      { parse_mode: "HTML" },
    );
  } else if (query.data === "admin_stats") {
    // Admin statistikasi - only main or head admin
    const adminRole = getAdminRole(userId);
    const isMainAdmin = userId === ADMIN_USER_ID;
    const isHeadAdmin = adminRole === "katta_admin";
    const hasStatsAccess = isMainAdmin || isHeadAdmin;

    if (!hasStatsAccess) {
      bot.answerCallbackQuery(query.id, {
        text: "❌ Notogri buydaomish!",
        show_alert: true,
      });
      return;
    }

    const allMovies = await getAllMovies();
    const allUsers = await getAllUsers();
    const allAdmins = await getAllAdmins();

    const statsMsg = `📊 <b>Bot Statistikasi</b>\n\n🎬 Kinolar: ${allMovies.length}\n👥 Foydalanuvchilar: ${allUsers.length}\n🔐 Adminlar: ${allAdmins.length}`;

    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Orqaga", callback_data: "admin_panel" }],
          [{ text: "🏠 Bosh menu", callback_data: "admin_panel" }],
        ],
      },
    };

    bot.editMessageText(statsMsg, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: "HTML",
      ...options,
    });
  } else if (query.data === "broadcast_menu") {
    // Reklama yuborish - only main or head admin
    const adminRole = await getAdminRole(userId);
    const isMainAdmin = userId === ADMIN_USER_ID;
    const isHeadAdmin = adminRole === "katta_admin";
    const hasBroadcastAccess = isMainAdmin || isHeadAdmin;

    if (!hasBroadcastAccess) {
      bot.answerCallbackQuery(query.id, {
        text: "❌ Notogri buydaomish!",
        show_alert: true,
      });
      return;
    }

    // Reklama yuborish
    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Orqaga", callback_data: "admin_panel" }],
          [{ text: "🏠 Bosh menu", callback_data: "admin_panel" }],
        ],
      },
    };

    bot.editMessageText(
      "📢 <b>Reklama yuborish</b>\n\nReklama matnini yuboring. Bu ALL foydalanuvchilarga jo'natiladi!\n\n⚠️ Faqat admin!",
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        ...options,
      },
    );

    // Broadcast mode
    userStates[userId] = {
      status: "waiting_broadcast",
    };
  } else if (query.data === "admin_manage") {
    // Admin boshqaruvi - only main or head admin
    const adminRole = await getAdminRole(userId);
    const isMainAdmin = userId === ADMIN_USER_ID;
    const isHeadAdmin = adminRole === "katta_admin";
    const hasManageAccess = isMainAdmin || isHeadAdmin;

    if (!hasManageAccess) {
      bot.answerCallbackQuery(query.id, {
        text: "❌ Notogri buydaomish!",
        show_alert: true,
      });
      return;
    }

    const options = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "➕ Admin qo'shish", callback_data: "add_admin" },
            { text: "❌ Admin olib tashlash", callback_data: "remove_admin" },
          ],
          [{ text: "🔙 Orqaga", callback_data: "admin_panel" }],
        ],
      },
    };

    const allAdmins = await getAllAdmins();
    let adminList = "👤 <b>Admin Boshqaruvi</b>\n\n";
    adminList += `Hozirgi adminlar: ${allAdmins.length}\n\n`;
    allAdmins.forEach((admin, index) => {
      const roleText =
        admin.role === "katta_admin" ? "🔴 Katta Admin" : "🔵 Kichkina Admin";
      adminList += `${index + 1}. ID: <code>${admin.user_id}</code> (${roleText})\n`;
    });

    bot.editMessageText(adminList, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: "HTML",
      ...options,
    });
  } else if (query.data === "add_admin") {
    // Admin qo'shish - type so'rash
    const adminRole = await getAdminRole(userId);
    const isMainAdmin = userId === ADMIN_USER_ID;
    const isHeadAdmin = adminRole === "katta_admin";
    const hasManageAccess = isMainAdmin || isHeadAdmin;

    if (!hasManageAccess) {
      bot.answerCallbackQuery(query.id, {
        text: "❌ Notogri buydaomish!",
        show_alert: true,
      });
      return;
    }

    userStates[userId] = {
      status: "waiting_admin_type",
    };

    const options = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔴 Katta Admin", callback_data: "admin_type_katta" },
            { text: "🔵 Kichkina Admin", callback_data: "admin_type_kichkina" },
          ],
          [{ text: "🔙 Orqaga", callback_data: "admin_manage" }],
          [{ text: "🏠 Bosh menu", callback_data: "admin_panel" }],
        ],
      },
    };

    bot.editMessageText(
      "👤 <b>Admin turini tanlang:</b>\n\n🔴 <b>Katta Admin</b> - Menimcha huquqlar\n🔵 <b>Kichkina Admin</b> - Faqat kino qo'shish",
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        ...options,
      },
    );
  } else if (query.data === "remove_admin") {
    // Admin olib tashlash - ro'yxat ko'rsatish
    const adminRole = await getAdminRole(userId);
    const isMainAdmin = userId === ADMIN_USER_ID;
    const isHeadAdmin = adminRole === "katta_admin";
    const hasManageAccess = isMainAdmin || isHeadAdmin;

    if (!hasManageAccess) {
      bot.answerCallbackQuery(query.id, {
        text: "❌ Notogri buydaomish!",
        show_alert: true,
      });
      return;
    }

    const allAdmins = await getAllAdmins();
    if (allAdmins.length === 0) {
      bot.sendMessage(
        chatId,
        "📭 Hozircha hech qanday admin yo'q (faqat asosiy admin mavjud).",
      );
      return;
    }

    const buttons = [];
    allAdmins.forEach((admin) => {
      const roleText = admin.role === "katta_admin" ? "🔴" : "🔵";
      buttons.push([
        {
          text: `❌ ${admin.user_id} (${roleText})`,
          callback_data: `remove_admin_${admin.user_id}`,
        },
      ]);
    });

    buttons.push([{ text: "🔙 Orqaga", callback_data: "admin_manage" }]);
    buttons.push([{ text: "🏠 Bosh menu", callback_data: "admin_panel" }]);

    const options = {
      reply_markup: {
        inline_keyboard: buttons,
      },
    };

    bot.sendMessage(
      chatId,
      "❌ Olib tashlash uchun admin ID sini bosing:",
      options,
    );
  } else if (query.data.startsWith("remove_admin_")) {
    // Adminni olib tashlash
    const adminRole = getAdminRole(userId);
    const isMainAdmin = userId === ADMIN_USER_ID;
    const isHeadAdmin = adminRole === "katta_admin";
    const hasManageAccess = isMainAdmin || isHeadAdmin;

    if (!hasManageAccess) {
      bot.answerCallbackQuery(query.id, {
        text: "❌ Notogri buydaomish!",
        show_alert: true,
      });
      return;
    }

    const adminId = query.data.replace("remove_admin_", "");
    const removed = removeAdmin(adminId);

    if (removed.changes > 0) {
      bot.answerCallbackQuery(query.id, {
        text: `✅ Admin (ID: ${adminId}) o'chirildi!`,
      });
      bot.sendMessage(chatId, `✅ Admin (ID: ${adminId}) o'chirildi!`);
    } else {
      bot.answerCallbackQuery(query.id, {
        text: "❌ Admin topilmadi!",
        show_alert: true,
      });
    }
  } else if (query.data === "admin_type_katta") {
    // Katta admin select
    userStates[userId] = {
      status: "waiting_admin_id_to_add",
      adminType: "katta_admin",
    };

    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Orqaga", callback_data: "admin_manage" }],
          [{ text: "🏠 Bosh menu", callback_data: "admin_panel" }],
        ],
      },
    };

    bot.editMessageText(
      "👤 <b>Katta Admin ID</b>\\n\\nTelegram ID raqamini yuboring (masalan: 6873538625):",
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        ...options,
      },
    );
  } else if (query.data === "admin_type_kichkina") {
    // Kichkina admin select
    userStates[userId] = {
      status: "waiting_admin_id_to_add",
      adminType: "kichkina_admin",
    };

    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Orqaga", callback_data: "admin_manage" }],
          [{ text: "🏠 Bosh menu", callback_data: "admin_panel" }],
        ],
      },
    };

    bot.editMessageText(
      "👤 <b>Kichkina Admin ID</b>\\n\\nTelegram ID raqamini yuboring (masalan: 6873538625):",
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        ...options,
      },
    );
  } else if (query.data === "check_subscription") {
    // Obuna tekshirish
    const isSubbed = await isSubscribedToAllChannels(userId);
    if (isSubbed) {
      bot.answerCallbackQuery(query.id, {
        text: "✅ Siz barcha kanallarga obuna bo'lgansiz!",
      });
      // Yangi requestni start menu-ga jo'natsa qilish
      const startMsg = `Salom 👋 Xush kelibsiz! Kinolar botiga xush kelibsiz!\n\n🆔 Sizning ID: <code>${userId}</code>`;
      const options = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "📋 Kinolarni ko'r", callback_data: "list_movies" }],
            [{ text: "🔍 Kino qidirish", callback_data: "search_movie" }],
          ],
        },
      };
      if (userId === ADMIN_USER_ID || (await getAdminRole(userId))) {
        options.reply_markup.inline_keyboard.push([
          { text: "🔐 Admin paneli", callback_data: "admin_panel" },
        ]);
      }
      bot.editMessageText(startMsg, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        ...options,
      });
    } else {
      bot.answerCallbackQuery(query.id, {
        text: "❌ Siz hali barcha kanallarga obuna bo'lmagansiz!",
        show_alert: true,
      });
    }
  } else if (query.data === "subscription_manage") {
    // Majburiy obuna boshqaruvi
    const adminRole = await getAdminRole(userId);
    const isMainAdmin = userId === ADMIN_USER_ID;
    const isHeadAdmin = adminRole === "katta_admin";
    const hasAccess = isMainAdmin || isHeadAdmin;

    if (!hasAccess) {
      bot.answerCallbackQuery(query.id, {
        text: "❌ Notogri buydaomish!",
        show_alert: true,
      });
      return;
    }

    const channels = await getAllChannels();
    const buttons = [];

    // Kanal qo'shish tugmasi
    buttons.push([{ text: "➕ Kanal qo'shish", callback_data: "add_channel" }]);

    // Mavjud kanallar list
    if (channels.length > 0) {
      buttons.push([
        { text: "🗑️ Kanal o'chirish", callback_data: "delete_channel_menu" },
      ]);
    }

    buttons.push([{ text: "🔙 Orqaga", callback_data: "admin_panel" }]);

    let msg = "🔐 <b>Majburiy obuna boshqaruvi</b>\n\n";
    msg += `Hozirda ${channels.length}ta kanal majburiy:\n\n`;

    if (channels.length === 0) {
      msg += "📭 Hozirda majburiy kanal yo'q\n\n";
      msg += "💡 Kanal qo'shish uchun \"➕ Kanal qo'shish\" tugmasini bosing";
    } else {
      channels.forEach((ch, i) => {
        const displayName =
          ch.channel_title || ch.channel_username || ch.channel_id;
        msg += `${i + 1}. <b>${displayName}</b>\n   🔑 ID: <code>${ch.channel_id}</code>\n`;
        if (ch.channel_username) {
          msg += `   🔗 @${ch.channel_username}\n`;
        }
        msg += "\n";
      });
      msg += `\n💡 Foydalanuvchilar bu kanallarga obuna bo'lmaguncha bot-dan foydalana olmaydi`;
    }

    // Bosh menu tugmasini qo'shish
    buttons.push([{ text: "🏠 Bosh menu", callback_data: "admin_panel" }]);

    const options = {
      reply_markup: {
        inline_keyboard: buttons,
      },
    };

    bot.editMessageText(msg, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: "HTML",
      ...options,
    });
  } else if (query.data === "channel_manage") {
    // Kanal boshqaruvini ko'rsatish
    const adminRole = await getAdminRole(userId);
    const isMainAdmin = userId === ADMIN_USER_ID;
    const isHeadAdmin = adminRole === "katta_admin";
    const hasAccess = isMainAdmin || isHeadAdmin;

    if (!hasAccess) {
      bot.answerCallbackQuery(query.id, {
        text: "❌ Notogri buydaomish!",
        show_alert: true,
      });
      return;
    }

    const channels = await getAllChannels();
    const buttons = [];

    // Kanal qo'shish tugmasi
    buttons.push([{ text: "➕ Kanal qo'shish", callback_data: "add_channel" }]);

    // Mavjud kanallar list
    if (channels.length > 0) {
      buttons.push([
        { text: "🗑️ Kanal o'chirish", callback_data: "delete_channel_menu" },
      ]);
    }

    buttons.push([{ text: "🔙 Orqaga", callback_data: "admin_panel" }]);

    let msg = "📡 <b>Kanal boshqaruvi</b>\n\n";
    msg += `Hozirgi majburiy kanallar: ${channels.length}\n\n`;
    channels.forEach((ch, i) => {
      msg += `${i + 1}. <code>${ch.channel_id}</code>\n`;
    });

    const options = {
      reply_markup: {
        inline_keyboard: buttons,
      },
    };

    bot.editMessageText(msg, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: "HTML",
      ...options,
    });
  } else if (query.data === "add_channel") {
    // Kanal qo'shish uchun link so'rash
    userStates[userId] = {
      status: "waiting_channel_link",
      sourceView: "subscription_manage",
    };

    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Orqaga", callback_data: "subscription_manage" }],
          [{ text: "🏠 Bosh menu", callback_data: "admin_panel" }],
        ],
      },
    };

    bot.editMessageText(
      "📡 Kanal qo'shish:\n\nQo'shmoqchi bo'lgan kanalingizdan bitta post/xabarni botga FORWARD qiling.",
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        ...options,
      },
    );
  } else if (query.data === "delete_channel_menu") {
    // O'chirish menu
    const channels = await getAllChannels();
    const buttons = [];

    channels.forEach((ch) => {
      buttons.push([
        {
          text: `❌ ${ch.channel_id}`,
          callback_data: `del_ch_${ch.channel_id}`,
        },
      ]);
    });

    buttons.push([{ text: "🔙 Orqaga", callback_data: "subscription_manage" }]);
    buttons.push([{ text: "🏠 Bosh menu", callback_data: "admin_panel" }]);

    const options = {
      reply_markup: {
        inline_keyboard: buttons,
      },
    };

    bot.editMessageText("Kanal tanlang:", {
      chat_id: chatId,
      message_id: query.message.message_id,
      ...options,
    });
  } else if (query.data.startsWith("del_ch_")) {
    // Kanal o'chirish
    const channelId = query.data.replace("del_ch_", "");
    await deleteChannel(channelId);

    bot.answerCallbackQuery(query.id, {
      text: `✅ Kanal o'chirildi!`,
    });

    // Subscription management menu-ga qaytish
    const channels = await getAllChannels();
    const buttons = [];

    buttons.push([{ text: "➕ Kanal qo'shish", callback_data: "add_channel" }]);

    if (channels.length > 0) {
      buttons.push([
        { text: "🗑️ Kanal o'chirish", callback_data: "delete_channel_menu" },
      ]);
    }

    buttons.push([{ text: "🔙 Orqaga", callback_data: "admin_panel" }]);
    buttons.push([{ text: "🏠 Bosh menu", callback_data: "admin_panel" }]);

    let msg = "🔐 <b>Majburiy obuna boshqaruvi</b>\n\n";
    msg += `Hozirda ${channels.length}ta kanal majburiy:\n\n`;
    channels.forEach((ch, i) => {
      msg += `${i + 1}. <code>${ch.channel_id}</code>\n`;
    });

    const options = {
      reply_markup: {
        inline_keyboard: buttons,
      },
    };

    bot.editMessageText(msg, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: "HTML",
      ...options,
    });
  }

  // Callback query ni tugatish
  bot.answerCallbackQuery(query.id);
});
