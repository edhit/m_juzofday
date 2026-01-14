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
  lastPlanDate: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  settingsMenuOpen: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
});

const UserAction = sequelize.define("UserAction", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  actionType: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  previousValue: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  newValue: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  previousExtraJuzList: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  newExtraJuzList: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  actionDate: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
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

User.hasMany(UserAction, { foreignKey: "userId" });
UserAction.belongsTo(User, { foreignKey: "userId" });

// Константы
const TOTAL_PAGES = 604;
const PAGES_IN_JUZ = 20;

// 🎯 ОСНОВНОЙ ИНТЕРФЕЙС - только самое важное
const mainKeyboard = Markup.keyboard([
  ["📅 План на сегодня"],
  ["➕ Добавить страницу"],
  ["↩️ Отменить", "⚙️ Дополнительно"],
]).resize();

// 📊 МЕНЮ СТАТИСТИКИ
const statsKeyboard = Markup.keyboard([
  ["📊 Моя статистика"],
  ["📈 Прогресс за неделю"],
  ["↩️ История действий", "📤 Экспорт данных"],
  ["🏠 На главную"],
]).resize();

// Добавляем клавиатуру для управления историей
const historyKeyboard = Markup.keyboard([
  ["↩️ Отменить последнее"],
  ["📋 История действий"],
  ["⚙️ Назад в статистику"],
]).resize();

// ⚙️ НАСТРОЙКИ - аккуратно организованы
const settingsKeyboard = Markup.keyboard([
  ["📝 Мои страницы", "🎯 Джузы в день"],
  ["📚 Доп. джузы", "🔄 Обновить всё"],
  ["🏠 На главную"],
]).resize();

// 📚 УПРАВЛЕНИЕ ДОП. ДЖУЗАМИ
const juzManageKeyboard = Markup.keyboard([
  ["➕ Добавить джуз", "🗑️ Удалить джуз"],
  ["📋 Список джузов", "❌ Очистить всё"],
  ["⚙️ Назад в настройки"],
]).resize();

// 🎯 ВЫБОР КОЛИЧЕСТВА ДЖУЗОВ
const juzCountKeyboard = Markup.keyboard([
  ["1", "2", "3"],
  ["4", "5"],
  ["⚙️ Назад в настройки"],
]).resize();

// 📝 ОБНОВЛЕНИЕ СТРАНИЦ
const pagesUpdateKeyboard = Markup.keyboard([
  ["📊 Текущий прогресс", "✏️ Изменить вручную"],
  ["📈 Автоматический расчёт", "⚙️ Назад в настройки"],
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

    if (!user.lastPlanDate) {
      return true;
    }

    if (user.lastPlanDate !== today) {
      return true;
    }

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

    return false;
  } catch (error) {
    console.error("Ошибка в shouldUpdatePlan:", error);
    return true;
  }
}

// 🎯 ОСНОВНАЯ ФУНКЦИЯ - ПЛАН НА СЕГОДНЯ (упрощенная)
async function sendDailyQuranPlan(ctx) {
  try {
    const user = await getUser(ctx.from.id);
    const today = moment().format("YYYY-MM-DD");

    // Проверяем, нужно ли обновлять план
    const needsUpdate = await shouldUpdatePlan(user);

    if (!needsUpdate && user.lastPlanDate === today) {
      const message = `
📅 *Ваш план на сегодня уже готов!*

Если вы добавили новые страницы и хотите обновить план:
1. Нажмите "⚙️ Дополнительно"
2. Выберите "🔄 Обновить всё"
      `;
      await ctx.replyWithMarkdown(message, mainKeyboard);
      return;
    }

    const lastMemorizedPage = user.lastMemorizedPage;
    const lastJuzUsed = user.lastJuzUsed || 0;
    const extraJuzList = getExtraJuzList(user.extraJuzList);
    const juzPerDay = user.juzPerDay || 1;

    // Записываем статистику
    if (needsUpdate) {
      await recordDailyStats(user, lastMemorizedPage, extraJuzList, juzPerDay);
    }

    // Получаем джузы на сегодня
    const todayJuzList = getJuzForToday(
      lastJuzUsed,
      lastMemorizedPage,
      extraJuzList,
      juzPerDay
    );

    // Если нет джузов для повторения
    if (todayJuzList.length === 0) {
      const baseJuzCount = calculateBaseJuzCount(lastMemorizedPage);
      const totalKnownJuz = baseJuzCount + extraJuzList.length;

      const message = `
📅 *План на сегодня*

🎯 *Нет джузов для повторения*

📊 *Ваш прогресс:*
• Выучено страниц: *${lastMemorizedPage}/${TOTAL_PAGES}*
• Всего джузов: *${totalKnownJuz}/30*

👉 Нажмите "➕ Добавить страницу" чтобы продолжить
      `;

      const sentMessage = await ctx.replyWithMarkdown(message, mainKeyboard);

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

    // Формируем сообщение
    const baseJuzCount = calculateBaseJuzCount(lastMemorizedPage);
    const totalKnownJuz = baseJuzCount + extraJuzList.length;

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

    const message = `
📅 *ПЛАН НА СЕГОДНЯ*

🎯 *Джузы для повторения:*
${juzNumbers}

📄 *Страницы:* ${allPages.length}

🕌 *По намазам:*
${namazPlan
  .map((item) => `• ${item.name}: стр. ${item.from}–${item.to}`)
  .join("\n")}

📊 *Ваш прогресс:*
• Страниц: ${lastMemorizedPage}/${TOTAL_PAGES}
• Джузов: ${totalKnownJuz}/30
• Джузов в день: ${juzPerDay}

_План автоматически обновляется каждый день_
    `;

    try {
      // Открепляем предыдущее сообщение
      if (user.dailyPlanMessageId) {
        try {
          await ctx.unpinChatMessage(user.dailyPlanMessageId);
        } catch (error) {}
      }

      // Отправляем новое сообщение
      const sentMessage = await ctx.replyWithMarkdown(message, mainKeyboard);

      // Закрепляем
      try {
        await ctx.pinChatMessage(sentMessage.message_id);
      } catch (error) {
        console.log("Не удалось закрепить сообщение:", error.message);
      }

      // Обновляем данные
      if (todayJuzList.length > 0) {
        user.lastJuzUsed = todayJuzList[todayJuzList.length - 1].number;
      }
      user.lastPlanDate = today;
      user.dailyPlanMessageId = sentMessage.message_id;
      await user.save();
    } catch (error) {
      console.error("Ошибка отправки плана:", error);
      await ctx.reply("⚠️ Произошла ошибка. Попробуйте снова.", mainKeyboard);
    }
  } catch (error) {
    console.error("Ошибка в sendDailyQuranPlan:", error);
    await ctx.reply("❌ Произошла ошибка. Попробуйте позже.", mainKeyboard);
  }
}

// 📊 СТАТИСТИКА
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

// Функция для получения информации о текущем прогрессе
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

async function saveUserAction(userId, actionData) {
  try {
    await UserAction.create({
      userId: userId,
      actionType: actionData.actionType,
      previousValue: actionData.previousValue,
      newValue: actionData.newValue,
      previousExtraJuzList: actionData.previousExtraJuzList,
      newExtraJuzList: actionData.newExtraJuzList,
    });
  } catch (error) {
    console.error("Ошибка сохранения действия:", error);
  }
}

async function getLastUserAction(userId) {
  try {
    return await UserAction.findOne({
      where: { userId: userId },
      order: [["actionDate", "DESC"]],
    });
  } catch (error) {
    console.error("Ошибка получения действия:", error);
    return null;
  }
}

async function undoLastAction(ctx) {
  try {
    const user = ctx.user;
    const lastAction = await getLastUserAction(user.telegramId);

    if (!lastAction) {
      await ctx.reply(
        "❌ *Нет действий для отмены*\n\nВы еще ничего не меняли.",
        mainKeyboard
      );
      return;
    }

    let success = false;
    let message = "";

    switch (lastAction.actionType) {
      case "ADD_PAGE":
        // Возвращаем предыдущее количество страниц
        if (lastAction.previousValue !== null) {
          user.lastMemorizedPage = lastAction.previousValue;
          user.lastPlanDate = null; // Сбрасываем план для пересчета
          await user.save();

          // Записываем статистику
          await recordDailyStats(
            user,
            lastAction.previousValue,
            getExtraJuzList(user.extraJuzList),
            user.juzPerDay
          );

          success = true;
          message = `✅ *Отменено добавление страницы*\n\nВозвращено: ${lastAction.previousValue} стр.\nТекущее: ${user.lastMemorizedPage} стр.`;
        }
        break;

      case "UPDATE_PAGES_MANUAL":
        // Возвращаем предыдущее количество страниц
        if (lastAction.previousValue !== null) {
          user.lastMemorizedPage = lastAction.previousValue;
          user.lastPlanDate = null;
          await user.save();

          await recordDailyStats(
            user,
            lastAction.previousValue,
            getExtraJuzList(user.extraJuzList),
            user.juzPerDay
          );

          success = true;
          message = `✅ *Отменено изменение страниц*\n\nВозвращено: ${lastAction.previousValue} стр.\nТекущее: ${user.lastMemorizedPage} стр.`;
        }
        break;

      case "SET_JUZ_PER_DAY":
        // Возвращаем предыдущее количество джузов в день
        if (lastAction.previousValue !== null) {
          user.juzPerDay = lastAction.previousValue;
          user.lastPlanDate = null;
          await user.save();

          success = true;
          message = `✅ *Отменено изменение джузов в день*\n\nВозвращено: ${
            lastAction.previousValue
          } джуз${lastAction.previousValue > 1 ? "а" : ""}\nТекущее: ${
            user.juzPerDay
          } джуз${user.juzPerDay > 1 ? "а" : ""}`;
        }
        break;

      case "ADD_EXTRA_JUZ":
        // Возвращаем предыдущий список джузов
        if (lastAction.previousExtraJuzList) {
          user.extraJuzList = lastAction.previousExtraJuzList;
          user.lastPlanDate = null;
          await user.save();

          const currentList = getExtraJuzList(lastAction.previousExtraJuzList);
          success = true;
          message = `✅ *Отменено добавление джузов*\n\nВозвращен предыдущий список.\nТекущие джузы: ${
            currentList.length > 0 ? currentList.join(", ") : "нет"
          }`;
        }
        break;

      case "REMOVE_EXTRA_JUZ":
        // Возвращаем предыдущий список джузов
        if (lastAction.previousExtraJuzList) {
          user.extraJuzList = lastAction.previousExtraJuzList;
          user.lastPlanDate = null;
          await user.save();

          const currentList = getExtraJuzList(lastAction.previousExtraJuzList);
          success = true;
          message = `✅ *Отменено удаление джузов*\n\nВозвращен предыдущий список.\nТекущие джузы: ${
            currentList.length > 0 ? currentList.join(", ") : "нет"
          }`;
        }
        break;

      case "CLEAR_EXTRA_JUZ":
        // Возвращаем предыдущий список джузов
        if (lastAction.previousExtraJuzList) {
          user.extraJuzList = lastAction.previousExtraJuzList;
          user.lastPlanDate = null;
          await user.save();

          const currentList = getExtraJuzList(lastAction.previousExtraJuzList);
          success = true;
          message = `✅ *Отменено очищение списка*\n\nВозвращены все джузы.\nТекущие джузы: ${
            currentList.length > 0 ? currentList.join(", ") : "нет"
          }`;
        }
        break;

      default:
        message = "❌ *Неизвестный тип действия для отмены*";
    }

    if (success) {
      // Удаляем отмененное действие из истории
      await lastAction.destroy();

      // Обновляем план
      message += `\n\n📅 *План на сегодня будет пересчитан.*`;
      await ctx.replyWithMarkdown(message, mainKeyboard);
    } else {
      await ctx.replyWithMarkdown(message, mainKeyboard);
    }
  } catch (error) {
    console.error("Ошибка в undoLastAction:", error);
    await ctx.reply("❌ *Не удалось отменить действие*", mainKeyboard);
  }
}

async function showActionHistory(ctx) {
  try {
    const user = ctx.user;
    const actions = await UserAction.findAll({
      where: { userId: user.telegramId },
      order: [["actionDate", "DESC"]],
      limit: 10,
    });

    if (actions.length === 0) {
      await ctx.reply(
        "📋 *История действий пуста*\n\nВы еще не совершали изменений.",
        historyKeyboard
      );
      return;
    }

    let message = `📋 *Последние 10 действий:*\n\n`;

    actions.forEach((action, index) => {
      const timeAgo = moment(action.actionDate).fromNow();
      message += `${index + 1}. ${getActionDescription(action)} (${timeAgo})\n`;
    });

    message += `\n↩️ Вы можете отменить последнее действие.`;

    await ctx.replyWithMarkdown(message, historyKeyboard);
  } catch (error) {
    console.error("Ошибка в showActionHistory:", error);
    await ctx.reply("❌ *Не удалось загрузить историю*", historyKeyboard);
  }
}

// Функция для описания действия
function getActionDescription(action) {
  switch (action.actionType) {
    case "ADD_PAGE":
      return `Добавлена страница: ${action.previousValue} → ${action.newValue}`;
    case "UPDATE_PAGES_MANUAL":
      return `Изменены страницы: ${action.previousValue} → ${action.newValue}`;
    case "SET_JUZ_PER_DAY":
      return `Джузов в день: ${action.previousValue} → ${action.newValue}`;
    case "ADD_EXTRA_JUZ":
      const prevAdd = getExtraJuzList(action.previousExtraJuzList);
      const newAdd = getExtraJuzList(action.newExtraJuzList);
      return `Добавлены джузы: ${newAdd.filter(j => !prevAdd.includes(j)).join(", ")}`;
    case "REMOVE_EXTRA_JUZ":
      const prevRemove = getExtraJuzList(action.previousExtraJuzList);
      const newRemove = getExtraJuzList(action.newExtraJuzList);
      return `Удалены джузы: ${prevRemove.filter(j => !newRemove.includes(j)).join(", ")}`;
    case "CLEAR_EXTRA_JUZ":
      return `Очищены все доп. джузы`;
    default:
      return `Неизвестное действие`;
  }
}


// Инициализация бота
const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

// Middleware для пользователя
bot.use(async (ctx, next) => {
  try {
    if (ctx.from) {
      ctx.user = await getUser(ctx.from.id);
    }
    await next();
  } catch (error) {
    console.error("Ошибка в middleware:", error);
    await ctx.reply("❌ Произошла ошибка. Используйте /start");
  }
});

// 📱 ОСНОВНОЕ МЕНЮ - простой интерфейс
bot.start(async (ctx) => {
  try {
    const welcomeMessage = `
👋 *Салам алейкум, ${ctx.from.first_name}!*

Я помогу вам систематизировать повторение Корана.

*🎯 Как это работает:*
1. Укажите сколько страниц вы выучили
2. Получайте ежедневный план повторения
3. Добавляйте новые страницы по мере изучения

*📅 Основные кнопки:*
• *План на сегодня* — ваш дневной маршрут
• *Добавить страницу* — +1 страница к вашему прогрессу
• *Дополнительно* — статистика и настройки

_Начните с кнопки "➕ Добавить страницу"!_
    `;

    await ctx.replyWithMarkdown(welcomeMessage, mainKeyboard);
  } catch (error) {
    console.error("Ошибка в команде /start:", error);
  }
});

// 📱 ОБРАБОТКА КНОПОК - логичная структура
bot.on("text", async (ctx) => {
  try {
    const text = ctx.message.text;
    const user = ctx.user;

    // 🎯 ГЛАВНОЕ МЕНЮ
    if (text === "📅 План на сегодня") {
      await sendDailyQuranPlan(ctx);
    } else if (text === "➕ Добавить страницу") {
      await addOnePage(ctx);
    } else if (text === "⚙️ Дополнительно") {
      await showMainMenu(ctx);
    } else if (text === "🏠 На главную") {
      await ctx.reply("Главное меню:", mainKeyboard);
    }

    // 📊 СТАТИСТИКА МЕНЮ (добавляем новую кнопку)
    else if (text === "📊 Моя статистика") {
      await showSimpleStats(ctx);
    } else if (text === "📈 Прогресс за неделю") {
      await showWeeklyStats(ctx);
    } else if (text === "↩️ История действий") {
      await showActionHistory(ctx);
    } else if (text === "📤 Экспорт данных") {
      await exportStatistics(ctx);
    }

    // 🕐 ОТМЕНА ДЕЙСТВИЙ
    else if (text === "↩️ Отменить") {
      await undoLastAction(ctx);
    } else if (text === "↩️ Отменить последнее") {
      await undoLastAction(ctx);
    } else if (text === "📋 История действий") {
      await showActionHistory(ctx);
    }

    // 📊 ГЛАВНОЕ МЕНЮ ДОПОЛНИТЕЛЬНО
    else if (text === "📊 Статистика") {
      await showStatsMenu(ctx);
    } else if (text === "⚙️ Настройки") {
      await showSettings(ctx);
    }

    // ⚙️ НАСТРОЙКИ МЕНЮ
    else if (text === "📝 Мои страницы") {
      await showPagesMenu(ctx);
    } else if (text === "🎯 Джузы в день") {
      await showJuzPerDayMenu(ctx);
    } else if (text === "📚 Доп. джузы") {
      await showExtraJuzMenu(ctx);
    } else if (text === "🔄 Обновить всё") {
      await resetPlan(ctx);
    } else if (text === "⚙️ Назад в настройки") {
      await showSettings(ctx);
    }

    // 📝 УПРАВЛЕНИЕ СТРАНИЦАМИ
    else if (text === "📊 Текущий прогресс") {
      await showCurrentProgress(ctx);
    } else if (text === "✏️ Изменить вручную") {
      await askForManualUpdate(ctx);
    } else if (text === "📈 Автоматический расчёт") {
      await showAutoCalculateMenu(ctx);
    }

    // 📚 УПРАВЛЕНИЕ ДЖУЗАМИ
    else if (text === "➕ Добавить джуз") {
      await askForExtraJuzAdd(ctx);
    } else if (text === "🗑️ Удалить джуз") {
      await askForExtraJuzRemove(ctx);
    } else if (text === "📋 Список джузов") {
      await showExtraJuzList(ctx);
    } else if (text === "❌ Очистить всё") {
      await clearAllExtraJuz(ctx);
    }

    // 🎯 ВЫБОР КОЛИЧЕСТВА ДЖУЗОВ
    else if (["1", "2", "3", "4", "5"].includes(text)) {
      await setJuzPerDay(ctx, text);
    }

    // 📊 ГЛАВНОЕ МЕНЮ ДОПОЛНИТЕЛЬНО
    else if (text === "📊 Статистика") {
      await showStatsMenu(ctx);
    } else if (text === "⚙️ Настройки") {
      await showSettings(ctx);
    } else if (text === "📝 Доп. джузы") {
      await showExtraJuzMenu(ctx);
    } else if (text === "🎯 Джузов в день") {
      await showJuzPerDayMenu(ctx);
    }

    // 📝 ОБРАБОТКА ЧИСЕЛ (ручной ввод)
    else if (/^\d+$/.test(text)) {
      if (ctx.session?.awaitingManualUpdate) {
        await updatePagesManual(ctx, parseInt(text));
      } else if (ctx.session?.awaitingExtraJuzAdd) {
        await addExtraJuz(ctx, text);
      } else if (ctx.session?.awaitingExtraJuzRemove) {
        await removeExtraJuzNumbers(ctx, text);
      } else {
        await ctx.reply("Используйте кнопки меню для навигации.", mainKeyboard);
      }
    }

    // 📝 ОБРАБОТКА СПИСКОВ (с запятыми)
    else if (/^[\d\s,]+$/.test(text)) {
      if (ctx.session?.awaitingExtraJuzAdd) {
        await addExtraJuz(ctx, text);
      } else if (ctx.session?.awaitingExtraJuzRemove) {
        await removeExtraJuzNumbers(ctx, text);
      } else {
        await ctx.reply("Используйте кнопки меню для навигации.", mainKeyboard);
      }
    } else {
      await ctx.reply("Используйте кнопки меню для навигации.", mainKeyboard);
    }
  } catch (error) {
    console.error("Ошибка обработки текста:", error);
    await ctx.reply("❌ Произошла ошибка. Попробуйте снова.", mainKeyboard);
  }
});

// 🎯 ОСНОВНЫЕ ФУНКЦИИ

async function addOnePage(ctx) {
  try {
    const user = ctx.user;
    const currentPage = user.lastMemorizedPage;

    if (currentPage >= TOTAL_PAGES) {
      await ctx.reply(
        `🎉 *МАШААЛЛАХ!* Вы выучили весь Коран!\n\nВсе ${TOTAL_PAGES} страниц изучены.`,
        mainKeyboard
      );
      return;
    }

    const newPageCount = currentPage + 1;

    // Сохраняем действие
    await saveUserAction(user.telegramId, {
      actionType: "ADD_PAGE",
      previousValue: currentPage,
      newValue: newPageCount,
    });

    user.lastMemorizedPage = newPageCount;
    user.lastPlanDate = null;
    await user.save();

    // Статистика
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
      message = `🎉 *МАШААЛЛАХ!* Вы завершили 30-й джуз и весь Коран!\n\n`;
    } else if (pagesInJuz === totalPagesInJuz) {
      message = `🎉 *МАШААЛЛАХ!* Вы завершили джуз ${juzNumber}!\n\n`;
    }

    message += `✅ *Добавлена 1 страница*

📊 *Прогресс:*
• Страниц: *${newPageCount}/${TOTAL_PAGES}*
• Джузов: *${totalJuzCount}/30*

🎯 *Джуз ${juzNumber}:* ${pagesInJuz}/${totalPagesInJuz} стр.`;

    if (pagesInJuz === totalPagesInJuz && juzNumber < 30) {
      const nextJuz = juzNumber + 1;
      message += `\n\n📖 *Следующий:* джуз ${nextJuz}`;
    }

    message += `\n\n📅 *План на сегодня обновлен!*\n\n↩️ Можно отменить действие.`;

    await ctx.replyWithMarkdown(message, mainKeyboard);
  } catch (error) {
    console.error("Ошибка в addOnePage:", error);
    await ctx.reply("❌ Не удалось добавить страницу.", mainKeyboard);
  }
}

// 📊 МЕНЮ СТАТИСТИКИ
async function showMainMenu(ctx) {
  const message = `
⚙️ *Дополнительные возможности*

Выберите раздел:

*📊 Статистика* — ваш прогресс и достижения
*⚙️ Настройки* — управление параметрами

Или вернитесь в главное меню:
  `;

  await ctx.replyWithMarkdown(
    message,
    Markup.keyboard([
      ["📊 Статистика", "⚙️ Настройки"],
      ["🏠 На главную"],
    ]).resize()
  );
}

async function showStatsMenu(ctx) {
  const message = `
📊 *Статистика и аналитика*

Здесь вы можете отслеживать свой прогресс:

*📊 Моя статистика* — общий прогресс
*📈 Прогресс за неделю* — динамика за 7 дней
*↩️ История действий* — просмотр и отмена изменений
*📤 Экспорт данных* — скачать историю в CSV

Выберите действие:
  `;

  await ctx.replyWithMarkdown(message, statsKeyboard);
}

async function showSimpleStats(ctx) {
  try {
    const user = ctx.user;
    const extraJuzList = getExtraJuzList(user.extraJuzList);
    const baseJuzCount = calculateBaseJuzCount(user.lastMemorizedPage);
    const totalJuzCount = baseJuzCount + extraJuzList.length;

    const { juzNumber, pagesInJuz, totalPagesInJuz } = getCurrentJuzProgress(
      user.lastMemorizedPage
    );

    // Получаем статистику за неделю
    const weekAgo = moment().subtract(7, "days").format("YYYY-MM-DD");
    const weekStats = await DailyStat.findAll({
      where: {
        userId: user.telegramId,
        date: { [Op.gte]: weekAgo },
      },
      order: [["date", "ASC"]],
    });

    let weekSummary = "";
    if (weekStats.length > 0) {
      const weekProgress = weekStats.reduce(
        (sum, stat) => sum + (stat.dailyProgress || 0),
        0
      );
      const weekRepeated = weekStats.reduce(
        (sum, stat) => sum + (stat.pagesRepeated || 0),
        0
      );

      weekSummary = `
📈 *За неделю:*
• Новых страниц: *+${weekProgress}*
• Повторено: *${weekRepeated}* стр.
      `;
    }

    const message = `
📊 *Ваша статистика*

📈 *Прогресс:*
• Страниц: *${user.lastMemorizedPage}/${TOTAL_PAGES}*
• Базовых джузов: *${baseJuzCount}*
• Доп. джузов: *${extraJuzList.length}*
• Всего джузов: *${totalJuzCount}/30*
• Джузов в день: *${user.juzPerDay}*

🎯 *Текущий джуз ${juzNumber}:*
${pagesInJuz}/${totalPagesInJuz} стр.

${weekSummary}

_Данные обновляются автоматически_
    `;

    await ctx.replyWithMarkdown(message, statsKeyboard);
  } catch (error) {
    console.error("Ошибка в showSimpleStats:", error);
    await ctx.reply("❌ Не удалось загрузить статистику.", statsKeyboard);
  }
}

async function showWeeklyStats(ctx) {
  try {
    const user = ctx.user;
    const weekAgo = moment().subtract(7, "days").format("YYYY-MM-DD");

    const stats = await DailyStat.findAll({
      where: {
        userId: user.telegramId,
        date: { [Op.gte]: weekAgo },
      },
      order: [["date", "ASC"]],
    });

    if (stats.length === 0) {
      await ctx.reply(
        "📊 *Пока нет данных за неделю*\n\nДобавьте несколько страниц для отслеживания прогресса.",
        statsKeyboard
      );
      return;
    }

    let message = `📈 *Прогресс за 7 дней*\n\n`;

    stats.forEach((stat) => {
      const date = moment(stat.date).format("DD.MM");
      message += `*${date}:*\n`;
      message += `• Новых: ${stat.dailyProgress || 0} стр.\n`;
      message += `• Повторено: ${stat.pagesRepeated || 0} стр.\n`;
      message += `• Всего: ${stat.pagesMemorized} стр.\n\n`;
    });

    const totalProgress = stats.reduce(
      (sum, stat) => sum + (stat.dailyProgress || 0),
      0
    );
    const totalRepeated = stats.reduce(
      (sum, stat) => sum + (stat.pagesRepeated || 0),
      0
    );

    message += `*Итого за неделю:*\n`;
    message += `• Новых страниц: *+${totalProgress}*\n`;
    message += `• Повторено: *${totalRepeated}* стр.\n`;
    message += `• Среднее в день: *${Math.round(
      totalRepeated / stats.length
    )}* стр.`;

    await ctx.replyWithMarkdown(message, statsKeyboard);
  } catch (error) {
    console.error("Ошибка в showWeeklyStats:", error);
    await ctx.reply("❌ Не удалось загрузить статистику.", statsKeyboard);
  }
}

// ⚙️ МЕНЮ НАСТРОЕК
async function showSettings(ctx) {
  const user = ctx.user;
  const extraJuzList = getExtraJuzList(user.extraJuzList);

  const message = `
⚙️ *Настройки*

Текущие параметры:
• Выучено страниц: *${user.lastMemorizedPage}*
• Джузов в день: *${user.juzPerDay}*
• Доп. джузов: *${extraJuzList.length}*

Выберите параметр для изменения:
  `;

  await ctx.replyWithMarkdown(message, settingsKeyboard);
}

async function showPagesMenu(ctx) {
  const user = ctx.user;
  const { juzNumber, pagesInJuz, totalPagesInJuz } = getCurrentJuzProgress(
    user.lastMemorizedPage
  );

  const message = `
📝 *Управление страницами*

Текущий прогресс:
• Выучено: *${user.lastMemorizedPage}* стр.
• Джуз ${juzNumber}: *${pagesInJuz}/${totalPagesInJuz}* стр.

Выберите действие:
  `;

  await ctx.replyWithMarkdown(message, pagesUpdateKeyboard);
}

async function showCurrentProgress(ctx) {
  const user = ctx.user;
  const { juzNumber, pagesInJuz, totalPagesInJuz } = getCurrentJuzProgress(
    user.lastMemorizedPage
  );
  const baseJuzCount = calculateBaseJuzCount(user.lastMemorizedPage);
  const extraJuzList = getExtraJuzList(user.extraJuzList);
  const totalJuzCount = baseJuzCount + extraJuzList.length;

  const message = `
📊 *Текущий прогресс*

*Основные показатели:*
• Выучено страниц: *${user.lastMemorizedPage}/${TOTAL_PAGES}*
• Всего джузов: *${totalJuzCount}/30*
• Джузов в день: *${user.juzPerDay}*

*Текущий джуз ${juzNumber}:*
${pagesInJuz}/${totalPagesInJuz} стр.

*Расчетные данные:*
• Базовых джузов: ${baseJuzCount}
• Доп. джузов: ${extraJuzList.length}
${
  extraJuzList.length > 0
    ? `• Список доп. джузов: ${extraJuzList.join(", ")}`
    : ""
}

_Используйте "✏️ Изменить вручную" для корректировки_
  `;

  await ctx.replyWithMarkdown(message, pagesUpdateKeyboard);
}

async function askForManualUpdate(ctx) {
  try {
    const user = ctx.user;

    if (!ctx.session) ctx.session = {};
    ctx.session.awaitingManualUpdate = true;

    const message = `
✏️ *Ручное обновление страниц*

Текущее значение: *${user.lastMemorizedPage}* стр.

Введите новое количество выученных страниц (от 1 до ${TOTAL_PAGES}):

_Например: 150_

Или нажмите "⚙️ Назад в настройки" для отмены
    `;

    await ctx.replyWithMarkdown(
      message,
      Markup.keyboard([["⚙️ Назад в настройки"]]).resize()
    );
  } catch (error) {
    console.error("Ошибка в askForManualUpdate:", error);
    await ctx.reply("❌ Произошла ошибка.", settingsKeyboard);
  }
}

async function updatePagesManual(ctx, pages) {
  try {
    if (isNaN(pages) || pages < 0 || pages > TOTAL_PAGES) {
      await ctx.reply(
        `❌ Введите число от 0 до ${TOTAL_PAGES}`,
        settingsKeyboard
      );
      return;
    }

    const user = ctx.user;
    const previousPages = user.lastMemorizedPage;

    // Сохраняем действие
    await saveUserAction(user.telegramId, {
      actionType: "UPDATE_PAGES_MANUAL",
      previousValue: previousPages,
      newValue: pages,
    });

    user.lastMemorizedPage = pages;
    user.lastPlanDate = null;
    await user.save();

    // Статистика
    await recordDailyStats(
      user,
      pages,
      getExtraJuzList(user.extraJuzList),
      user.juzPerDay
    );

    if (ctx.session) {
      ctx.session.awaitingManualUpdate = false;
    }

    const message = `
✅ *Обновлено!*

Новое количество страниц: *${pages}*

📅 *План на сегодня будет пересчитан.*

↩️ Можно отменить действие.
    `;

    await ctx.replyWithMarkdown(message, settingsKeyboard);
  } catch (error) {
    console.error("Ошибка в updatePagesManual:", error);
    await ctx.reply("❌ Не удалось обновить страницы.", settingsKeyboard);
  }
}

async function showAutoCalculateMenu(ctx) {
  const message = `
📈 *Автоматический расчет*

Эта функция поможет вам определить, сколько страниц вы выучили на основе известных джузов.

*Как это работает:*
1. Укажите последний полностью выученный джуз
2. Укажите текущий джуз и сколько в нем страниц
3. Система рассчитает общее количество страниц

*Пример:*
• Последний полный джуз: 5
• Текущий джуз: 6
• Страниц в текущем: 12
• Итого: 5×20 + 12 = 112 страниц

_Эта функция будет добавлена в следующем обновлении_

Пока используйте ручное обновление страниц
  `;

  await ctx.replyWithMarkdown(message, pagesUpdateKeyboard);
}

// 🎯 НАСТРОЙКА ДЖУЗОВ В ДЕНЬ
async function showJuzPerDayMenu(ctx) {
  const user = ctx.user;

  const message = `
🎯 *Джузов в день*

Текущее значение: *${user.juzPerDay}* джуз${
    user.juzPerDay > 1 ? "а" : ""
  } в день

Это примерно *${user.juzPerDay * PAGES_IN_JUZ}* страниц ежедневно.

*Рекомендации:*
• 1 джуз (20 стр.) — стандартный темп
• 2 джуза (40 стр.) — активное повторение
• 3+ джуза — для опытных хафизов

Выберите новое значение:
  `;

  await ctx.replyWithMarkdown(message, juzCountKeyboard);
}

async function setJuzPerDay(ctx, text) {
  try {
    const juzPerDay = parseInt(text);

    if (!isNaN(juzPerDay) && juzPerDay >= 1 && juzPerDay <= 5) {
      const user = ctx.user;
      const previousJuzPerDay = user.juzPerDay;

      // Сохраняем действие
      await saveUserAction(user.telegramId, {
        actionType: "SET_JUZ_PER_DAY",
        previousValue: previousJuzPerDay,
        newValue: juzPerDay,
      });

      user.juzPerDay = juzPerDay;
      user.lastPlanDate = null;
      await user.save();

      const message = `
✅ *Обновлено!*

Теперь вы будете повторять *${juzPerDay}* джуз${
        juzPerDay > 1 ? "а" : ""
      } в день.

Это примерно *${juzPerDay * PAGES_IN_JUZ}* страниц ежедневно.

📅 *План на сегодня будет пересчитан.*

↩️ Можно отменить действие.
      `;

      await ctx.replyWithMarkdown(message, settingsKeyboard);
    }
  } catch (error) {
    console.error("Ошибка в setJuzPerDay:", error);
    await ctx.reply("❌ Не удалось обновить настройки.", settingsKeyboard);
  }
}

// 📚 УПРАВЛЕНИЕ ДОПОЛНИТЕЛЬНЫМИ ДЖУЗАМИ
async function showExtraJuzMenu(ctx) {
  const user = ctx.user;
  const extraJuzList = getExtraJuzList(user.extraJuzList);

  let message = `📚 *Дополнительные джузы*\n\n`;

  if (extraJuzList.length > 0) {
    message += `*Текущие джузы:* ${extraJuzList.join(", ")}\n\n`;
    message += `Всего: ${extraJuzList.length} джуз${
      extraJuzList.length > 1 ? "ов" : ""
    }\n\n`;
  } else {
    message += `*Дополнительных джузов пока нет*\n\n`;
  }

  message += `Дополнительные джузы — это те, которые вы хотите повторять чаще других.\n\nВыберите действие:`;

  await ctx.replyWithMarkdown(message, juzManageKeyboard);
}

async function askForExtraJuzAdd(ctx) {
  try {
    const user = ctx.user;
    const extraJuzList = getExtraJuzList(user.extraJuzList);

    let message = `➕ *Добавить джузы*\n\n`;

    if (extraJuzList.length > 0) {
      message += `Текущие: ${extraJuzList.join(", ")}\n\n`;
    }

    message += `Введите номера джузов (1-30):\n\n`;
    message += `*Примеры:*\n`;
    message += `• 5\n`;
    message += `• 5, 10, 15\n`;
    message += `• 1 2 3\n\n`;
    message += `_Используйте "⚙️ Назад в настройки" для отмены_`;

    if (!ctx.session) ctx.session = {};
    ctx.session.awaitingExtraJuzAdd = true;

    await ctx.replyWithMarkdown(
      message,
      Markup.keyboard([["⚙️ Назад в настройки"]]).resize()
    );
  } catch (error) {
    console.error("Ошибка в askForExtraJuzAdd:", error);
    await ctx.reply("❌ Произошла ошибка.", juzManageKeyboard);
  }
}

async function askForExtraJuzRemove(ctx) {
  try {
    const user = ctx.user;
    const extraJuzList = getExtraJuzList(user.extraJuzList);

    if (extraJuzList.length === 0) {
      await ctx.reply(
        "❌ *Нет джузов для удаления*\n\nСначала добавьте джузы.",
        juzManageKeyboard
      );
      return;
    }

    const message = `
🗑️ *Удалить джузы*

Текущие джузы: ${extraJuzList.join(", ")}

Введите номера джузов для удаления:

*Пример:* 5, 10, 15

_Используйте "⚙️ Назад в настройки" для отмены_
    `;

    if (!ctx.session) ctx.session = {};
    ctx.session.awaitingExtraJuzRemove = true;

    await ctx.replyWithMarkdown(
      message,
      Markup.keyboard([["⚙️ Назад в настройки"]]).resize()
    );
  } catch (error) {
    console.error("Ошибка в askForExtraJuzRemove:", error);
    await ctx.reply("❌ Произошла ошибка.", juzManageKeyboard);
  }
}

async function showExtraJuzList(ctx) {
  try {
    const user = ctx.user;
    const extraJuzList = getExtraJuzList(user.extraJuzList);

    if (extraJuzList.length === 0) {
      await ctx.reply(
        "📋 *Список пуст*\n\nДополнительных джузов пока нет.",
        juzManageKeyboard
      );
      return;
    }

    const message = `
📋 *Ваши дополнительные джузы*

${extraJuzList.map((juz) => `• Джуз ${juz}`).join("\n")}

*Всего:* ${extraJuzList.length} джуз${extraJuzList.length > 1 ? "ов" : ""}

Эти джузы будут включаться в план повторения наравне с выученными.
    `;

    await ctx.replyWithMarkdown(message, juzManageKeyboard);
  } catch (error) {
    console.error("Ошибка в showExtraJuzList:", error);
    await ctx.reply("❌ Произошла ошибка.", juzManageKeyboard);
  }
}

async function addExtraJuz(ctx, text) {
  try {
    const user = ctx.user;
    const existingJuzList = getExtraJuzList(user.extraJuzList);

    // Обрабатываем разные форматы
    const juzArray = text
      .split(/[,\s]+/)
      .map((item) => parseInt(item.trim()))
      .filter((juz) => !isNaN(juz) && juz >= 1 && juz <= 30);

    if (juzArray.length === 0) {
      await ctx.reply(
        "❌ *Неверный формат*\n\nВведите номера от 1 до 30.",
        Markup.removeKeyboard()
      );
      return;
    }

    const newJuzList = [...new Set([...existingJuzList, ...juzArray])].sort(
      (a, b) => a - b
    );

    if (newJuzList.length === existingJuzList.length) {
      await ctx.reply("ℹ️ *Эти джузы уже добавлены*", juzManageKeyboard);
      if (ctx.session) ctx.session.awaitingExtraJuzAdd = false;
      return;
    }

    // Сохраняем действие
    await saveUserAction(user.telegramId, {
      actionType: "ADD_EXTRA_JUZ",
      previousExtraJuzList: user.extraJuzList,
      newExtraJuzList: saveExtraJuzList(newJuzList),
    });

    user.extraJuzList = saveExtraJuzList(newJuzList);
    user.lastPlanDate = null;
    await user.save();

    if (ctx.session) ctx.session.awaitingExtraJuzAdd = false;

    const addedCount = newJuzList.length - existingJuzList.length;
    const addedJuz = juzArray.filter((juz) => !existingJuzList.includes(juz));

    const message = `
✅ *Добавлено ${addedCount} джуз${addedCount > 1 ? "ов" : ""}*

Новые джузы: ${addedJuz.join(", ")}

*Всего джузов:* ${newJuzList.join(", ")}

📅 *План на сегодня будет обновлен*

↩️ Можно отменить действие.
    `;

    await ctx.replyWithMarkdown(message, juzManageKeyboard);
  } catch (error) {
    console.error("Ошибка в addExtraJuz:", error);
    await ctx.reply("❌ Не удалось добавить джузы.", juzManageKeyboard);
  }
}

async function removeExtraJuzNumbers(ctx, text) {
  try {
    const user = ctx.user;
    const existingJuzList = getExtraJuzList(user.extraJuzList);

    const juzToRemove = text
      .split(/[,\s]+/)
      .map((item) => parseInt(item.trim()))
      .filter((juz) => !isNaN(juz) && juz >= 1 && juz <= 30);

    if (juzToRemove.length === 0) {
      await ctx.reply(
        "❌ *Неверный формат*\n\nВведите номера от 1 до 30.",
        juzManageKeyboard
      );
      return;
    }

    const newJuzList = existingJuzList.filter(
      (juz) => !juzToRemove.includes(juz)
    );

    if (newJuzList.length === existingJuzList.length) {
      await ctx.reply("ℹ️ *Этих джузов нет в списке*", juzManageKeyboard);
      return;
    }

    // Сохраняем действие
    await saveUserAction(user.telegramId, {
      actionType: "REMOVE_EXTRA_JUZ",
      previousExtraJuzList: user.extraJuzList,
      newExtraJuzList: saveExtraJuzList(newJuzList),
    });

    user.extraJuzList = saveExtraJuzList(newJuzList);
    user.lastPlanDate = null;
    await user.save();

    if (ctx.session) ctx.session.awaitingExtraJuzRemove = false;

    const removedCount = existingJuzList.length - newJuzList.length;
    let message = `✅ *Удалено ${removedCount} джуз${
      removedCount > 1 ? "ов" : ""
    }*`;

    if (newJuzList.length > 0) {
      message += `\n\n*Остались:* ${newJuzList.join(", ")}`;
    } else {
      message += `\n\n*Список очищен*`;
    }

    message += `\n\n📅 *План на сегодня будет обновлен*\n\n↩️ Можно отменить действие.`;

    await ctx.replyWithMarkdown(message, juzManageKeyboard);
  } catch (error) {
    console.error("Ошибка в removeExtraJuzNumbers:", error);
    await ctx.reply("❌ Не удалось удалить джузы.", juzManageKeyboard);
  }
}

async function clearAllExtraJuz(ctx) {
  try {
    const user = ctx.user;

    // Сохраняем действие
    await saveUserAction(user.telegramId, {
      actionType: "CLEAR_EXTRA_JUZ",
      previousExtraJuzList: user.extraJuzList,
      newExtraJuzList: "[]",
    });

    user.extraJuzList = "[]";
    user.lastPlanDate = null;
    await user.save();

    const message = `
✅ *Все дополнительные джузы удалены*

📅 *План на сегодня будет пересчитан.*

↩️ Можно отменить действие.
    `;

    await ctx.replyWithMarkdown(message, juzManageKeyboard);
  } catch (error) {
    console.error("Ошибка в clearAllExtraJuz:", error);
    await ctx.reply("❌ Не удалось очистить список.", juzManageKeyboard);
  }
}

// 🔄 ОБНОВЛЕНИЕ ВСЕГО
async function resetPlan(ctx) {
  try {
    const user = ctx.user;
    user.lastPlanDate = null; // Сбрасываем дату плана

    await user.save();

    const message = `
🔄 *Все параметры обновлены*

Теперь вы можете получить новый план на сегодня с учетом всех изменений.

Нажмите "📅 План на сегодня" в главном меню.
    `;

    await ctx.replyWithMarkdown(message, mainKeyboard);
  } catch (error) {
    console.error("Ошибка в resetPlan:", error);
    await ctx.reply("❌ Не удалось обновить параметры.", mainKeyboard);
  }
}

// 📤 ЭКСПОРТ СТАТИСТИКИ
async function exportStatistics(ctx) {
  try {
    const stats = await DailyStat.findAll({
      where: { userId: ctx.user.telegramId },
      order: [["date", "ASC"]],
    });

    if (stats.length === 0) {
      await ctx.reply(
        "❌ *Нет данных для экспорта*\n\nДобавьте несколько страниц для начала отслеживания.",
        statsKeyboard
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
      statsKeyboard
    );

    await ctx.reply(
      "✅ *Статистика экспортирована*\n\nФайл загружен.",
      statsKeyboard
    );
  } catch (error) {
    console.error("Ошибка в exportStatistics:", error);
    await ctx.reply("❌ Не удалось экспортировать статистику.", statsKeyboard);
  }
}

// 📝 ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
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
        settingsMenuOpen: false,
      });
    }

    return user;
  } catch (error) {
    console.error("Ошибка в getUser:", error);
    throw error;
  }
}

