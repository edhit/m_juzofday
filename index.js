require("dotenv").config();

const { Telegraf, Markup, session } = require("telegraf");
const { Sequelize, DataTypes, Op } = require("sequelize");
const moment = require("moment");

// Инициализация базы данных
const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: "quran_bot.sqlite",
  logging: false,
});

// Модель пользователя
const User = sequelize.define("User", {
  telegramId: {
    type: DataTypes.BIGINT,
    primaryKey: true,
    allowNull: false,
  },
  firstName: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  lastName: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  username: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  lastMemorizedPage: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  lastJuzUsed: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  extraJuzList: {
    type: DataTypes.TEXT,
    defaultValue: "[]",
  },
  juzPerDay: {
    type: DataTypes.INTEGER,
    defaultValue: 1,
  },
  dailyPlanMessageId: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
});

// Модель статистики
const DailyStat = sequelize.define("DailyStat", {
  date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  pagesMemorized: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  baseJuzCount: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  dailyProgress: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  totalJuzCount: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  juzPerDay: {
    type: DataTypes.INTEGER,
    defaultValue: 1,
  },
  pagesRepeated: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
});

// Связи
User.hasMany(DailyStat, { foreignKey: "userId" });
DailyStat.belongsTo(User, { foreignKey: "userId" });

// Константы
const TOTAL_PAGES = 604;
const PAGES_IN_JUZ = 20;

// Главная клавиатура с кнопкой "+1 страница"
const mainKeyboard = Markup.keyboard([
  ["📅 План на сегодня", "📊 Статистика"],
  ["➕ Добавить страницу", "⚙️ Настройки"],
  ["📝 Доп. джузы", "🎯 Джузов в день"],
]).resize();

// Клавиатура настроек
const settingsKeyboard = Markup.keyboard([
  ["🔄 Обновить страницы", "📝 Доп. джузы"],
  ["🎯 Джузов в день", "📋 Экспорт статистики"],
  ["🏠 Главное меню"],
]).resize();

// Клавиатура для выбора количества джузов
const juzPerDayKeyboard = Markup.keyboard([
  ["1 джуз", "2 джуза", "3 джуза"],
  ["4 джуза", "5 джузов"],
  ["🏠 Главное меню"],
]).resize();

// Функция для получения начальной и конечной страницы джуза
function getJuzPageRange(juzNumber, lastMemorizedPage, isExtra = false) {
  let startPage, endPage;

  if (juzNumber === 1) {
    // В первом джузе начинаем со 2-й страницы (пропускаем Фатиху)
    startPage = 2;
    if (isExtra) {
      // Для дополнительного джуза берем полный джуз
      endPage = 20;
    } else {
      // Для базового джуза только выученные страницы
      endPage = Math.min(20, lastMemorizedPage);
    }
  } else if (juzNumber === 30) {
    // В 30-м джузе читаем до конца (604 страницы)
    startPage = (juzNumber - 1) * PAGES_IN_JUZ + 1;
    endPage = TOTAL_PAGES;

    if (!isExtra && lastMemorizedPage < TOTAL_PAGES) {
      endPage = Math.min(TOTAL_PAGES, lastMemorizedPage);
    }
  } else {
    // Остальные джузы
    startPage = (juzNumber - 1) * PAGES_IN_JUZ + 1;
    endPage = juzNumber * PAGES_IN_JUZ;

    if (!isExtra) {
      endPage = Math.min(endPage, lastMemorizedPage);
    }
  }

  return { startPage, endPage };
}

// Функция для проверки, полностью ли выучен джуз
function isJuzFullyMemorized(juzNumber, lastMemorizedPage, isExtra = false) {
  if (isExtra) return true; // Дополнительные джузы всегда считаются полностью выученными

  if (juzNumber === 1) {
    return lastMemorizedPage >= 20; // Первый джуз выучен, если достигли 20 стр
  } else if (juzNumber === 30) {
    return lastMemorizedPage >= TOTAL_PAGES; // 30-й джуз выучен, если достигли конца
  } else {
    return lastMemorizedPage >= juzNumber * PAGES_IN_JUZ;
  }
}

