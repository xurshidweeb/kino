require("dotenv").config();
const http = require("http");
const TelegramBot = require("node-telegram-bot-api");
const BotMonitor = require("./monitoring");
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
  getSetting,
  setSetting,
  close,
} = require("./db");
const PORT = process.env.PORT || 3000;
const MOVIES_CHANNEL_ID = process.env.MOVIES_CHANNEL_ID;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID; // Admin ID .env dan
const token = process.env.TELEGRAM_BOT_TOKEN;

const mainMenuOptions = {
  reply_markup: {
    inline_keyboard: [],
  },
};

const healthServer = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain");
    res.end("OK");
    return;
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain");
  res.end("Not Found");
});

healthServer.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(
      `Health server port band: ${PORT}. Bot ishlashda davom etadi (localda).`,
    );
    return;
  }
  console.error("Health server error:", err);
});

healthServer.listen(PORT);

let bot = new TelegramBot(token, { polling: false });

let BOT_USERNAME = null;

async function getPromoChannel() {
  const raw = await getSetting("promo_channel");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.id) return parsed;
  } catch (e) {}
  return { id: raw };
}

async function setPromoChannel(channel) {
  return setSetting("promo_channel", JSON.stringify(channel));
}

// After all handlers are registered, initialize DB and start polling
(async () => {
  try {
    await init();

    try {
      const me = await bot.getMe();
      BOT_USERNAME = me && me.username ? String(me.username) : null;
    } catch (e) {
      BOT_USERNAME = null;
    }

    // Bot ishga tushmoqda
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

// Monitoring system (soddalashtirilgan)
const monitor = new BotMonitor();

// note: startup logs printed after DB init

// Bot ready
bot.on("polling_error", (error) => {
  console.error("❌ Polling xatosi:", error);
});

// Kino uchun standart format
function formatMovieCaption(movie, views) {
  const description = movie.description || movie.name || '';
  return description 
    ? `${description}\n\n🔒 Kod: ${movie.code}\n👁️ Jami ko'rishlar: ${views || 0} ta`
    : `🎬 ${movie.name}\n\n🔒 Kod: ${movie.code}\n👁️ Jami ko'rishlar: ${views || 0} ta`;
}

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
  description = null,
  msgOrQuery,
  chatId,
  userId,
  movieGenre = null,
  movieYear = null,
  movieLanguage = null,
  movieDuration = null,
  skipMainMenu = false,
) {
  const uploadedBy = msgOrQuery.from.username || msgOrQuery.from.first_name;
  let caption;
  
  // formatMovieCaption funksiyasidan foydalanamiz
  const movie = {
    name: movieName,
    code: movieCode,
    description: description
  };
  caption = formatMovieCaption(movie, 0);

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
      disable_web_page_preview: true,
      protect_content: true,
    };

    const sentMessage = await bot[sendMethod](
      MOVIES_CHANNEL_ID,
      fileId,
      sendOptions,
    );

    // Kinoni DB ga saqlash (channel message id ham saqlaymiz)
    await addMovie(
      movieCode,
      movieName,
      description,
      fileId,
      fileType,
      null, // posterFileId
      userId,
      movieGenre,
      movieYear,
      movieLanguage,
      movieDuration,
      sentMessage.message_id,
    );

    let successMsg = `✨ Kino muvaffaqiyatli saqlandi!\n\n🎬 <b>${movieName}</b>\n🔑 Kod: <code>${movieCode}</code>`;
    successMsg += `\n\nFoydalanuvchilar bu kodi yuborsalar, kino ularni keladi!`;

    const messageOptions = {
      parse_mode: "HTML",
    };

    if (!skipMainMenu) {
      Object.assign(messageOptions, mainMenuOptions);
    }

    bot.sendMessage(chatId, successMsg, messageOptions);

    // Holatni tozalash
    if (!skipMainMenu) {
      delete userStates[userId];
    }
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

// Helper: Get unsubscribed channels list
async function getUnsubscribedChannels(userId) {
  const channels = await getAllChannels();
  const unsubscribed = [];
  
  if (channels.length === 0) return unsubscribed;

  try {
    for (const channel of channels) {
      const member = await bot.getChatMember(channel.channel_id, userId);
      const status = member.status;
      if (
        status !== "member" &&
        status !== "administrator" &&
        status !== "creator"
      ) {
        unsubscribed.push(channel);
      }
    }
  } catch (err) {
    console.error("Channel check error:", err.message);
  }
  
  return unsubscribed;
}

// Helper: Get subscription buttons
async function getSubscriptionButtons(userId) {
  const allChannels = await getAllChannels();
  const unsubscribedChannels = await getUnsubscribedChannels(userId);
  
  if (allChannels.length === 0) return [];
  if (unsubscribedChannels.length === 0) return []; // All subscribed

  const buttons = [];
  for (const ch of unsubscribedChannels) {
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

  try {
    // Track request (soddalashtirilgan)
    monitor.trackRequest(userId, 'message', 0, true);

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
      const unsubscribedChannels = await getUnsubscribedChannels(userId);
      const subButtons = await getSubscriptionButtons(userId);
      await bot.sendMessage(
        chatId,
        `⚠️ Bot-ni ishlatish uchun ${unsubscribedChannels.length > 0 ? unsubscribedChannels.length + ' ta' : ''} kanallarga obuna bo'lishingiz kerak:`,
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
      {
        ...options,
        reply_markup: {
          inline_keyboard: [
            ...(options.reply_markup && options.reply_markup.inline_keyboard
              ? options.reply_markup.inline_keyboard
              : []),
            [{ text: "🏠 Bosh menu", callback_data: "start_menu" }],
          ],
        },
      },
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
    // Reklama tayyorlash - matn qabul qilish
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
  } else if (
    userState &&
    userState.status === "waiting_promo_channel_forward"
  ) {
    // Admin kanalni forward qilib sozlash
    try {
      if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
        const channelId = String(msg.forward_from_chat.id);
        const channelUsername = msg.forward_from_chat.username
          ? String(msg.forward_from_chat.username)
          : null;
        const channelTitle =
          msg.forward_from_chat.title || channelUsername || channelId;

        await setPromoChannel({
          id: channelId,
          username: channelUsername,
          title: channelTitle,
        });

        delete userStates[userId];

        await bot.sendMessage(
          chatId,
          `✅ Admin kanal saqlandi!\n\n📢 <b>${channelTitle}</b>\n🔑 ID: <code>${channelId}</code>${channelUsername ? `\n🔗 @${channelUsername}` : ""}`,
          { parse_mode: "HTML" },
        );
        return;
      }

      throw new Error(
        "Admin kanal qo'shish uchun o'sha kanaldan bitta post/xabarni botga FORWARD qiling.",
      );
    } catch (err) {
      await bot.sendMessage(
        chatId,
        `❌ Admin kanal qo'shishda xato!\n\nXato: ${err.message}`,
      );
      delete userStates[userId];
      return;
    }
  } else if (userState && userState.status === "waiting_promo_trailer") {
    // Promo kanalga treyler yuborish
    const promo = await getPromoChannel();
    if (!promo || !promo.id) {
      delete userStates[userId];
      await bot.sendMessage(
        chatId,
        "❌ Admin kanal sozlanmagan. Avval admin paneldan Admin kanalni sozlang.",
      );
      return;
    }

    const trailerFileId =
      msg.video?.file_id || msg.photo?.slice(-1)[0]?.file_id;
    const trailerType = msg.video ? "video" : msg.photo ? "photo" : null;

    if (!trailerFileId || !trailerType) {
      await bot.sendMessage(
        chatId,
        "❌ Iltimos treyler uchun rasm yoki qisqa video yuboring.",
      );
      return;
    }

    const movieCode = userState.movieCode;
    const description = userState.description || "";

    let watchUrl = null;
    if (BOT_USERNAME) {
      watchUrl = `https://t.me/${BOT_USERNAME}?start=movie_${encodeURIComponent(movieCode)}`;
    }

    const replyMarkup = watchUrl
      ? {
          inline_keyboard: [[{ text: "👀 Ko'rish", url: watchUrl }]],
        }
      : null;

    try {
      if (trailerType === "video") {
        await bot.sendVideo(promo.id, trailerFileId, {
          caption: description,
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        });
      } else {
        await bot.sendPhoto(promo.id, trailerFileId, {
          caption: description,
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        });
      }

      delete userStates[userId];
      await bot.sendMessage(chatId, "✅ Kanalga ulashildi!", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔐 Admin paneli", callback_data: "admin_panel" }],
            [{ text: "🏠 Bosh menu", callback_data: "start_menu" }],
          ],
        },
      });
    } catch (err) {
      console.error("Promo send error:", err);
      delete userStates[userId];
      await bot.sendMessage(chatId, "❌ Kanalga yuborishda xato yuz berdi.", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔐 Admin paneli", callback_data: "admin_panel" }],
            [{ text: "🏠 Bosh menu", callback_data: "start_menu" }],
          ],
        },
      });
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
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔐 Admin paneli", callback_data: "admin_panel" }],
          ],
        },
        parse_mode: "HTML",
      },
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
        { 
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔐 Admin paneli", callback_data: "admin_panel" }],
            ],
          },
        },
      );
    } else {
      bot.sendMessage(chatId, "❌ Kino o'chirilmadi — ichki xato yuz berdi.");
    }

    delete userStates[userId];
    return;
  }

  if (msg.text && msg.text.startsWith("/start")) {
    const parts = msg.text.trim().split(/\s+/);
    const payload = parts.length > 1 ? parts.slice(1).join(" ") : null;

    // Deep-link payload: /start movie_<CODE>
    if (payload && payload.startsWith("movie_")) {
      const movieCode = payload.replace("movie_", "").trim().toUpperCase();
      const found = await getMovieByCode(movieCode);
      if (found) {
        const sendMethod =
          found.file_type === "video"
            ? "sendVideo"
            : found.file_type === "photo"
              ? "sendPhoto"
              : "sendDocument";

        let viewsToShow = Number(found.views || 0);
        try {
          await incrementMovieViews(found.code);
        } catch (e) {
          console.error(
            "View increment error:",
            e && e.message ? e.message : e,
          );
          viewsToShow = Number(found.views || 0);
        }

        // formatMovieCaption funksiyasidan foydalanamiz
        const caption = formatMovieCaption(found, viewsToShow);

        const sendOptions = {
          caption,
          parse_mode: "HTML",
        };

        if (found.poster_file_id) {
          sendOptions.thumb = found.poster_file_id;
        }

        try {
          await bot[sendMethod](chatId, found.file_id, sendOptions);
        } catch (err) {
          console.error(
            "Send movie error:",
            err && err.message ? err.message : err,
          );
          await bot.sendMessage(
            chatId,
            "❌ Kino yuborishda xato yuz berdi. Iltimos keyinroq urinib ko'ring.",
          );
        }
      } else {
        const errorMsg = `❌ Kod <code>${movieCode}</code> topilmadi!\n\n💡 Iltimos to'g'ri kino kodini yuboring.`;
        bot.sendMessage(chatId, errorMsg, { parse_mode: "HTML" });
      }
      return;
    }

    // Check subscription
    const isSubbed = await isSubscribedToAllChannels(userId);

    if (!isSubbed) {
      const unsubscribedChannels = await getUnsubscribedChannels(userId);
      const subButtons = await getSubscriptionButtons(userId);
      bot.sendMessage(
        chatId,
        `⚠️ Bot-ni ishlatish uchun ${unsubscribedChannels.length > 0 ? unsubscribedChannels.length + ' ta' : ''} kanallarga obuna bo'lishingiz kerak:`,
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

    let startMsg = `Salom ${msg.from.first_name} 👋\n\n@uzmoviesuz kanalining rasmiy botiga Xush kelibsiz! 😊\n\n🔑 Kino kodini yuboring yoki 🏆 Top kinolardan tanlang.`;

    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏆 Top kinolar", callback_data: "top_movies_0" }],
        ],
      },
    };
    
    // Agar admin bo'lsa, admin panel tugmasini qo'shish
    if (userId === ADMIN_USER_ID || (await getAdminRole(userId))) {
      options.reply_markup.inline_keyboard.push([
        { text: "🔐 Admin paneli", callback_data: "admin_panel" },
      ]);
    }

    bot.sendMessage(chatId, startMsg, {
      parse_mode: "HTML",
      ...options,
    });
  } else if (msg.text === "/top") {
    // Top kinolar - /start komandasi kabi
    delete userStates[userId];
    
    // Top kinolarni ko'rsatish
    const page = 0;
    const moviesPerPage = 5;
    const totalMovies = await getMoviesCount();
    
    if (totalMovies === 0) {
      bot.sendMessage(chatId, "📭 Hozircha kinolar yo'q!");
      return;
    }
    
    const paginatedMovies = await getTopMovies(moviesPerPage, page * moviesPerPage);
    
    userStates[userId] = {
      status: "viewing_top",
      page: page,
      pageList: paginatedMovies.map((m) => m.code),
    };
    
    let movieList = `🏆 <b>Top kinolar</b>\n\n`;
    paginatedMovies.forEach((movie, idx) => {
      const displayNumber = idx + 1;
      movieList += `${displayNumber}. <b>${movie.name}</b>\nYuklangan ${movie.views || 0}\n\n`;
    });
    movieList += "Ko'rmoqchi bo'lgan kinoni tanlang!";
    
    const buttons = [];
    
    const movieButtons = [];
    for (let i = 1; i <= paginatedMovies.length; i++) {
      movieButtons.push({
        text: `${i}`,
        callback_data: `select_top_movie_${page}_${i - 1}`,
      });
    }
    if (movieButtons.length > 0) {
      buttons.push(movieButtons);
    }
    
    // Navigatsiya tugmalari
    const navButtons = [];
    const startIdx = page * moviesPerPage;
    const endIdx = startIdx + moviesPerPage;
    
    // Orqaga tugmasi
    if (page > 0) {
      navButtons.push({
        text: "⬅️ Orqaga",
        callback_data: `top_movies_${page - 1}`,
      });
    }
    
    // Oldinga tugmasi
    if (endIdx < totalMovies) {
      navButtons.push({
        text: "Oldinga ➡️",
        callback_data: `top_movies_${page + 1}`,
      });
    }
    
    if (navButtons.length > 0) {
      buttons.push(navButtons);
    }
    
    const options = {
      reply_markup: {
        inline_keyboard: buttons.filter((row) => row.length > 0),
      },
    };
    
    bot.sendMessage(chatId, movieList, {
      parse_mode: "HTML",
      ...options,
    });
  } else if (msg.text === "/kod") {
    // Kod bo'yicha qidirish
    delete userStates[userId];
    
    bot.sendMessage(chatId, "🔍 <b>Kino kodini kiriting:</b>\n\nMasalan: ABC123\n\nKino kodini yuboring, kinoni olish uchun!", {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: "🔙 Orqaga", callback_data: "top_movies_0" }
        ]]
      }
    });
    
    userStates[userId] = {
      status: "waiting_code_search",
      return_to: "top_movies_0"
    };
  } else if (msg.text === "/panel") {
    // Admin panel - ID tekshirish
    const adminRole = await getAdminRole(userId);
    const isMainAdmin = String(userId) === String(ADMIN_USER_ID);
    const isHeadAdmin = adminRole === "katta_admin";
    const isSmallAdmin = adminRole === "kichkina_admin";

    if (!isMainAdmin && !isHeadAdmin && !isSmallAdmin) {
      bot.sendMessage(chatId, "❌ Notogri buyruq. Iltimos to'g'ri malumot kiriting!");
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
  } else if (userState && userState.status === "waiting_code_search") {
    // Kod bo'yicha qidirish
    const movieCode = msg.text.toUpperCase().trim();
    const found = await getMovieByCode(movieCode);
    
    if (found) {
      // Views ni oshirish
      await incrementMovieViews(found.code);
      
      const sendMethod = found.file_type === "video" ? "sendVideo" : 
                       found.file_type === "photo" ? "sendPhoto" : "sendDocument";
      
      const currentViews = Number(found.views || 0) + 1;
      const caption = formatMovieCaption(found, currentViews);
      
      const sendOptions = {
        caption: caption,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        protect_content: true,
        disable_notification: false,
      };
      
      if (found.poster_file_id) {
        sendOptions.thumb = found.poster_file_id;
      }
      
      await bot[sendMethod](chatId, found.file_id, sendOptions);
      
      bot.sendMessage(chatId, "✅ Kino topildi! Yana qidirish uchun kod yuboring:");
    } else {
      bot.sendMessage(chatId, `❌ "${movieCode}" kodi bilan kino topilmadi!`, {
        reply_markup: {
          inline_keyboard: [[
            { text: "🔙 Orqaga", callback_data: userState.return_to || "top_movies_0" }
          ]]
        }
      });
    }
    
    delete userStates[userId];
  } else if (msg.text) {
    // Kino raqami yoki kodi orqali qidirish
    // Agar foydalanuvchi kino qo'shish jarayonida bo'lsa, qidirishni qilmasin
    if (userState && (userState.status === "waiting_description" || userState.status === "waiting_code" || userState.status === "upload_preview")) {
      return; // Kino qo'shish jarayonida bo'lsa, qidirishni qilmasin
    }
    
    // Avval obunani tekshiramiz
    const isSubbed = await isSubscribedToAllChannels(userId);
    if (!isSubbed) {
      const unsubscribedChannels = await getUnsubscribedChannels(userId);
      const subButtons = await getSubscriptionButtons(userId);
      
      // Foydalanuvchi yuborgan kodni saqlaymiz
      const input = msg.text.trim();
      userStates[userId] = {
        status: "waiting_subscription_for_movie",
        movieCode: input.toUpperCase()
      };
      
      bot.sendMessage(
        chatId,
        `⚠️ Bot-ni ishlatish uchun ${unsubscribedChannels.length > 0 ? unsubscribedChannels.length + ' ta' : ''} kanallarga obuna bo'lishingiz kerak:\n\n🔍 Siz yuborgan kod: <code>${input.toUpperCase()}</code>\n\nObuna bo'lgandan so'ng ushbu kino avtomatik yuboriladi!`,
        {
          reply_markup: { inline_keyboard: subButtons },
          parse_mode: "HTML",
        },
      );
      return;
    }
    
    const input = msg.text.trim();
    const isNumber = /^\d+$/.test(input);

    let found = null;

    if (isNumber && userState && userState.status === "viewing_top") {
      // Numeric input while viewing top list
      const idx = parseInt(input) - 1;
      const pageList = userState.pageList || [];
      
      // If it's a small number (1-5), treat as button selection
      if (idx >= 0 && idx < pageList.length && idx < 5) {
        const movieCode = pageList[idx];
        found = await getMovieByCode(movieCode);
      } else {
        // If it's a larger number, treat as movie code search
        const movieCode = input.toUpperCase();
        found = await getMovieByCode(movieCode);
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

      // Increment view counter first so we can show updated views in caption
      let viewsToShow = Number(found.views || 0);
      try {
        await incrementMovieViews(found.code);
      } catch (e) {
        console.error("View increment error:", e && e.message ? e.message : e);
        viewsToShow = Number(found.views || 0);
      }

      // Use description if provided; fallback to empty string
      const effectiveDescription = found.description || '';
      const caption = formatMovieCaption(found, viewsToShow);

      const sendOptions = {
        caption: caption,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        protect_content: true,
        disable_notification: false,
        disable_web_page_preview: true,
      };

      // Agar obloshka bo'lsa qo'shish
      if (found.poster_file_id) {
        sendOptions.thumb = found.poster_file_id;
      }

      try {
        if (!found.file_id) {
          throw new Error("Missing file_id");
        }
        await bot[sendMethod](chatId, found.file_id, sendOptions);
      } catch (err) {
        console.error(
          "Send movie error:",
          err && err.message ? err.message : err,
        );
        await bot.sendMessage(
          chatId,
          "❌ Kino yuborishda xato yuz berdi. Iltimos keyinroq urinib ko'ring.",
        );
      }

      // clear viewing_top state to avoid numeric inputs being interpreted
      if (userState && userState.status === "viewing_top") {
        delete userStates[userId];
      }
    } else {
      const errorMsg = `❌ Kod <code>${input}</code> topilmadi!\n\n💡 Iltimos to'g'ri kino kodini yuboring.`;
      bot.sendMessage(chatId, errorMsg, { parse_mode: "HTML" });
    }
  }
  } catch (err) {
    console.error('Message handler error:', err);
    monitor.trackError(err, userId, 'message');
  }
});