// 🕒 АВТОМАТИЧЕСКИЕ НАПОМИНАНИЯ
const cron = require("node-cron");

cron.schedule("0 8 * * *", async () => {
  try {
    console.log("Отправка ежедневных напоминаний...");

    const users = await User.findAll();
    console.log(`Найдено пользователей: ${users.length}`);

    for (const user of users) {
      try {
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
          '🕌 *Время для повторения Корана!*\n\nНажмите "📅 План на сегодня" для получения вашего дневного плана.',
          { parse_mode: "Markdown" }
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

    console.log("Напоминания отправлены");
  } catch (error) {
    console.error("Ошибка в cron задаче:", error);
  }
});

// 🚀 ЗАПУСК БОТА
bot.catch(async (err, ctx) => {
  console.error("Ошибка бота:", err);

  try {
    if (ctx && ctx.reply) {
      await ctx.reply(
        "❌ Произошла ошибка. Используйте /start для перезапуска"
      );
    }
  } catch (replyError) {
    console.error("Не удалось отправить сообщение об ошибке:", replyError);
  }
});

async function startBot() {
  try {
    await sequelize.sync({ alter: true });
    console.log("✅ База данных подключена");

    // Синхронизируем модель UserAction
    await UserAction.sync({ alter: true });
    console.log("✅ Модель истории действий синхронизирована");

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