// Функции для работы с джузами
function getExtraJuzList(extraJuzString) {
  if (!extraJuzString || extraJuzString === "[]") return [];
  try {
    return JSON.parse(extraJuzString);
  } catch {
    return [];
  }
}

function getJuzForToday(
  lastJuzUsed,
  lastMemorizedPage,
  extraJuzList,
  juzPerDay = 1
) {
  try {
    const todayJuzList = [];
    let currentJuz = lastJuzUsed;
    let currentIsExtra = extraJuzList.includes(currentJuz);

    // Получаем следующий джуз
    let nextJuzInfo = getNextJuz(
      currentJuz,
      currentIsExtra,
      lastMemorizedPage,
      extraJuzList
    );

    for (let i = 0; i < juzPerDay && nextJuzInfo; i++) {
      todayJuzList.push(nextJuzInfo);

      // Получаем следующий джуз
      nextJuzInfo = getNextJuz(
        nextJuzInfo.number,
        nextJuzInfo.isExtra,
        lastMemorizedPage,
        extraJuzList
      );
    }

    return todayJuzList;
  } catch (error) {
    console.error("Ошибка в getJuzForToday:", error);
    return [];
  }
}

function getNextJuz(
  currentJuz,
  currentIsExtra,
  lastMemorizedPage,
  extraJuzList
) {
  try {
    const baseJuzCount = calculateBaseJuzCount(lastMemorizedPage);

    if (currentIsExtra) {
      // Если текущий джуз дополнительный
      const currentIndex = extraJuzList.indexOf(currentJuz);
      if (currentIndex < extraJuzList.length - 1) {
        // Есть следующий дополнительный
        return { number: extraJuzList[currentIndex + 1], isExtra: true };
      } else {
        // Дополнительные закончились, переходим к базовым
        if (baseJuzCount > 0) {
          return { number: 1, isExtra: false };
        } else if (extraJuzList.length > 0) {
          // Если нет базовых, начинаем дополнительные сначала
          return { number: extraJuzList[0], isExtra: true };
        } else {
          return null; // Нет джузов вообще
        }
      }
    } else {
      // Если текущий джуз базовый
      if (currentJuz >= baseJuzCount) {
        // Базовые закончились, переходим к дополнительным
        if (extraJuzList.length > 0) {
          return { number: extraJuzList[0], isExtra: true };
        } else {
          // Нет дополнительных, начинаем базовые сначала
          return baseJuzCount > 0 ? { number: 1, isExtra: false } : null;
        }
      } else {
        // Продолжаем базовые
        return { number: currentJuz + 1, isExtra: false };
      }
    }
  } catch (error) {
    console.error("Ошибка в getNextJuz:", error);
    return null;
  }
}

// Функция для расчета количества выученных базовых джузов
function calculateBaseJuzCount(lastMemorizedPage) {
  if (lastMemorizedPage === 0) return 0;

  if (lastMemorizedPage >= TOTAL_PAGES) {
    // Выучен весь Коран - 30 джузов
    return 30;
  }

  if (lastMemorizedPage <= 20) {
    // Первый джуз (со 2-й страницы)
    return lastMemorizedPage >= 20 ? 1 : 0;
  }

  // Для остальных случаев
  return Math.floor((lastMemorizedPage - 1) / PAGES_IN_JUZ);
}

