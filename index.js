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

// Модель пользователя с добавлением поля для отслеживания даты последнего плана
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
  lastPlanDate: {
    type: DataTypes.DATEONLY,
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

// Клавиатура для работы с дополнительными джузами
const extraJuzKeyboard = Markup.keyboard([
  ["➕ Добавить джузы", "🗑️ Удалить джузы"],
  ["📋 Список джузов", "❌ Очистить все"],
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
    startPage = 2;
    if (isExtra) {
      endPage = 20;
    } else {
      endPage = Math.min(20, lastMemorizedPage);
    }
  } else if (juzNumber === 30) {
    startPage = (juzNumber - 1) * PAGES_IN_JUZ + 1;
    endPage = TOTAL_PAGES;

    if (!isExtra && lastMemorizedPage < TOTAL_PAGES) {
      endPage = Math.min(TOTAL_PAGES, lastMemorizedPage);
    }
  } else {
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
  if (isExtra) return true;

  if (juzNumber === 1) {
    return lastMemorizedPage >= 20;
  } else if (juzNumber === 30) {
    return lastMemorizedPage >= TOTAL_PAGES;
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

function saveExtraJuzList(extraJuzList) {
  return JSON.stringify([...new Set(extraJuzList)].sort((a, b) => a - b));
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

    let nextJuzInfo = getNextJuz(
      currentJuz,
      currentIsExtra,
      lastMemorizedPage,
      extraJuzList
    );

    for (let i = 0; i < juzPerDay && nextJuzInfo; i++) {
      todayJuzList.push(nextJuzInfo);

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
      const currentIndex = extraJuzList.indexOf(currentJuz);
      if (currentIndex < extraJuzList.length - 1) {
        return { number: extraJuzList[currentIndex + 1], isExtra: true };
      } else {
        if (baseJuzCount > 0) {
          return { number: 1, isExtra: false };
        } else if (extraJuzList.length > 0) {
          return { number: extraJuzList[0], isExtra: true };
        } else {
          return null;
        }
      }
    } else {
      if (currentJuz >= baseJuzCount) {
        if (extraJuzList.length > 0) {
          return { number: extraJuzList[0], isExtra: true };
        } else {
          return baseJuzCount > 0 ? { number: 1, isExtra: false } : null;
        }
      } else {
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
    return 30;
  }

  if (lastMemorizedPage <= 20) {
    return lastMemorizedPage >= 20 ? 1 : 0;
  }

  return Math.floor((lastMemorizedPage - 1) / PAGES_IN_JUZ);
}

// Функция для проверки, нужно ли обновлять план
async function shouldUpdatePlan(user) {
  try {
    const today = moment().format("YYYY-MM-DD");

    // Если нет даты последнего плана - нужно обновить
    if (!user.lastPlanDate) {
      return true;
    }

    // Если последний план был не сегодня - нужно обновить
    if (user.lastPlanDate !== today) {
      return true;
    }

    // Если пользователь выучил новые страницы - нужно обновить
    const yesterday = moment().subtract(1, "day").format("YYYY-MM-DD");
    const yesterdayStat = await DailyStat.findOne({
      where: {
        userId: user.telegramId,
        date: yesterday,
      },
    });

    if (
      yesterdayStat &&
      yesterdayStat.pagesMemorized < user.lastMemorizedPage
    ) {
      return true;
    }

    // В остальных случаях - не нужно обновлять
    return false;
  } catch (error) {
    console.error("Ошибка в shouldUpdatePlan:", error);
    return true; // При ошибке лучше обновить
  }
}

async function sendDailyQuranPlan(ctx) {
  try {
    const user = await getUser(ctx.from.id);
    const today = moment().format("YYYY-MM-DD");

    // Проверяем, нужно ли обновлять план
    const needsUpdate = await shouldUpdatePlan(user);

    if (!needsUpdate && user.lastPlanDate === today) {
      // План на сегодня уже был отправлен, просто показываем существующий
      await ctx.reply(
        `📅 План на сегодня уже был сгенерирован ранее.\n\nЕсли хотите обновить план (например, после добавления новых страниц), нажмите "🔄 Обновить страницы" в настройках.`,
        mainKeyboard
      );
      return;
    }

    const lastMemorizedPage = user.lastMemorizedPage;
    const lastJuzUsed = user.lastJuzUsed || 0;
    const extraJuzList = getExtraJuzList(user.extraJuzList);
    const juzPerDay = user.juzPerDay || 1;

    // Записываем статистику ТОЛЬКО если план обновляется впервые за день
    if (needsUpdate) {
      await recordDailyStats(user, lastMemorizedPage, extraJuzList, juzPerDay);
    }

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

      // Обновляем дату последнего плана
      user.lastPlanDate = today;
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

    const PAGES_PER_DAY = PAGES_IN_JUZ * juzPerDay;
    allPages = allPages.slice(0, PAGES_PER_DAY);

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

      // Обновляем дату последнего плана
      user.lastPlanDate = today;
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

        const isFullyMemorized = isJuzFullyMemorized(
          juz.number,
          lastMemorizedPage,
          false
        );
        return isFullyMemorized ? `${juz.number}` : `${juz.number} (частично)`;
      })
      .join(", ");

    const message = `📅 План на сегодня

🎯 Джузы: ${juzNumbers}
📄 Страниц: ${allPages.length}

${namazPlan
  .map((item) => `${item.name}: стр. ${item.from}–${item.to}`)
  .join("\n")}

📊 Прогресс: ${lastMemorizedPage}/${TOTAL_PAGES} стр.
🎯 Джузов: ${totalKnownJuz}/30`;

    try {
      // Открепляем предыдущее сообщение
      if (user.dailyPlanMessageId) {
        try {
          await ctx.unpinChatMessage(user.dailyPlanMessageId);
        } catch (error) {
          // Игнорируем ошибку
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
      user.lastPlanDate = today;
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
    const progressToday = Math.max(0, lastMemorizedPage - previousPages);
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
        lastPlanDate: null,
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
    return { juzNumber: 1, pagesInJuz: 0, totalPagesInJuz: 19 };
  }

  if (lastMemorizedPage >= TOTAL_PAGES) {
    return { juzNumber: 30, pagesInJuz: 14, totalPagesInJuz: 14 };
  }

  let juzNumber, pagesInJuz, totalPagesInJuz;

  if (lastMemorizedPage <= 20) {
    juzNumber = 1;
    pagesInJuz = Math.max(0, lastMemorizedPage - 1);
    totalPagesInJuz = 19;
  } else {
    juzNumber = Math.floor((lastMemorizedPage - 1) / PAGES_IN_JUZ);

    if (juzNumber === 30) {
      const startPage30 = 29 * PAGES_IN_JUZ + 1;
      pagesInJuz = lastMemorizedPage - startPage30 + 1;
      totalPagesInJuz = TOTAL_PAGES - startPage30 + 1;
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

bot.use(session());

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
        await showExtraJuzMenu(ctx);
        break;

      case "🎯 Джузов в день":
        await askForJuzPerDay(ctx);
        break;

      case "📋 Экспорт статистики":
        await exportStatistics(ctx);
        break;

      case "➕ Добавить джузы":
        await askForExtraJuzAdd(ctx);
        break;

      case "🗑️ Удалить джузы":
        await askForExtraJuzRemove(ctx);
        break;

      case "📋 Список джузов":
        await showExtraJuzList(ctx);
        break;

      case "❌ Очистить все":
        await clearAllExtraJuz(ctx);
        break;

      case "🏠 Главное меню":
        // Сбрасываем все флаги ожидания
        if (ctx.session) {
          ctx.session.awaitingPages = false;
          ctx.session.awaitingExtraJuzAdd = false;
          ctx.session.awaitingExtraJuzRemove = false;
        }
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
        // Проверяем специальные команды для удаления джузов
        if (text.startsWith("удалить ") || text.startsWith("remove ")) {
          await removeExtraJuz(ctx, text);
        }
        // Проверяем, является ли сообщение числом (обновление страниц)
        else if (/^\d+$/.test(text)) {
          if (ctx.session?.awaitingPages) {
            await updatePages(ctx, parseInt(text));
          } else if (ctx.session?.awaitingExtraJuzAdd) {
            await addExtraJuz(ctx, text);
          } else if (ctx.session?.awaitingExtraJuzRemove) {
            await removeExtraJuzNumbers(ctx, text);
          } else {
            await ctx.reply(
              "Используйте кнопки меню для навигации.",
              mainKeyboard
            );
          }
        }
        // Проверяем, является ли сообщение списком джузов (с запятыми)
        else if (/^[\d\s,]+$/.test(text)) {
          if (ctx.session?.awaitingExtraJuzAdd) {
            await addExtraJuz(ctx, text);
          } else if (ctx.session?.awaitingExtraJuzRemove) {
            await removeExtraJuzNumbers(ctx, text);
          } else {
            await ctx.reply(
              "Используйте кнопки меню для навигации.",
              mainKeyboard
            );
          }
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

    // Сбрасываем дату последнего плана, так как прогресс изменился
    user.lastPlanDate = null;
    await user.save();

    // Записываем статистику
    await recordDailyStats(
      user,
      newPageCount,
      getExtraJuzList(user.extraJuzList),
      user.juzPerDay
    );

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

    message += `\n\n📅 Теперь план на сегодня будет обновлен!`;

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

    if (!ctx.session) ctx.session = {};
    ctx.session.awaitingPages = true;

    await ctx.reply(
      `Введите количество выученных страниц (от 1 до ${TOTAL_PAGES}):\n\nТекущее: ${user.lastMemorizedPage} стр.\n\nИспользуйте "🏠 Главное меню" для отмены`,
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

    // Сбрасываем дату последнего плана, так как прогресс изменился
    ctx.user.lastPlanDate = null;
    await ctx.user.save();

    // Записываем статистику
    await recordDailyStats(
      ctx.user,
      pages,
      getExtraJuzList(ctx.user.extraJuzList),
      ctx.user.juzPerDay
    );

    if (ctx.session) {
      ctx.session.awaitingPages = false;
    }

    await ctx.reply(
      `✅ Установлено ${pages} выученных страниц\n\n📅 Теперь план на сегодня будет обновлен!`,
      mainKeyboard
    );
  } catch (error) {
    console.error("Ошибка в updatePages:", error);
    await ctx.reply("❌ Не удалось обновить страницы.", mainKeyboard);
  }
}

// Функция показа меню дополнительных джузов
async function showExtraJuzMenu(ctx) {
  try {
    const user = ctx.user;
    const extraJuzList = getExtraJuzList(user.extraJuzList);

    let message = `📝 Управление дополнительными джузами\n\n`;

    if (extraJuzList.length > 0) {
      message += `📋 Текущие джузы: ${extraJuzList.join(", ")}\n\n`;
    } else {
      message += `📋 Дополнительных джузов пока нет\n\n`;
    }

    message += `Выберите действие:`;

    await ctx.reply(message, extraJuzKeyboard);
  } catch (error) {
    console.error("Ошибка в showExtraJuzMenu:", error);
    await ctx.reply("❌ Произошла ошибка.", mainKeyboard);
  }
}

// Функция запроса добавления дополнительных джузов
async function askForExtraJuzAdd(ctx) {
  try {
    const user = ctx.user;
    const extraJuzList = getExtraJuzList(user.extraJuzList);

    let message = `Введите номера джузов для добавления (1-30):`;

    if (extraJuzList.length > 0) {
      message += `\n\n📋 Текущие: ${extraJuzList.join(", ")}`;
    }

    message += `\n\n💡 Примеры:\n• 5\n• 5, 10, 15\n• 1 2 3\n\n🏠 "Главное меню" - отмена`;

    // Инициализируем сессию если её нет
    if (!ctx.session) {
      ctx.session = {};
    }

    ctx.session.awaitingExtraJuzAdd = true;
    ctx.session.awaitingExtraJuzRemove = false;
    ctx.session.awaitingPages = false;

    await ctx.reply(message, Markup.removeKeyboard());
  } catch (error) {
    console.error("Ошибка в askForExtraJuzAdd:", error);
    await ctx.reply("❌ Произошла ошибка.", mainKeyboard);
  }
}

// Функция запроса удаления дополнительных джузов
async function askForExtraJuzRemove(ctx) {
  try {
    const user = ctx.user;
    const extraJuzList = getExtraJuzList(user.extraJuzList);

    if (extraJuzList.length === 0) {
      await ctx.reply(
        "❌ У вас нет дополнительных джузов для удаления",
        extraJuzKeyboard
      );
      return;
    }

    let message = `Введите номера джузов для удаления (1-30):\n\nТекущие: ${extraJuzList.join(
      ", "
    )}\n\nПример: 5, 10, 15\nИспользуйте "🏠 Главное меню" для отмены`;

    if (!ctx.session) ctx.session = {};
    ctx.session.awaitingExtraJuzAdd = false;
    ctx.session.awaitingExtraJuzRemove = true;

    await ctx.reply(message, Markup.removeKeyboard());
  } catch (error) {
    console.error("Ошибка в askForExtraJuzRemove:", error);
    await ctx.reply("❌ Произошла ошибка.", mainKeyboard);
  }
}

// Функция показа списка дополнительных джузов
async function showExtraJuzList(ctx) {
  try {
    const user = ctx.user;
    const extraJuzList = getExtraJuzList(user.extraJuzList);

    if (extraJuzList.length === 0) {
      await ctx.reply("📋 Дополнительных джузов пока нет", extraJuzKeyboard);
      return;
    }

    const message = `📋 Ваши дополнительные джузы:\n\n${extraJuzList
      .map((juz) => `• Джуз ${juz}`)
      .join("\n")}\n\nВсего: ${extraJuzList.length} джуз${
      extraJuzList.length === 1 ? "" : "ов"
    }`;

    await ctx.reply(message, extraJuzKeyboard);
  } catch (error) {
    console.error("Ошибка в showExtraJuzList:", error);
    await ctx.reply("❌ Произошла ошибка.", mainKeyboard);
  }
}

// Функция добавления дополнительных джузов
async function addExtraJuz(ctx, text) {
  try {
    const user = ctx.user;
    const existingJuzList = getExtraJuzList(user.extraJuzList);

    // Обрабатываем разные форматы: "5", "5,10,15", "5 10 15"
    const juzArray = text
      .split(/[,\s]+/) // Разделяем по запятым или пробелам
      .map((item) => parseInt(item.trim()))
      .filter((juz) => !isNaN(juz) && juz >= 1 && juz <= 30);

    if (juzArray.length === 0) {
      await ctx.reply(
        "❌ Неверный формат.\n\n💡 Примеры:\n• 5\n• 5, 10, 15\n• 1 2 3",
        Markup.removeKeyboard()
      );
      return;
    }

    // Объединяем существующие и новые джузы
    const newJuzList = [...new Set([...existingJuzList, ...juzArray])].sort(
      (a, b) => a - b
    );

    // Проверяем, есть ли изменения
    if (newJuzList.length === existingJuzList.length) {
      await ctx.reply(
        "ℹ️ Эти джузы уже были добавлены ранее",
        extraJuzKeyboard
      );
      if (ctx.session) {
        ctx.session.awaitingExtraJuzAdd = false;
      }
      return;
    }

    ctx.user.extraJuzList = saveExtraJuzList(newJuzList);
    await ctx.user.save();

    // Сбрасываем сессию
    if (ctx.session) {
      ctx.session.awaitingExtraJuzAdd = false;
    }

    const addedCount = newJuzList.length - existingJuzList.length;
    const addedJuz = juzArray.filter((juz) => !existingJuzList.includes(juz));

    const message = `✅ Добавлено ${addedCount} джуз${
      addedCount === 1 ? "" : addedCount < 5 ? "а" : "ов"
    }: ${addedJuz.join(
      ", "
    )}\n\n📋 Все дополнительные джузы:\n${newJuzList.join(", ")}`;

    await ctx.reply(message, extraJuzKeyboard);
  } catch (error) {
    console.error("Ошибка в addExtraJuz:", error);
    await ctx.reply("❌ Не удалось добавить джузы.", extraJuzKeyboard);
  }
}

// Функция удаления конкретных дополнительных джузов
async function removeExtraJuzNumbers(ctx, text) {
  try {
    const user = ctx.user;
    const existingJuzList = getExtraJuzList(user.extraJuzList);

    const juzToRemove = text
      .split(",")
      .map((item) => parseInt(item.trim()))
      .filter((juz) => !isNaN(juz) && juz >= 1 && juz <= 30);

    if (juzToRemove.length === 0) {
      await ctx.reply(
        "❌ Неверный формат. Введите номера джузов через запятую (1-30)",
        extraJuzKeyboard
      );
      return;
    }

    // Удаляем указанные джузы
    const newJuzList = existingJuzList.filter(
      (juz) => !juzToRemove.includes(juz)
    );

    // Проверяем, есть ли изменения
    if (newJuzList.length === existingJuzList.length) {
      await ctx.reply("ℹ️ Этих джузов нет в вашем списке", extraJuzKeyboard);
      return;
    }

    ctx.user.extraJuzList = saveExtraJuzList(newJuzList);
    await ctx.user.save();

    // Сбрасываем сессию
    if (ctx.session) {
      ctx.session.awaitingExtraJuzRemove = false;
    }

    const removedCount = existingJuzList.length - newJuzList.length;
    let message = `✅ Удалено ${removedCount} джуз${
      removedCount === 1 ? "" : "ов"
    }`;

    if (newJuzList.length > 0) {
      message += `\n\n📋 Остались джузы:\n${newJuzList.join(", ")}`;
    } else {
      message += `\n\n📋 Теперь дополнительных джузов нет`;
    }

    await ctx.reply(message, extraJuzKeyboard);
  } catch (error) {
    console.error("Ошибка в removeExtraJuzNumbers:", error);
    await ctx.reply("❌ Не удалось удалить джузы.", extraJuzKeyboard);
  }
}

// Функция удаления джузов по текстовой команде
async function removeExtraJuz(ctx, text) {
  try {
    const user = ctx.user;
    const existingJuzList = getExtraJuzList(user.extraJuzList);

    // Извлекаем номера джузов из команды типа "удалить 1, 2, 3"
    const numbersMatch = text.match(/\d+/g);

    if (!numbersMatch || numbersMatch.length === 0) {
      await ctx.reply(
        "❌ Неверный формат. Используйте: удалить 1, 2, 3",
        extraJuzKeyboard
      );
      return;
    }

    const juzToRemove = numbersMatch.map((num) => parseInt(num));

    // Удаляем указанные джузы
    const newJuzList = existingJuzList.filter(
      (juz) => !juzToRemove.includes(juz)
    );

    if (newJuzList.length === existingJuzList.length) {
      await ctx.reply("ℹ️ Этих джузов нет в вашем списке", extraJuzKeyboard);
      return;
    }

    ctx.user.extraJuzList = saveExtraJuzList(newJuzList);
    await ctx.user.save();

    const removedCount = existingJuzList.length - newJuzList.length;
    let message = `✅ Удалено ${removedCount} джуз${
      removedCount === 1 ? "" : "ов"
    }`;

    if (newJuzList.length > 0) {
      message += `\n\n📋 Остались джузы:\n${newJuzList.join(", ")}`;
    } else {
      message += `\n\n📋 Теперь дополнительных джузов нет`;
    }

    await ctx.reply(message, extraJuzKeyboard);
  } catch (error) {
    console.error("Ошибка в removeExtraJuz:", error);
    await ctx.reply("❌ Не удалось удалить джузы.", extraJuzKeyboard);
  }
}

// Функция очистки всех дополнительных джузов
async function clearAllExtraJuz(ctx) {
  try {
    ctx.user.extraJuzList = "[]";
    await ctx.user.save();

    await ctx.reply("✅ Все дополнительные джузы удалены", extraJuzKeyboard);
  } catch (error) {
    console.error("Ошибка в clearAllExtraJuz:", error);
    await ctx.reply("❌ Не удалось очистить джузы.", extraJuzKeyboard);
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

    let csv =
      "Дата,Выучено страниц,Базовых джузов,Прогресс за день,Всего джузов,Джузов в день,Повторено страниц\n";

    stats.forEach((stat) => {
      csv += `${moment(stat.date).format("DD.MM.YYYY")},${
        stat.pagesMemorized
      },${stat.baseJuzCount},${stat.dailyProgress},${stat.totalJuzCount},${
        stat.juzPerDay
      },${stat.pagesRepeated}\n`;
    });

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
        // Проверяем, нужно ли отправлять план (если еще не отправляли сегодня)
        const today = moment().format("YYYY-MM-DD");
        if (user.lastPlanDate === today) {
          console.log(
            `Пользователь ${user.telegramId} уже получил план сегодня`
          );
          continue;
        }

        const botInstance = new Telegraf(process.env.BOT_TOKEN);

        await botInstance.telegram.sendMessage(
          user.telegramId,
          '⏰ Время для повторения Корана!\n\nНажмите "📅 План на сегодня" для получения вашего плана.',
          mainKeyboard
        );

        botInstance.stop();

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
    await sequelize.sync({ alter: true });
    console.log("✅ База данных подключена");

    await bot.launch();
    console.log("✅ Бот запущен");

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
