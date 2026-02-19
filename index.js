require("dotenv").config();
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
  close,
} = require("./db");
const token = process.env.TELEGRAM_BOT_TOKEN;
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
const MOVIES_CHANNEL_ID = process.env.MOVIES_CHANNEL_ID;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID; // Admin ID .env dan

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
) {
  const uploadedBy = msgOrQuery.from.username || msgOrQuery.from.first_name;
  const caption = `📽️ <b>${movieName}</b>\n🔑 Kod: <code>${movieCode}</code>\n📤 Yuklagan: ${uploadedBy}\n⏰ Vaqti: ${new Date().toLocaleString("uz-UZ")}`;

  const sendMethod = fileType === "video" ? "sendVideo" : "sendDocument";

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

    // Kinoni DB ga saqlash
    await addMovie(
      movieCode,
      movieName,
      fileId,
      fileType,
      posterFileId || null,
      userId,
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

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const userState = userStates[userId];

  // Foydalanuvchini DB ga qo'shish
  await addUser(userId, msg.from.first_name, msg.from.username || "");
  await updateLastActivity(userId);

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
  }

  if (msg.text === "/start") {
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
    const isMainAdmin = userId === ADMIN_USER_ID;
    const isHeadAdmin = adminRole === "katta_admin";
    const isSmallAdmin = adminRole === "kichkina_admin";

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
            [{ text: "❌ Yopish", callback_data: "close_panel" }],
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
            [{ text: "👤 Admin boshqaruvi", callback_data: "admin_manage" }],
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

    // Holatni yangilash - kod kutishga o'tish
    userStates[userId] = {
      status: "waiting_code",
      fileId: userState.fileId,
      fileType: userState.fileType,
      movieName: movieName,
    };

    bot.sendMessage(
      chatId,
      `✅ Kino nomi: <b>${movieName}</b>\n\n🔑 Endi kino uchun kod kiriting (masalan: ABC123):`,
      { parse_mode: "HTML" },
    );
  } else if (userState && userState.status === "waiting_code") {
    // Kino kodini kutayotgan vaqt
    const movieCode = msg.text.toUpperCase().trim();
    const movieName = userState.movieName;
    const fileType = userState.fileType;
    const fileId = userState.fileId;

    // Kod validatsiyasi
    if (movieCode.length < 3) {
      bot.sendMessage(
        chatId,
        "❌ Kod juda qisqa! Iltimos uzunroq kod kiriting (minimal 3 ta harf).",
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
  } else if (msg.text) {
    // Kino kodini yordamida qidirish
    const movieCode = msg.text.toUpperCase().trim();
    const found = await getMovieByCode(movieCode);

    if (found) {
      const sendMethod =
        found.file_type === "video" ? "sendVideo" : "sendDocument";

      const sendOptions = {
        caption: `🎬 <b>${found.name}</b>\n🔑 Kod: <code>${found.code}</code>\n⏰ Sana: ${new Date(found.uploaded_at).toLocaleString("uz-UZ")}`,
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
    const isMainAdmin = userId === ADMIN_USER_ID;
    const isHeadAdmin = adminRole === "katta_admin";
    const isSmallAdmin = adminRole === "kichkina_admin";

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
            [{ text: "❌ Yopish", callback_data: "close_panel" }],
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
            [{ text: "👤 Admin boshqaruvi", callback_data: "admin_manage" }],
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
    // Kino o'chirish - Admin check (only main or head admin)
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

    // Kinolar ro'yxati with delete buttons
    let movieList = "🗑️ <b>Kino o'chirish:</b>\n\n";
    const buttons = [];

    movies.forEach((movie) => {
      buttons.push([
        {
          text: `❌ ${movie.name}`,
          callback_data: `del_${movie.code}`,
        },
      ]);
    });

    buttons.push([{ text: "🔙 Orqaga", callback_data: "admin_panel" }]);

    const options = {
      reply_markup: {
        inline_keyboard: buttons,
      },
    };

    bot.editMessageText("O'chirish uchun kino nomini bosing:", {
      chat_id: chatId,
      message_id: query.message.message_id,
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
  }

  // Callback query ni tugatish
  bot.answerCallbackQuery(query.id);
});