async function sendDailyQuranPlan(ctx) {
  try {
    const user = await getUser(ctx.from.id);

    const lastMemorizedPage = user.lastMemorizedPage;
    const lastJuzUsed = user.lastJuzUsed || 0;
    const extraJuzList = getExtraJuzList(user.extraJuzList);
    const juzPerDay = user.juzPerDay || 1;

    // Записываем статистику
    await recordDailyStats(user, lastMemorizedPage, extraJuzList, juzPerDay);

    // Вычисляем джузы
    const baseJuzCount = calculateBaseJuzCount(lastMemorizedPage);
    const totalKnownJuz = baseJuzCount + extraJuzList.length;

    // Получаем джузы на сегодня
    const todayJuzList = getJuzForToday(
      lastJuzUsed,
      lastMemorizedPage,
      extraJuzList,
      juzPerDay
    );

    // Если нет джузов для повторения
    if (todayJuzList.length === 0) {
      const message = `
📅 План на сегодня

🎯 Нет джузов для повторения.

📊 Ваш прогресс:
• Выучено страниц: ${lastMemorizedPage}/${TOTAL_PAGES}
• Всего джузов: ${totalKnownJuz}/30

Используйте кнопку "➕ Добавить страницу" или обновите настройки.
      `;

      const sentMessage = await ctx.reply(message, mainKeyboard);
      user.dailyPlanMessageId = sentMessage.message_id;
      await user.save();
      return;
    }

    // Собираем все страницы
    let allPages = [];
    todayJuzList.forEach((juzInfo) => {
      const { startPage, endPage } = getJuzPageRange(
        juzInfo.number,
        lastMemorizedPage,
        juzInfo.isExtra
      );

      // Добавляем только если есть страницы
      if (startPage <= endPage) {
        for (let page = startPage; page <= endPage; page++) {
          allPages.push({
            page: page,
            juz: juzInfo.number,
            isExtra: juzInfo.isExtra,
          });
        }
      }
    });

    // Ограничиваем количество страниц (20 страниц на джуз)
    const PAGES_PER_DAY = PAGES_IN_JUZ * juzPerDay;
    allPages = allPages.slice(0, PAGES_PER_DAY);

    // Если нет страниц для повторения
    if (allPages.length === 0) {
      const message = `
📅 План на сегодня

🎯 Нет страниц для повторения.

📊 Ваш прогресс:
• Выучено страниц: ${lastMemorizedPage}/${TOTAL_PAGES}
• Всего джузов: ${totalKnownJuz}/30

Продолжайте учить новые страницы!
      `;

      const sentMessage = await ctx.reply(message, mainKeyboard);
      user.dailyPlanMessageId = sentMessage.message_id;
      await user.save();
      return;
    }

    // Распределяем по намазам
    const namazPlan = [];
    const pagesPerNamaz = Math.ceil(allPages.length / 5);

    for (let i = 0; i < 5; i++) {
      const startIndex = i * pagesPerNamaz;
      const endIndex = Math.min(startIndex + pagesPerNamaz, allPages.length);

      if (startIndex < allPages.length) {
        const namazPages = allPages.slice(startIndex, endIndex);
        const fromPage = namazPages[0].page;
        const toPage = namazPages[namazPages.length - 1].page;

        namazPlan.push({
          name: ["Фаджр", "Зухр", "Аср", "Магриб", "Иша"][i],
          from: fromPage,
          to: toPage,
        });
      }
    }

    // Формируем номера джузов
    const juzNumbers = todayJuzList
      .map((juz) => {
        if (juz.isExtra) {
          return `${juz.number} (доп.)`;
        }

        // Проверяем, полностью ли выучен базовый джуз
        const isFullyMemorized = isJuzFullyMemorized(
          juz.number,
          lastMemorizedPage,
          false
        );
        return isFullyMemorized ? `${juz.number}` : `${juz.number} (частично)`;
      })
      .join(", ");

    // УПРОЩЕННОЕ сообщение плана
    const message = `📅 План на сегодня

🎯 Джузы: ${juzNumbers}
📄 Страниц: ${allPages.length}

${namazPlan
  .map((item) => `${item.name}: стр. ${item.from}–${item.to}`)
  .join("\n")}

📊 Прогресс: ${lastMemorizedPage}/${TOTAL_PAGES} стр.
🎯 Джузов: ${totalKnownJuz}/30`;

    // Отправляем и закрепляем сообщение
    try {
      // Открепляем предыдущее сообщение
      if (user.dailyPlanMessageId) {
        try {
          await ctx.unpinChatMessage(user.dailyPlanMessageId);
        } catch (error) {
          // Игнорируем ошибку, если сообщение уже не закреплено
        }
      }

      // Отправляем новое сообщение
      const sentMessage = await ctx.reply(message, mainKeyboard);

      // Закрепляем новое сообщение
      try {
        await ctx.pinChatMessage(sentMessage.message_id);
      } catch (error) {
        console.log("Не удалось закрепить сообщение:", error.message);
      }

      // Обновляем данные пользователя
      if (todayJuzList.length > 0) {
        user.lastJuzUsed = todayJuzList[todayJuzList.length - 1].number;
      }
      user.dailyPlanMessageId = sentMessage.message_id;
      await user.save();
    } catch (error) {
      console.error("Ошибка отправки плана:", error);
      await ctx.reply(
        "⚠️ Произошла ошибка при отправке плана. Попробуйте снова.",
        mainKeyboard
      );
    }
  } catch (error) {
    console.error("Критическая ошибка в sendDailyQuranPlan:", error);
    await ctx.reply(
      "❌ Произошла критическая ошибка. Пожалуйста, попробуйте позже.",
      mainKeyboard
    );
  }
}

