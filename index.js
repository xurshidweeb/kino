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
  getMoviesCount,
  getTopMovies,
  incrementMovieViews,
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

let bot = new TelegramBot(token, { polling: true });

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
  description = null,
  movieGenre = null,
  movieYear = null,
  movieLanguage = null,
  movieDuration = null,
) {
  const uploadedBy = msgOrQuery.from.username || msgOrQuery.from.first_name;
  let caption;
  if (description) {
    caption = `📋 <b>${movieName}</b>\n\n${description}\n\n🔑 Kod: <code>${movieCode}</code>`;
  } else {
    caption = `📽️ <b>${movieName}</b>\n\n🎭 Janr: ${movieGenre || "Noma'lum"}\n📅 Yili: ${movieYear || "Noma'lum"}\n🌍 Tili: ${movieLanguage || "Noma'lum"}\n⏱️ Davomiyligi: ${movieDuration || "Noma'lum"}\n📤 Yuklagan: ${uploadedBy}\n\n🔑 Kod: <code>${movieCode}</code>`;
  }

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
      description,
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

  // Broadcast forward handler (forward prepared post)
  if (userState && userState.status === "waiting_broadcast_forward") {
    if (userId !== ADMIN_USER_ID && !(await getAdminRole(userId))) {
      bot.sendMessage(chatId, "❌ Notogri buydaomish!");
      delete userStates[userId];
      return;
    }

    const allUsers = await getAllUsers();
    bot.sendMessage(
      chatId,
      `📢 Reklama ${allUsers.length} ta foydalanuvchiga jo'natilmoqda...`,
    );

    let successCount = 0;
    let errorCount = 0;

    // Forward qilingan kontentni yuborish
    for (const user of allUsers) {
      try {
        if (msg.photo) {
          await bot.sendPhoto(
            user.user_id,
            msg.photo[msg.photo.length - 1].file_id,
            {
              caption: msg.caption || "",
              parse_mode: "HTML",
            },
          );
        } else if (msg.video) {
          await bot.sendVideo(user.user_id, msg.video.file_id, {
            caption: msg.caption || "",
            parse_mode: "HTML",
          });
        } else if (msg.document) {
          await bot.sendDocument(user.user_id, msg.document.file_id, {
            caption: msg.caption || "",
            parse_mode: "HTML",
          });
        } else if (msg.text) {
          await bot.sendMessage(user.user_id, msg.text, {
            parse_mode: "HTML",
          });
        }
        successCount++;
      } catch (err) {
        errorCount++;
        console.log(`Broadcast xatosi ${user.user_id} ga:`, err.message);
      }
    }

    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Orqaga", callback_data: "broadcast_menu" }],
        ],
      },
    };

    bot.sendMessage(
      chatId,
      `✅ Broadcast tugallandi!\n\n✔️ Muvaffaq: ${successCount}\n❌ Xato: ${errorCount}`,
      options,
    );

    delete userStates[userId];
    return;
  } else if (
    userState &&
    userState.status === "waiting_broadcast_create_media"
  ) {
    // Reklama tayyorlash - media qabul qilish
    if (userId !== ADMIN_USER_ID && !(await getAdminRole(userId))) {
      bot.sendMessage(chatId, "❌ Notogri buydaomish!");
      delete userStates[userId];
      return;
    }

    let fileId = null;
    let fileType = null;

    if (msg.photo) {
      fileId = msg.photo[msg.photo.length - 1].file_id;
      fileType = "photo";
    } else if (msg.video) {
      fileId = msg.video.file_id;
      fileType = "video";
    } else if (msg.document) {
      fileId = msg.document.file_id;
      fileType = "document";
    } else if (
      msg.text &&
      (msg.text === "❌ Kerak emas" || msg.text === "⏩ O'tkazib yuborish")
    ) {
      // No file needed
      fileId = null;
      fileType = null;
    } else {
      bot.sendMessage(
        chatId,
        "❌ Iltimos rasm, video yoki file yuboring, yoki 'Kerak emas' tugmasini bosing.",
      );
      return;
    }

    userStates[userId] = {
      status: "waiting_broadcast_create_text",
      broadcastFileId: fileId,
      broadcastFileType: fileType,
    };

    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Orqaga", callback_data: "broadcast_menu" }],
        ],
      },
    };

    bot.sendMessage(
      chatId,
      `${fileId ? "✅ File qabul qilindi!\n\n" : ""}📝 Endi reklama matnini yuboring (yoki bo'sh qoldiring):`,
      options,
    );
    return;
  } else if (
    userState &&
    userState.status === "waiting_broadcast_create_text"
  ) {
    // Reklama tayyorlash - text qabul qilish va preview ko'rsatish
    if (userId !== ADMIN_USER_ID && !(await getAdminRole(userId))) {
      bot.sendMessage(chatId, "❌ Notogri buydaomish!");
      delete userStates[userId];
      return;
    }

    const broadcastText = msg.text || "";
    const broadcastFileId = userState.broadcastFileId;
    const broadcastFileType = userState.broadcastFileType;

    // Preview postning ko'rinishini tayyorlash
    userStates[userId] = {
      status: "broadcast_preview",
      broadcastFileId: broadcastFileId,
      broadcastFileType: broadcastFileType,
      broadcastText: broadcastText,
    };

    const previewOptions = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Tasdiqlash", callback_data: "broadcast_confirm" }],
          [{ text: "❌ Bekor qilish", callback_data: "broadcast_cancel" }],
        ],
      },
    };

    // Preview ko'rsatish
    try {
      if (broadcastFileType === "photo" && broadcastFileId) {
        await bot.sendPhoto(chatId, broadcastFileId, {
          caption: `📋 <b>Reklama ko'rinishi:</b>\n\n${broadcastText}`,
          parse_mode: "HTML",
          ...previewOptions,
        });
      } else if (broadcastFileType === "video" && broadcastFileId) {
        await bot.sendVideo(chatId, broadcastFileId, {
          caption: `📋 <b>Reklama ko'rinishi:</b>\n\n${broadcastText}`,
          parse_mode: "HTML",
          ...previewOptions,
        });
      } else if (broadcastFileType === "document" && broadcastFileId) {
        await bot.sendDocument(chatId, broadcastFileId, {
          caption: `📋 <b>Reklama ko'rinishi:</b>\n\n${broadcastText}`,
          parse_mode: "HTML",
          ...previewOptions,
        });
      } else if (broadcastText) {
        bot.sendMessage(
          chatId,
          `📋 <b>Reklama ko'rinishi:</b>\n\n${broadcastText}`,
          {
            parse_mode: "HTML",
            ...previewOptions,
          },
        );
      } else {
        bot.sendMessage(
          chatId,
          "❌ Reklama bo'sh! Iltimos text yoki file bilan urinib ko'ring.",
          previewOptions,
        );
      }
    } catch (err) {
      console.error("Preview xatosi:", err.message);
      bot.sendMessage(chatId, "❌ Preview ko'rsatishda xato yuz berdi!");
      delete userStates[userId];
    }
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

    let startMsg = `Salom 👋 Xush kelibsiz!\n\nKino kodini yuboring yoki Top kinolarni tomosha qiling.`;

    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏆 Top kinolar", callback_data: "top_movies_0" }],
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
    userState.status === "waiting_description" &&
    !(userId === ADMIN_USER_ID || (await getAdminRole(userId)))
  ) {
    // Kino qo'shish - FAQAT ADMIN
    bot.sendMessage(
      chatId,
      "❌ Siz kino qo'sha olmaysiz! Faqat admin qo'sha oladi.",
    );
    delete userStates[userId];
  } else if (userState && userState.status === "waiting_description") {
    // Admin yuborgan description qabul qilindi -> so'raladi: kode kiriting
    const description = msg.text || "";

    // Save description and ask for code from admin
    userStates[userId] = {
      status: "waiting_code",
      fileId: userState.fileId,
      fileType: userState.fileType,
      description: description,
    };

    bot.sendMessage(
      chatId,
      "🔐 Iltimos kino uchun unikal kod kiriting (masalan: KINO1234):",
    );
  } else if (userState && userState.status === "waiting_code") {
    // Admin provided a code for the movie -> validate uniqueness then show preview
    const providedCode = (msg.text || "").trim().toUpperCase();
    if (!providedCode) {
      bot.sendMessage(
        chatId,
        "❌ Kod bo'sh bo'lishi mumkin emas. Iltimos kod kiriting:",
      );
      return;
    }

    // check if code already exists
    const existing = await getMovieByCode(providedCode);
    if (existing) {
      bot.sendMessage(
        chatId,
        "❌ Bu kod allaqachon ishlatilgan. Iltimos boshqa kod kiriting:",
      );
      return;
    }

    // Move to preview state with provided code
    userStates[userId] = {
      status: "upload_preview",
      fileId: userState.fileId,
      fileType: userState.fileType,
      description: userState.description,
      code: providedCode,
    };

    const previewOptions = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Tasdiqlash", callback_data: "confirm_upload" }],
          [{ text: "❌ Bekor qilish", callback_data: "cancel_upload" }],
        ],
      },
    };

    try {
      const captionText = `📋 <b>Kino preview:</b>\n\n${userState.description}\n\n🔑 <b>Kod:</b> ${providedCode}`;
      if (userState.fileType === "photo") {
        await bot.sendPhoto(chatId, userState.fileId, {
          caption: captionText,
          parse_mode: "HTML",
          ...previewOptions,
        });
      } else if (userState.fileType === "video") {
        await bot.sendVideo(chatId, userState.fileId, {
          caption: captionText,
          parse_mode: "HTML",
          ...previewOptions,
        });
      } else {
        await bot.sendDocument(chatId, userState.fileId, {
          caption: captionText,
          parse_mode: "HTML",
          ...previewOptions,
        });
      }
    } catch (err) {
      console.error("Preview upload error:", err.message);
      bot.sendMessage(chatId, "❌ Preview ko'rsatishda xato yuz berdi!");
      delete userStates[userId];
    }
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

    // NEW: after duration we won't ask for code in this simplified flow
    // (older multi-step flow removed in favor of single-description preview)
  } else if (msg.video || msg.document) {
    // Video yoki fayl yuborilgan
    const fileId = msg.video?.file_id || msg.document?.file_id;
    const fileType = msg.video ? "video" : "document";
    // Save state -> ask for a single description (izoh)
    userStates[userId] = {
      status: "waiting_description",
      fileId: fileId,
      fileType: fileType,
    };

    bot.sendMessage(
      chatId,
      "📝 Iltimos kino uchun bitta xabarda izoh yuboring (hammasini shu xabarda yozing):",
    );
  } else if (msg.photo) {
    // Photo yuborilgan
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const fileType = "photo";
    userStates[userId] = {
      status: "waiting_description",
      fileId: fileId,
      fileType: fileType,
    };

    bot.sendMessage(
      chatId,
      "📝 Iltimos kino uchun bitta xabarda izoh yuboring (hammasini shu xabarda yozing):",
    );
  } else if (msg.text) {
    // Kino raqami yoki kodi orqali qidirish
    const input = msg.text.trim();
    const isNumber = /^\d+$/.test(input);

    let found = null;

    if (isNumber && userState && userState.status === "viewing_top") {
      // Numeric selection while viewing top list -> map to pageList
      const idx = parseInt(input) - 1;
      const pageList = userState.pageList || [];
      if (idx >= 0 && idx < pageList.length) {
        const movieCode = pageList[idx];
        found = await getMovieByCode(movieCode);
      } else {
        bot.sendMessage(
          chatId,
          `❌ Noto'g'ri raqam! Iltimos 1 dan ${pageList.length} gacha bo'lgan raqam yuboring.`,
        );
        return;
      }
    } else {
      // Treat input as movie code (numeric codes supported too)
      const movieCode = input.toUpperCase();
      found = await getMovieByCode(movieCode);
    }

    if (found) {
      const sendMethod =
        found.file_type === "video"
          ? "sendVideo"
          : found.file_type === "photo"
            ? "sendPhoto"
            : "sendDocument";

      // Use description if provided, otherwise use old template format
      const caption = found.description
        ? `📋 <b>${found.name}</b>\n\n${found.description}\n\n🔑 Kod: <code>${found.code}</code>`
        : `🎬 <b>${found.name}</b>\n\n🎭 Janr: ${found.genre || "Noma'lum"}\n📅 Yili: ${found.year || "Noma'lum"}\n🌍 Tili: ${found.language || "Noma'lum"}\n⏱️ Davomiyligi: ${found.duration || "Noma'lum"}\n\n🔑 Kod: <code>${found.code}</code>`;

      const sendOptions = {
        caption: caption,
        parse_mode: "HTML",
      };

      // Increment view counter
      try {
        await incrementMovieViews(found.code);
      } catch (e) {
        console.error("View increment error:", e && e.message ? e.message : e);
      }

      // Agar obloshka bo'lsa qo'shish
      if (found.poster_file_id) {
        sendOptions.thumb = found.poster_file_id;
      }

      await bot[sendMethod](chatId, found.file_id, sendOptions);

      // clear viewing_top state to avoid numeric inputs being interpreted
      if (userState && userState.status === "viewing_top") {
        delete userStates[userId];
      }
    } else {
      const errorMsg = `❌ Kod <code>${input}</code> topilmadi!\n\n💡 Iltimos to'g'ri kino kodini yuboring.`;
      bot.sendMessage(chatId, errorMsg, { parse_mode: "HTML" });
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

    let startMsg = `Salom 👋 Xush kelibsiz! Kinolar botiga xush kelibsiz!\n\n🆔 Sizning ID: <code>${userId}</code>\n\nKino kodini yuboring yoki Top kinolarni tomosha qiling.`;

    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏆 Top kinolar", callback_data: "top_movies_0" }],
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
  } else if (query.data.startsWith("top_movies_")) {
    // Top kinolar pagination
    const pageStr = query.data.replace("top_movies_", "");
    const page = parseInt(pageStr) || 0;
    const moviesPerPage = 5;
    const totalMovies = await getMoviesCount();

    if (totalMovies === 0) {
      bot.answerCallbackQuery(query.id, {
        text: "📭 Hozircha kinolar yo'q!",
        show_alert: true,
      });
      return;
    }

    // Jami sahifalar
    const totalPages = Math.ceil(totalMovies / moviesPerPage);
    const startIdx = page * moviesPerPage;
    const endIdx = startIdx + moviesPerPage;
    // fetch only required page ordered by views desc
    const paginatedMovies = await getTopMovies(moviesPerPage, startIdx);

    // Save currently displayed page codes for numeric selection
    userStates[userId] = {
      status: "viewing_top",
      page: page,
      pageList: paginatedMovies.map((m) => m.code),
    };

    let movieList = `🏆 <b>Top kinolar</b>\n\n`;
    paginatedMovies.forEach((movie, idx) => {
      const actualIndex = startIdx + idx + 1;
      movieList += `${actualIndex}. <b>${movie.name}</b>\n   👁️ ${movie.views || 0} korish\n\n`;
    });
    movieList +=
      "⬇️ Korsatilgan 5 ta kinoning raqamini yuboring kinoni olish uchun!";

    const buttons = [];

    // Orqaga tugmasi
    if (page > 0) {
      buttons.push({
        text: "⬅️ Orqaga",
        callback_data: `top_movies_${page - 1}`,
      });
    }

    // Oldinga tugmasi
    if (endIdx < totalMovies) {
      buttons.push({
        text: "Oldinga ➡️",
        callback_data: `top_movies_${page + 1}`,
      });
    }

    const options = {
      reply_markup: {
        inline_keyboard: [buttons.length > 0 ? buttons : []].filter(
          (row) => row.length > 0,
        ),
      },
    };

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
    // Reklama menyu - ikkita variant
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

    delete userStates[userId];

    const options = {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📤 Tayyor postni yuborish",
              callback_data: "broadcast_forward",
            },
          ],
          [
            {
              text: "🎨 Reklama tayyorlash",
              callback_data: "broadcast_create",
            },
          ],
          [{ text: "🔙 Orqaga", callback_data: "admin_panel" }],
        ],
      },
    };

    bot.editMessageText(
      "📢 <b>Reklama menyu</b>\n\n🔹 <b>Tayyor postni yuborish</b> - Biror joydan forward qilingan postni barcha foydalanuvchilarga jo'natish\n\n🔹 <b>Reklama tayyorlash</b> - Rasm/video/file va text bilan reklama yaratib jo'natish",
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        ...options,
      },
    );
  } else if (query.data === "broadcast_forward") {
    // Tayyor postni forward qilish
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

    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Orqaga", callback_data: "broadcast_menu" }],
        ],
      },
    };

    bot.editMessageText(
      "📤 <b>Tayyor postni yuborish</b>\n\nBiror joydan (kanal, guruh, private) bitta xabarni <b>FORWARD</b> qiling. Bot uni barcha foydalanuvchilarga jo'natadi!",
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        ...options,
      },
    );

    userStates[userId] = {
      status: "waiting_broadcast_forward",
    };
  } else if (query.data === "broadcast_create") {
    // Reklama tayyorlash
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

    const options = {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "❌ Kerak emas",
              callback_data: "broadcast_create_skip_media",
            },
          ],
          [{ text: "🔙 Orqaga", callback_data: "broadcast_menu" }],
        ],
      },
    };

    bot.editMessageText(
      "🎨 <b>Reklama tayyorlash</b>\n\n1️⃣ Rasm, video yoki file yuboring (majburiy emas):",
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        ...options,
      },
    );

    userStates[userId] = {
      status: "waiting_broadcast_create_media",
    };
  } else if (query.data === "broadcast_create_skip_media") {
    // Media kerak emas, to'g'ridan to'g'ri textga o'tish
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

    userStates[userId] = {
      status: "waiting_broadcast_create_text",
      broadcastFileId: null,
      broadcastFileType: null,
    };

    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Orqaga", callback_data: "broadcast_menu" }],
        ],
      },
    };

    bot.editMessageText("📝 <b>Reklama matnini yuboring</b>:", {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: "HTML",
      ...options,
    });
  } else if (query.data === "broadcast_confirm") {
    // Reklama tasdiqlash va yuborish
    const userState = userStates[userId];
    if (!userState || userState.status !== "broadcast_preview") {
      bot.answerCallbackQuery(query.id, {
        text: "❌ Sessiya tugagan!",
        show_alert: true,
      });
      return;
    }

    const broadcastFileId = userState.broadcastFileId;
    const broadcastFileType = userState.broadcastFileType;
    const broadcastText = userState.broadcastText || "";
    const allUsers = await getAllUsers();

    bot.answerCallbackQuery(query.id, {
      text: "📢 Jo'natilmoqda...",
    });

    let successCount = 0;
    let errorCount = 0;

    // Barcha userlarga yuborish
    for (const user of allUsers) {
      try {
        if (broadcastFileType === "photo" && broadcastFileId) {
          await bot.sendPhoto(user.user_id, broadcastFileId, {
            caption: broadcastText || "",
            parse_mode: "HTML",
          });
        } else if (broadcastFileType === "video" && broadcastFileId) {
          await bot.sendVideo(user.user_id, broadcastFileId, {
            caption: broadcastText || "",
            parse_mode: "HTML",
          });
        } else if (broadcastFileType === "document" && broadcastFileId) {
          await bot.sendDocument(user.user_id, broadcastFileId, {
            caption: broadcastText || "",
            parse_mode: "HTML",
          });
        } else if (broadcastText) {
          await bot.sendMessage(user.user_id, broadcastText, {
            parse_mode: "HTML",
          });
        }
        successCount++;
      } catch (err) {
        errorCount++;
        console.log(`Broadcast xatosi ${user.user_id} ga:`, err.message);
      }
    }

    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Orqaga", callback_data: "broadcast_menu" }],
        ],
      },
    };

    bot.sendMessage(
      chatId,
      `✅ Broadcast tugallandi!\n\n✔️ Muvaffaq: ${successCount}\n❌ Xato: ${errorCount}`,
      options,
    );

    delete userStates[userId];
  } else if (query.data === "confirm_upload") {
    // Admin confirmed the upload preview -> save movie
    const u = userStates[userId];
    if (!u || u.status !== "upload_preview") {
      bot.answerCallbackQuery(query.id, {
        text: "❌ Sessiya tugagan!",
        show_alert: true,
      });
      return;
    }

    // use provided code if available, otherwise generate simple unique code
    const movieCode =
      u.code ||
      `KINO${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    const movieName =
      (u.description || "").split("\n")[0].slice(0, 100) || "No title";

    try {
      await saveMovieWithPoster(
        u.fileId,
        u.fileType,
        movieName,
        movieCode,
        null,
        query,
        chatId,
        userId,
        u.description,
      );
      bot.answerCallbackQuery(query.id, { text: "✅ Kino kanalga saqlandi!" });
    } catch (err) {
      console.error("Save movie error:", err);
      bot.answerCallbackQuery(query.id, {
        text: "❌ Saqlashda xato!",
        show_alert: true,
      });
    }
    delete userStates[userId];
  } else if (query.data === "cancel_upload") {
    // Admin cancelled upload preview
    delete userStates[userId];
    bot.answerCallbackQuery(query.id, { text: "❌ Yuklash bekor qilindi" });
    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Admin panel", callback_data: "admin_panel" }],
        ],
      },
    };
    bot.sendMessage(chatId, "❌ Yuklash bekor qilindi.", options);
  } else if (query.data === "broadcast_cancel") {
    // Reklama tayyorlanishini bekor qilish
    const userState = userStates[userId];
    if (!userState || userState.status !== "broadcast_preview") {
      bot.answerCallbackQuery(query.id, {
        text: "❌ Sessiya tugagan!",
        show_alert: true,
      });
      return;
    }

    delete userStates[userId];

    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Orqaga", callback_data: "admin_panel" }],
        ],
      },
    };

    bot.sendMessage(
      chatId,
      "❌ Reklama bekor qilindi!\n\n🔐 Admin panelga qaytish uchun tugmasini bosing.",
      options,
    );
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
  } else if (query.data === "check_subscription") {
    // Obuna tekshirish
    const isSubbed = await isSubscribedToAllChannels(userId);
    if (isSubbed) {
      bot.answerCallbackQuery(query.id, {
        text: "✅ Siz barcha kanallarga obuna bo'lgansiz!",
      });
      // Yangi requestni start menu-ga jo'natsa qilish
      const startMsg = `Salom 👋 Xush kelibsiz! Kinolar botiga xush kelibsiz!\n\n🆔 Sizning ID: <code>${userId}</code>\n\nKino kodini yuboring yoki Top kinolarni tomosha qiling.`;
      const options = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🏆 Top kinolar", callback_data: "top_movies_0" }],
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