// Tugma bosilganligi uchun handler
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const userId = String(query.from.id);
  const userState = userStates[userId];

  try {
    // Track request (soddalashtirilgan)
    monitor.trackRequest(userId, 'callback', 0, true);

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
      const unsubscribedChannels = await getUnsubscribedChannels(userId);
      const subButtons = await getSubscriptionButtons(userId);
      await bot.answerCallbackQuery(query.id, {
        text: "❌ Avval kanallarga obuna bo'ling!",
        show_alert: true,
      });
      await bot.sendMessage(
        chatId,
        `⚠️ Bot-ni ishlatish uchun ${unsubscribedChannels.length > 0 ? unsubscribedChannels.length + ' ta' : ''} kanallarga obuna bo'lishingiz kerak:`,
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
    try {
      await bot.deleteMessage(chatId, query.message.message_id);
    } catch (err) {
      // ignore
    }

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

    await bot.sendMessage(chatId, startMsg, {
      parse_mode: "HTML",
      ...options,
    });
  } else if (query.data === "start_menu") {
    // Bosh menyu - /start komandasi
    delete userStates[userId];

    // Agar admin bo'lsa, admin panelga qaytish
    if (userId === ADMIN_USER_ID || (await getAdminRole(userId))) {
      const options = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔐 Admin paneli", callback_data: "admin_panel" }],
          ],
        },
      };

      bot.editMessageText("🏠 Bosh menu", {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        ...options,
      });
    } else {
      // Oddiy foydalanuvchi uchun start menu
      let startMsg = `Salom ${msg.from.first_name} 👋\n\n@uzmoviesuz kanalining rasmiy botiga Xush kelibsiz! 😊\n\n🔑 Kino kodini yuboring yoki 🏆 Top kinolardan tanlang.`;

      const options = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🏆 Top kinolar", callback_data: "top_movies_0" }],
          ],
        },
      };

      bot.editMessageText(startMsg, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        ...options,
      });
    }
  } else if (query.data === "admin_panel") {
    // Admin panelga qaytish
    const adminRole = await getAdminRole(userId);
    const isMainAdmin = String(userId) === String(ADMIN_USER_ID);
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

    bot.editMessageText("🗑️ <b>Kino o'chirish</b>\n\n🔎 Iltimos o'chirmoqchi bo'lgan kinoning kodini yuboring:", {
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
      const displayNumber = idx + 1; // Always show 1-5 on each page
      movieList += `${displayNumber}. <b>${movie.name}</b>\nYuklangan ${movie.views || 0}\n\n`;
    });
    movieList +=
      "Ko'rmoqchi bo'lgan kinoni tanlang!";

    const buttons = [];

    // Kino tanlash tugmalari (1-5) - birinchi qator
    const movieButtons = [];
    for (let i = 1; i <= paginatedMovies.length; i++) {
      movieButtons.push({
        text: `${i}`,
        callback_data: `select_top_movie_${page}_${i - 1}`,
      });
    }
    if (movieButtons.length > 0) {
      buttons.push(movieButtons);
    }

    // Navigatsiya tugmalari - ikkinchi qator
    const navButtons = [];
    
    // Orqaga tugmasi
    if (page > 0) {
      navButtons.push({
        text: "⬅️ Orqaga",
        callback_data: `top_movies_${page - 1}`,
      });
    }

    // Oldinga tugmasi
    if (endIdx < totalMovies) {
      navButtons.push({
        text: "Oldinga ➡️",
        callback_data: `top_movies_${page + 1}`,
      });
    }
    
    if (navButtons.length > 0) {
      buttons.push(navButtons);
    }

    // Kod bo'yicha qidirish tugmasi - oxirgi qator
    // buttons.push([{
    //   text: "🔍 Kod bo'yicha qidirish",
    //   callback_data: "search_by_code",
    // }]);

    const options = {
      reply_markup: {
        inline_keyboard: buttons.filter((row) => row.length > 0),
      },
    };

    bot.editMessageText(movieList, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: "HTML",
      ...options,
    });
  } else if (query.data.startsWith("select_top_movie_")) {
    // Top kinolardan tanlangan kinoni yuborish
    const parts = query.data.replace("select_top_movie_", "").split("_");
    const page = parseInt(parts[0]) || 0;
    const movieIndex = parseInt(parts[1]) || 0;
    
    const moviesPerPage = 5;
    const paginatedMovies = await getTopMovies(moviesPerPage, page * moviesPerPage);
    
    if (movieIndex >= 0 && movieIndex < paginatedMovies.length) {
      const movie = paginatedMovies[movieIndex];
      
      // Views ni oshirish
      await incrementMovieViews(movie.code);
      
      const sendMethod = movie.file_type === "video" ? "sendVideo" : 
                       movie.file_type === "photo" ? "sendPhoto" : "sendDocument";
      
      // Yangi formatdagi caption
      const currentViews = Number(movie.views || 0) + 1;
      const caption = formatMovieCaption(movie, currentViews);
      
      const sendOptions = {
        caption: caption,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        protect_content: true,
        disable_notification: false,
      };
      
      if (movie.poster_file_id) {
        sendOptions.thumb = movie.poster_file_id;
      }
      
      await bot.answerCallbackQuery(query.id, { text: "🎬 Kino yuborilmoqda..." });
      await bot[sendMethod](chatId, movie.file_id, sendOptions);
    } else {
      await bot.answerCallbackQuery(query.id, { text: "❌ Kino topilmadi!", show_alert: true });
    }
  } else if (query.data === "search_by_code") {
    // Kod bo'yicha qidirish
    bot.editMessageText(
      "🔍 <b>Kino kodini kiriting:</b>\n\nMasalan: ABC123\n\nKino kodini yuboring, kinoni olish uchun!",
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "🔙 Orqaga", callback_data: "top_movies_0" }
          ]]
        }
      }
    );
    
    userStates[userId] = {
      status: "waiting_code_search",
      return_to: "top_movies_0"
    };
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
    const adminRole = await getAdminRole(userId);
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
    
    // Get monitoring stats (faqat 1 soatlik statistika)
    const monitoringStats = monitor.getCurrentStats();
    const healthStatus = monitor.getHealthStatus();

    const statsMsg = `📊 <b>Bot Statistikasi</b>\n\n🎬 <b>Kinolar:</b> ${allMovies.length}\n👥 <b>Foydalanuvchilar:</b> ${allUsers.length}\n🔐 <b>Adminlar:</b> ${allAdmins.length}\n\n<b>📈 Monitoring:</b>\n✅ <b>Muvaffaqiyat foizi:</b> ${monitoringStats.successRate}\n👥 <b>Faol foydalanuvchilar:</b> ${monitoringStats.activeUsers}\n📊 <b>So'rovlar:</b> ${monitoringStats.hourlyRequests}\n📈 <b>24 soatlik so'rovlar:</b> ${monitoringStats.total24HourRequests}\n\n🏥 <b>Sog\'lik holati:</b> ${healthStatus.status}`;

    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 Yangilash", callback_data: "admin_stats" }],
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
      {
        ...options,
        reply_markup: {
          inline_keyboard: [
            ...(options.reply_markup && options.reply_markup.inline_keyboard
              ? options.reply_markup.inline_keyboard
              : []),
            [{ text: "🏠 Bosh menu", callback_data: "start_menu" }],
          ],
        },
      },
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
        u.description, // description ni to'g'ri uzatamiz
        query,
        chatId,
        userId,
        null,
        null,
        null,
        null,
        null,
        true, // skipMainMenu = true, promo question will be shown instead
      );
      bot.answerCallbackQuery(query.id, { text: "✅ Kino kanalga saqlandi!" });

      // Ask if we should share to promo/admin channel
      userStates[userId] = {
        status: "ask_share_promo",
        movieCode,
        description: u.description || "",
      };
      await bot.sendMessage(
        chatId,
        "📢 Yangi kinoni admin kanalga ulashamizmi?",
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Ha", callback_data: "promo_share_yes" },
                { text: "❌ Yo'q", callback_data: "promo_share_no" },
              ],
            ],
          },
        },
      );
    } catch (err) {
      console.error("Save movie error:", err);
      bot.answerCallbackQuery(query.id, {
        text: "❌ Saqlashda xato!",
        show_alert: true,
      });
    }
    // keep state for promo share question if saved
  } else if (query.data === "promo_share_no") {
    if (userState && userState.status === "ask_share_promo") {
      delete userStates[userId];
    }
    await bot.answerCallbackQuery(query.id, { text: "✅ Bekor qilindi" });

    // Orqaga admin panelga qaytish
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

    await bot.sendMessage(
      chatId,
      "🔐 Admin paneli\n\nQuyidagi amallari ishlata olasiz:",
      options,
    );
  } else if (query.data === "promo_share_yes") {
    if (!userState || userState.status !== "ask_share_promo") {
      await bot.answerCallbackQuery(query.id, {
        text: "❌ Sessiya tugagan!",
        show_alert: true,
      });
      return;
    }

    const promo = await getPromoChannel();
    if (!promo || !promo.id) {
      delete userStates[userId];
      await bot.answerCallbackQuery(query.id, {
        text: "❌ Admin kanal sozlanmagan!",
        show_alert: true,
      });
      await bot.sendMessage(
        chatId,
        "❌ Admin kanal sozlanmagan. Admin panel -> Admin boshqaruvi -> Admin kanal bo'limidan sozlang.",
      );
      return;
    }

    userStates[userId] = {
      status: "waiting_promo_trailer",
      movieCode: userState.movieCode,
      description: userState.description,
    };

    await bot.answerCallbackQuery(query.id, { text: "✅ Treyler yuboring" });
    await bot.sendMessage(
      chatId,
      "🎞️ Endi shu kino uchun treyler yuboring (rasm yoki qisqa video):",
    );
  } else if (query.data === "cancel_upload") {
    // Admin cancelled upload preview
    delete userStates[userId];
    bot.answerCallbackQuery(query.id, { text: "❌ Yuklash bekor qilindi" });
    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Admin panel", callback_data: "admin_panel" }],
          [{ text: "🏠 Bosh menu", callback_data: "start_menu" }],
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
            { text: "👤 Admin user", callback_data: "admin_manage_users" },
            { text: "📢 Admin kanal", callback_data: "admin_channel_manage" },
          ],
          [{ text: "🔙 Orqaga", callback_data: "admin_panel" }],
        ],
      },
    };

    bot.editMessageText(
      "👤 <b>Admin boshqaruvi</b>\n\nKerakli bo'limni tanlang:",
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        ...options,
      },
    );
  } else if (query.data === "admin_manage_users") {
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
          [{ text: "🔙 Orqaga", callback_data: "admin_manage" }],
        ],
      },
    };

    const allAdmins = await getAllAdmins();
    let adminList = "👤 <b>Admin User</b>\n\n";
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
  } else if (query.data === "admin_channel_manage") {
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

    const promo = await getPromoChannel();
    const buttons = [];

    if (!promo || !promo.id) {
      buttons.push([
        { text: "➕ Qo'shish", callback_data: "admin_channel_add" },
      ]);
    } else {
      buttons.push([
        { text: "♻️ O'zgartirish", callback_data: "admin_channel_replace" },
      ]);
    }
    buttons.push([{ text: "🔙 Orqaga", callback_data: "admin_manage" }]);

    let msg = "📢 <b>Admin kanal</b>\n\n";
    if (!promo || !promo.id) {
      msg += "❌ Hozircha admin kanal sozlanmagan.";
    } else {
      const title = promo.title || promo.username || promo.id;
      msg += `✅ Hozirgi admin kanal:\n<b>${title}</b>\n🔑 ID: <code>${promo.id}</code>`;
      if (promo.username) msg += `\n🔗 @${promo.username}`;
    }
    msg +=
      "\n\n💡 Bu kanalga kinolar treyleri va izohi reklama sifatida joylanadi.";

    bot.editMessageText(msg, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    });
  } else if (
    query.data === "admin_channel_add" ||
    query.data === "admin_channel_replace"
  ) {
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

    userStates[userId] = { status: "waiting_promo_channel_forward" };
    bot.editMessageText(
      "📢 Admin kanalni sozlash:\n\nQo'shmoqchi bo'lgan kanalingizdan bitta post/xabarni botga <b>FORWARD</b> qiling.",
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 Orqaga", callback_data: "admin_channel_manage" }],
          ],
        },
      },
    );
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
      "👤 <b>Admin turini tanlang:</b>\n\n🔴 <b>Katta Admin</b> - Barcha huquqlar\n🔵 <b>Kichkina Admin</b> - Faqat kino qo'shish",
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
        text: "❌ Notogri buyruq!",
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

    const adminId = query.data.replace("remove_admin_", "");
    const removed = await removeAdmin(adminId);

    if (removed && (removed.changes > 0 || removed.rowCount > 0)) {
      bot.answerCallbackQuery(query.id, {
        text: `✅ Admin (ID: ${adminId}) o'chirildi!`,
      });
      bot.sendMessage(chatId, `✅ Admin (ID: ${adminId}) o'chirildi!`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔐 Admin paneli", callback_data: "admin_panel" }],
          ],
        },
        parse_mode: "HTML",
      });
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
      
      // Foydalanuvchi holatini tekshiramiz
      const userState = userStates[userId];
      
      if (userState && userState.status === "waiting_subscription_for_movie") {
        // Agar foydalanuvchi kino kodini yuborgan bo'lsa va obuna bo'lsa, kinoni yuboramiz
        const movieCode = userState.movieCode;
        console.log(`🔍 Kino kodini qidirish: ${movieCode}`);
        const found = await getMovieByCode(movieCode);
        console.log(`🎬 Kino topildi: ${found ? 'HA' : 'YOQ'}`);
        
        if (found) {
          // Views ni oshirish
          await incrementMovieViews(found.code);
          
          const sendMethod = found.file_type === "video" ? "sendVideo" : 
                           found.file_type === "photo" ? "sendPhoto" : "sendDocument";
          
          const currentViews = Number(found.views || 0) + 1;
          const caption = formatMovieCaption(found, currentViews);
          
          const sendOptions = {
            caption: caption,
            parse_mode: "HTML",
            disable_web_page_preview: true,
            protect_content: true,
            disable_notification: false,
          };
          
          if (found.poster_file_id) {
            sendOptions.thumb = found.poster_file_id;
          }
          
          console.log(`📤 Kino yuborilmoqda: ${found.name}`);
          await bot[sendMethod](chatId, found.file_id, sendOptions);
          console.log(`✅ Kino muvaffaqiyatli yuborildi`);
          
          // Menu tugmalarini yuboramiz
          const menuOptions = {
            reply_markup: {
              inline_keyboard: [
                [{ text: "🏆 Top kinolar", callback_data: "top_movies_0" }],
                [{ text: "🔍 Kod bo'yicha qidirish", callback_data: "search_by_code" }],
              ],
            },
          };
          
          if (userId === ADMIN_USER_ID || (await getAdminRole(userId))) {
            menuOptions.reply_markup.inline_keyboard.push([
              { text: "🔐 Admin paneli", callback_data: "admin_panel" },
            ]);
          }
          
          bot.sendMessage(chatId, "✅ Kino yuborildi! Yana qidirish uchun kod yuboring:", menuOptions);
        } else {
          console.log(`❌ Kino topilmadi: ${movieCode}`);
          bot.sendMessage(chatId, `❌ "${movieCode}" kodi bilan kino topilmadi!`);
        }
        
        // Holatni tozalaymiz
        delete userStates[userId];
      } else {
        // Foydalanuvchi holatini tozalash - endi botdan foydalanishi mumkin
        delete userStates[userId];
        
        // Start komandasi kabi ishlashi kerak
        const startMsg = `Salom ${query.from.first_name} 👋\n\n@uzmoviesuz kanalining rasmiy botiga Xush kelibsiz! 😊\n\n🔑 Kino kodini yuboring yoki 🏆 Top kinolardan tanlang.`;
        const options = {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🏆 Top kinolar", callback_data: "top_movies_0" }],
            ],
          },
        };
        
        // Admin panel tugmasini qo'shamiz
        if (userId === ADMIN_USER_ID || (await getAdminRole(userId))) {
          options.reply_markup.inline_keyboard.push([
            { text: "🔐 Admin paneli", callback_data: "admin_panel" },
          ]);
        }
        
        // Xabarni yangilaymiz
        bot.editMessageText(startMsg, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: "HTML",
          ...options,
        });
      }
    } else {
      const unsubscribedChannels = await getUnsubscribedChannels(userId);
      const subButtons = await getSubscriptionButtons(userId);
      
      bot.answerCallbackQuery(query.id, {
        text: `❌ Siz ${unsubscribedChannels.length} ta kanallarga obuna bo'lmagansiz!`,
      });
      
      // Xabarni o'zgartirish, yangi xabar yuborish o'rniga
      bot.editMessageText(
        `⚠️ Bot-ni ishlatish uchun ${unsubscribedChannels.length} ta kanallarga obuna bo'lishingiz kerak:`,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: subButtons },
        }
      );
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
    // buttons.push([{ text: "🏠 Bosh menu", callback_data: "start_menu" }]);

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
  } catch (err) {
    console.error('Callback query error:', err);
    monitor.trackError(err, userId, 'callback');
  }
});