// Статистические функции
async function recordDailyStats(
  user,
  lastMemorizedPage,
  extraJuzList,
  juzPerDay = 1
) {
  try {
    const today = moment().format("YYYY-MM-DD");
    const baseJuzCount = calculateBaseJuzCount(lastMemorizedPage);
    const totalJuzCount = baseJuzCount + extraJuzList.length;

    // Получаем вчерашнюю статистику
    const yesterday = moment().subtract(1, "day").format("YYYY-MM-DD");
    const yesterdayStat = await DailyStat.findOne({
      where: {
        userId: user.telegramId,
        date: yesterday,
      },
    });

    const previousPages = yesterdayStat ? yesterdayStat.pagesMemorized : 0;
    const progressToday = lastMemorizedPage - previousPages;
    const pagesRepeatedToday = PAGES_IN_JUZ * juzPerDay;

    // Создаем или обновляем запись за сегодня
    await DailyStat.upsert({
      userId: user.telegramId,
      date: today,
      pagesMemorized: lastMemorizedPage,
      baseJuzCount: baseJuzCount,
      dailyProgress: progressToday,
      totalJuzCount: totalJuzCount,
      juzPerDay: juzPerDay,
      pagesRepeated: pagesRepeatedToday,
    });
  } catch (error) {
    console.error("Ошибка в recordDailyStats:", error);
  }
}

async function getStatsSummary(user) {
  try {
    const weekAgo = moment().subtract(7, "days").format("YYYY-MM-DD");

    const stats = await DailyStat.findAll({
      where: {
        userId: user.telegramId,
        date: { [Op.gte]: weekAgo },
      },
      order: [["date", "ASC"]],
    });

    if (stats.length === 0) {
      return "📈 Сегодня первый день отслеживания!";
    }

    let summary = "";

    // Прогресс за неделю
    const weekProgress = stats.reduce(
      (sum, stat) => sum + (stat.dailyProgress || 0),
      0
    );
    const weekRepeated = stats.reduce(
      (sum, stat) => sum + (stat.pagesRepeated || 0),
      0
    );

    summary += `📅 За неделю:\n`;
    summary += `• Новых: +${weekProgress} стр.\n`;
    summary += `• Повторено: ${weekRepeated} стр.`;

    return summary;
  } catch (error) {
    console.error("Ошибка в getStatsSummary:", error);
    return "Не удалось загрузить статистику";
  }
}

// Вспомогательные функции
async function getUser(telegramId) {
  try {
    let user = await User.findByPk(telegramId);

    if (!user) {
      user = await User.create({
        telegramId: telegramId,
        lastMemorizedPage: 0,
        lastJuzUsed: 0,
        extraJuzList: "[]",
        juzPerDay: 1,
      });
    }

    return user;
  } catch (error) {
    console.error("Ошибка в getUser:", error);
    throw error;
  }
}

// Функция для получения информации о текущем прогрессе в джузе
function getCurrentJuzProgress(lastMemorizedPage) {
  if (lastMemorizedPage === 0) {
    return { juzNumber: 1, pagesInJuz: 0, totalPagesInJuz: 19 }; // 19 потому что 1-я страница пропускается
  }

  if (lastMemorizedPage >= TOTAL_PAGES) {
    return { juzNumber: 30, pagesInJuz: 14, totalPagesInJuz: 14 }; // В 30-м джузе 14 страниц (591-604)
  }

  let juzNumber, pagesInJuz, totalPagesInJuz;

  if (lastMemorizedPage <= 20) {
    // Первый джуз
    juzNumber = 1;
    pagesInJuz = Math.max(0, lastMemorizedPage - 1); // Минус первая страница
    totalPagesInJuz = 19;
  } else {
    // Остальные джузы
    juzNumber = Math.floor((lastMemorizedPage - 1) / PAGES_IN_JUZ);

    if (juzNumber === 30) {
      // 30-й джуз
      const startPage30 = 29 * PAGES_IN_JUZ + 1; // 581
      pagesInJuz = lastMemorizedPage - startPage30 + 1;
      totalPagesInJuz = TOTAL_PAGES - startPage30 + 1; // 24 страницы (581-604)
    } else {
      const startPage = (juzNumber - 1) * PAGES_IN_JUZ + 1;
      pagesInJuz = lastMemorizedPage - startPage + 1;
      totalPagesInJuz = PAGES_IN_JUZ;
    }
  }

  return { juzNumber, pagesInJuz, totalPagesInJuz };
}

// Инициализация бота
const bot = new Telegraf(process.env.BOT_TOKEN);

// Middleware для пользователя с try-catch
bot.use(async (ctx, next) => {
  try {
    if (ctx.from) {
      ctx.user = await getUser(ctx.from.id);
    }
    await next();
  } catch (error) {
    console.error("Ошибка в middleware:", error);
    await ctx.reply(
      "❌ Произошла ошибка. Пожалуйста, перезапустите бота командой /start"
    );
  }
});

// Команда /start
bot.start(async (ctx) => {
  try {
    const welcomeMessage = `
👋 Привет, ${ctx.from.first_name}!

Я помогу вам планировать повторение Корана.

📚 Особенности:
• Учитываю, что 1-я страница (Фатиха) пропускается
• В 30-м джузе читаем до 604 страницы
• Создаю ежедневный план повторения
• Веду статистику прогресса

🎯 Начните с кнопки "➕ Добавить страницу"!

Выберите действие на клавиатуре ниже 👇
    `;

    await ctx.reply(welcomeMessage, mainKeyboard);
  } catch (error) {
    console.error("Ошибка в команде /start:", error);
  }
});

// Обработка текстовых сообщений (кнопок)
bot.on("text", async (ctx) => {
  try {
    const text = ctx.message.text;

    switch (text) {
      case "📅 План на сегодня":
        await sendDailyQuranPlan(ctx);
        break;

      case "📊 Статистика":
        await showStatistics(ctx);
        break;

      case "➕ Добавить страницу":
        await addOnePage(ctx);
        break;

      case "⚙️ Настройки":
        await showSettings(ctx);
        break;

      case "🔄 Обновить страницы":
        await askForPagesUpdate(ctx);
        break;

      case "📝 Доп. джузы":
        await askForExtraJuz(ctx);
        break;

      case "🎯 Джузов в день":
        await askForJuzPerDay(ctx);
        break;

      case "📋 Экспорт статистики":
        await exportStatistics(ctx);
        break;

      case "🏠 Главное меню":
        await ctx.reply("Главное меню:", mainKeyboard);
        break;

      // Обработка выбора количества джузов
      case "1 джуз":
      case "2 джуза":
      case "3 джуза":
      case "4 джуза":
      case "5 джузов":
        await setJuzPerDay(ctx, text);
        break;

      default:
        // Проверяем, является ли сообщение числом (обновление страниц)
        if (/^\d+$/.test(text)) {
          await updatePages(ctx, parseInt(text));
        }
        // Проверяем, является ли сообщение списком джузов
        else if (/^[\d\s,]+$/.test(text)) {
          await updateExtraJuz(ctx, text);
        } else {
          await ctx.reply(
            "Используйте кнопки меню для навигации.",
            mainKeyboard
          );
        }
    }
  } catch (error) {
    console.error("Ошибка обработки текста:", error);
    await ctx.reply("❌ Произошла ошибка. Попробуйте снова.", mainKeyboard);
  }
});

// Функция добавления одной страницы
async function addOnePage(ctx) {
  try {
    const user = ctx.user;
    const currentPage = user.lastMemorizedPage;

    // Проверяем, не достигли ли мы конца Корана
    if (currentPage >= TOTAL_PAGES) {
      await ctx.reply(
        `🎉 Поздравляем! Вы выучили весь Коран - все ${TOTAL_PAGES} страниц!`,
        mainKeyboard
      );
      return;
    }

    const newPageCount = currentPage + 1;
    user.lastMemorizedPage = newPageCount;
    await user.save();

    // Записываем статистику
    await recordDailyStats(
      user,
      newPageCount,
      getExtraJuzList(user.extraJuzList),
      user.juzPerDay
    );

    // Получаем информацию о текущем прогрессе в джузе
    const { juzNumber, pagesInJuz, totalPagesInJuz } =
      getCurrentJuzProgress(newPageCount);

    const baseJuzCount = calculateBaseJuzCount(newPageCount);
    const totalJuzCount =
      baseJuzCount + getExtraJuzList(user.extraJuzList).length;

    let message = "";

    if (juzNumber === 30 && pagesInJuz === totalPagesInJuz) {
      message = `🎉 МАШААЛЛАХ! Вы завершили 30-й джуз и весь Коран!\n\n`;
    } else if (pagesInJuz === totalPagesInJuz) {
      message = `🎉 МАШААЛЛАХ! Вы завершили джуз ${juzNumber}!\n\n`;
    }

    message += `✅ Добавлена 1 страница

📊 Ваш прогресс:
• Страниц: ${newPageCount}/${TOTAL_PAGES}
• Джузов: ${totalJuzCount}/30

🎯 Джуз ${juzNumber}: ${pagesInJuz}/${totalPagesInJuz} стр.`;

    // Добавляем информацию о следующем джузе
    if (pagesInJuz === totalPagesInJuz && juzNumber < 30) {
      const nextJuz = juzNumber + 1;
      if (nextJuz === 1) {
        message += `\n\n📖 Следующий: джуз 1 (со 2-й страницы)`;
      } else if (nextJuz === 30) {
        message += `\n\n📖 Следующий: джуз 30 (до 604 стр.)`;
      } else {
        message += `\n\n📖 Следующий: джуз ${nextJuz}`;
      }
    }

    message += `\n\n📅 Используйте "План на сегодня" для обновления плана повторения`;

    await ctx.reply(message, mainKeyboard);
  } catch (error) {
    console.error("Ошибка в addOnePage:", error);
    await ctx.reply(
      "❌ Не удалось добавить страницу. Попробуйте снова.",
      mainKeyboard
    );
  }
}

// Функция показа статистики
async function showStatistics(ctx) {
  try {
    const user = ctx.user;
    const extraJuzList = getExtraJuzList(user.extraJuzList);
    const baseJuzCount = calculateBaseJuzCount(user.lastMemorizedPage);
    const totalJuzCount = baseJuzCount + extraJuzList.length;

    // Получаем прогресс в текущем джузе
    const { juzNumber, pagesInJuz, totalPagesInJuz } = getCurrentJuzProgress(
      user.lastMemorizedPage
    );

    const stats = await getStatsSummary(user);

    const message = `
📊 Ваша статистика

📈 Прогресс:
• Страниц: ${user.lastMemorizedPage}/${TOTAL_PAGES}
• Базовых джузов: ${baseJuzCount}
• Доп. джузов: ${extraJuzList.length}
• Всего джузов: ${totalJuzCount}/30
• Джузов в день: ${user.juzPerDay}

🎯 Текущий джуз ${juzNumber}: ${pagesInJuz}/${totalPagesInJuz} стр.

${stats}
    `;

    await ctx.reply(message, mainKeyboard);
  } catch (error) {
    console.error("Ошибка в showStatistics:", error);
    await ctx.reply("❌ Не удалось загрузить статистику.", mainKeyboard);
  }
}

// Функция показа настроек
async function showSettings(ctx) {
  try {
    const user = ctx.user;
    const extraJuzList = getExtraJuzList(user.extraJuzList);

    // Получаем прогресс в текущем джузе
    const { juzNumber, pagesInJuz, totalPagesInJuz } = getCurrentJuzProgress(
      user.lastMemorizedPage
    );

    const message = `
⚙️ Настройки

📄 Выучено: ${user.lastMemorizedPage} стр.
🎯 Джузов в день: ${user.juzPerDay}
📚 Доп. джузы: ${extraJuzList.length > 0 ? extraJuzList.join(", ") : "нет"}

🎯 Текущий джуз ${juzNumber}: ${pagesInJuz}/${totalPagesInJuz} стр.

Выберите параметр для изменения:
    `;

    await ctx.reply(message, settingsKeyboard);
  } catch (error) {
    console.error("Ошибка в showSettings:", error);
    await ctx.reply("❌ Не удалось загрузить настройки.", mainKeyboard);
  }
}

// Функция запроса обновления страниц
async function askForPagesUpdate(ctx) {
  try {
    const user = ctx.user;
    await ctx.reply(
      `Введите количество выученных страниц (от 1 до ${TOTAL_PAGES}):\n\nТекущее: ${user.lastMemorizedPage} стр.`,
      Markup.removeKeyboard()
    );
  } catch (error) {
    console.error("Ошибка в askForPagesUpdate:", error);
    await ctx.reply("❌ Произошла ошибка.", mainKeyboard);
  }
}

// Функция обновления страниц
async function updatePages(ctx, pages) {
  try {
    if (isNaN(pages) || pages < 0 || pages > TOTAL_PAGES) {
      await ctx.reply(`Введите число от 0 до ${TOTAL_PAGES}`, mainKeyboard);
      return;
    }

    ctx.user.lastMemorizedPage = pages;
    await ctx.user.save();

    // Записываем статистику
    await recordDailyStats(
      ctx.user,
      pages,
      getExtraJuzList(ctx.user.extraJuzList),
      ctx.user.juzPerDay
    );

    await ctx.reply(`✅ Установлено ${pages} выученных страниц`, mainKeyboard);
  } catch (error) {
    console.error("Ошибка в updatePages:", error);
    await ctx.reply("❌ Не удалось обновить страницы.", mainKeyboard);
  }
}

// Функция запроса дополнительных джузов
async function askForExtraJuz(ctx) {
  try {
    const user = ctx.user;
    const extraJuzList = getExtraJuzList(user.extraJuzList);

    let message = `Введите номера дополнительных джузов через запятую (1-30):`;

    if (extraJuzList.length > 0) {
      message += `\n\nТекущие доп. джузы: ${extraJuzList.join(", ")}`;
    }

    message += `\n\nПример: 5, 10, 15\nОставьте пустым, чтобы удалить все`;

    await ctx.reply(message, Markup.removeKeyboard());
  } catch (error) {
    console.error("Ошибка в askForExtraJuz:", error);
    await ctx.reply("❌ Произошла ошибка.", mainKeyboard);
  }
}

// Функция обновления дополнительных джузов
async function updateExtraJuz(ctx, text) {
  try {
    if (text.trim() === "") {
      // Если пустая строка, удаляем все дополнительные джузы
      ctx.user.extraJuzList = "[]";
      await ctx.user.save();
      await ctx.reply("✅ Все дополнительные джузы удалены", mainKeyboard);
      return;
    }

    const juzArray = text
      .split(",")
      .map((item) => parseInt(item.trim()))
      .filter((juz) => !isNaN(juz) && juz >= 1 && juz <= 30);

    const uniqueJuz = [...new Set(juzArray)].sort((a, b) => a - b);

    ctx.user.extraJuzList = JSON.stringify(uniqueJuz);
    await ctx.user.save();

    await ctx.reply(
      `✅ Установлены дополнительные джузы: ${
        uniqueJuz.length > 0 ? uniqueJuz.join(", ") : "нет"
      }`,
      mainKeyboard
    );
  } catch (error) {
    console.error("Ошибка в updateExtraJuz:", error);
    await ctx.reply("❌ Не удалось обновить джузы.", mainKeyboard);
  }
}

// Функция запроса количества джузов в день
async function askForJuzPerDay(ctx) {
  try {
    await ctx.reply(
      "Сколько джузов вы хотите повторять в день?\n\nРекомендуется: 1-2 джуза",
      juzPerDayKeyboard
    );
  } catch (error) {
    console.error("Ошибка в askForJuzPerDay:", error);
    await ctx.reply("❌ Произошла ошибка.", mainKeyboard);
  }
}

// Функция установки количества джузов в день
async function setJuzPerDay(ctx, text) {
  try {
    const juzPerDay = parseInt(text.charAt(0));

    if (!isNaN(juzPerDay) && juzPerDay >= 1 && juzPerDay <= 5) {
      ctx.user.juzPerDay = juzPerDay;
      await ctx.user.save();

      await ctx.reply(
        `✅ Установлено ${juzPerDay} джуз${
          juzPerDay === 1 ? "" : "а"
        } в день\n\nТеперь будете повторять примерно ${
          juzPerDay * PAGES_IN_JUZ
        } страниц в день.`,
        mainKeyboard
      );
    } else {
      await ctx.reply(
        "❌ Пожалуйста, используйте кнопки для выбора.",
        mainKeyboard
      );
    }
  } catch (error) {
    console.error("Ошибка в setJuzPerDay:", error);
    await ctx.reply(
      "❌ Не удалось установить количество джузов.",
      mainKeyboard
    );
  }
}

// Функция экспорта статистики
async function exportStatistics(ctx) {
  try {
    const stats = await DailyStat.findAll({
      where: { userId: ctx.user.telegramId },
      order: [["date", "ASC"]],
    });

    if (stats.length === 0) {
      await ctx.reply(
        "❌ У вас пока нет статистики для экспорта",
        mainKeyboard
      );
      return;
    }

    // Создаем CSV
    let csv =
      "Дата,Выучено страниц,Базовых джузов,Прогресс за день,Всего джузов,Джузов в день,Повторено страниц\n";

    stats.forEach((stat) => {
      csv += `${moment(stat.date).format("DD.MM.YYYY")},${
        stat.pagesMemorized
      },${stat.baseJuzCount},${stat.dailyProgress},${stat.totalJuzCount},${
        stat.juzPerDay
      },${stat.pagesRepeated}\n`;
    });

    // Отправляем как файл
    await ctx.replyWithDocument(
      {
        source: Buffer.from(csv, "utf8"),
        filename: `quran_stats_${moment().format("YYYY-MM-DD")}.csv`,
      },
      mainKeyboard
    );

    await ctx.reply("✅ Статистика экспортирована", mainKeyboard);
  } catch (error) {
    console.error("Ошибка в exportStatistics:", error);
    await ctx.reply("❌ Не удалось экспортировать статистику.", mainKeyboard);
  }
}

// Автоматическая отправка напоминаний
const cron = require("node-cron");

// Запускаем каждый день в 8:00 утра
cron.schedule("0 8 * * *", async () => {
  try {
    console.log("Запуск ежедневного напоминания...");

    const users = await User.findAll();
    console.log(`Найдено пользователей: ${users.length}`);

    for (const user of users) {
      try {
        const botInstance = new Telegraf(process.env.BOT_TOKEN);

        await botInstance.telegram.sendMessage(
          user.telegramId,
          '⏰ Время для повторения Корана!\n\nНажмите "📅 План на сегодня" для получения вашего плана.',
          mainKeyboard
        );

        botInstance.stop();

        // Небольшая задержка между отправками
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        console.error(
          `Ошибка отправки пользователю ${user.telegramId}:`,
          error.message
        );
      }
    }

    console.log("Ежедневное напоминание отправлено");
  } catch (error) {
    console.error("Критическая ошибка в cron задаче:", error);
  }
});

// Обработка ошибок бота
bot.catch(async (err, ctx) => {
  console.error("Глобальная ошибка бота:", err);

  try {
    if (ctx && ctx.reply) {
      await ctx.reply(
        "❌ Произошла непредвиденная ошибка. Попробуйте перезапустить бота командой /start"
      );
    }
  } catch (replyError) {
    console.error("Не удалось отправить сообщение об ошибке:", replyError);
  }
});

// Запуск бота
async function startBot() {
  try {
    // Синхронизация с базой данных
    await sequelize.sync({ alter: true });
    console.log("✅ База данных подключена");

    // Запуск бота
    await bot.launch();
    console.log("✅ Бот запущен");

    // Обработка завершения
    process.once("SIGINT", () => {
      console.log("Завершение работы...");
      bot.stop("SIGINT");
    });

    process.once("SIGTERM", () => {
      console.log("Завершение работы...");
      bot.stop("SIGTERM");
    });
  } catch (error) {
    console.error("❌ Ошибка запуска:", error);
    process.exit(1);
  }
}

startBot();
