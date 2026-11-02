require('dotenv').config();
const { Telegraf } = require('telegraf');

// --- 1. ENVIRONMENT & CONFIGURATION ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const TARGET_CHAT_ID = process.env.TARGET_CHAT_ID;
const TARGET_TOPIC_ID = process.env.TARGET_TOPIC_ID ? Number(process.env.TARGET_TOPIC_ID) : undefined;
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const SECTION_DELIMITER = process.env.SECTION_DELIMITER || '---';
const HEADLINE_EMOJI = process.env.HEADLINE_EMOJI || '📌';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!BOT_TOKEN || !TARGET_CHAT_ID) {
  console.error('CRITICAL ERROR: BOT_TOKEN and TARGET_CHAT_ID must be defined in environment variables.');
}

const bot = new Telegraf(BOT_TOKEN);

// --- 2. UTILITY FUNCTIONS ---

/**
 * Escapes special HTML characters so user input never breaks Telegram HTML parse_mode.
 */
function escapeHTML(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Helper to pause execution between API calls to respect Telegram rate limits
 * and guarantee strict chronological message ordering.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Extracts image URLs from raw string or array.
 */
function extractImageUrls(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map((s) => String(s).trim()).filter(Boolean);
  }
  return String(input)
    .replace(/\r\n/g, '\n')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((part) => part.split(/\s+/).map((s) => s.trim()).filter(Boolean))
    .map((url) => url.replace(/^(image|img):\s*/i, ''))
    .filter((url) => /^https?:\/\//i.test(url));
}

/**
 * Parses raw input text according to the new protocol:
 * Line 0 (Optional): Image URL(s)
 * Line 1: Title / Headline
 * Line 2: Product Code (or Product Name then Product Code)
 * Line 3+: Body sections separated by delimiter
 */
function parseInputPayload(rawText, delimiter) {
  const normalized = (rawText || '').replace(/\r\n/g, '\n').trim();
  const allLines = normalized.split('\n');

  let lineIdx = 0;
  const imageUrls = [];

  // 1. Detect leading lines that are Image URLs
  while (lineIdx < allLines.length) {
    const line = allLines[lineIdx].trim();
    if (!line) {
      lineIdx++;
      continue;
    }
    const words = line.split(/[\s,]+/).map((w) => w.trim()).filter(Boolean);
    const isUrlLine =
      words.length > 0 &&
      words.every(
        (w) =>
          /^https?:\/\//i.test(w) ||
          /^image:/i.test(w) ||
          /^img:/i.test(w)
      );

    if (isUrlLine) {
      for (const w of words) {
        const cleanUrl = w.replace(/^(image|img):\s*/i, '');
        if (/^https?:\/\//i.test(cleanUrl)) {
          imageUrls.push(cleanUrl);
        }
      }
      lineIdx++;
    } else {
      break;
    }
  }

  // 2. Lines remaining for Title, Code and Sections
  const remainingLines = allLines.slice(lineIdx);
  const nonEmptyRemaining = remainingLines.filter((l) => l.trim().length > 0 || l.includes(delimiter));

  if (nonEmptyRemaining.length < 2) {
    throw new Error(
      'Invalid format. Please provide at least:\n' +
      '(Optional: Image URL(s) at the top)\n' +
      'Line 1: Title / Headline\n' +
      'Line 2: Product Code\n' +
      'Line 3+: Sections separated by "' + delimiter + '"'
    );
  }

  let title = nonEmptyRemaining[0].trim().replace(/^(title|headline|name|product\s*name):\s*/i, '');
  let productCode = '';
  let productName = '';
  let bodyStartIndex = 2;

  const line1 = nonEmptyRemaining[1].trim();

  // If user explicitly prefixed lines or provided 3 header lines (Title, Name, Code)
  if (/^(code|product\s*code|sku):\s*/i.test(line1)) {
    productCode = line1.replace(/^(code|product\s*code|sku):\s*/i, '');
    bodyStartIndex = 2;
  } else if (/^(name|product\s*name):\s*/i.test(line1)) {
    productName = line1.replace(/^(name|product\s*name):\s*/i, '');
    if (nonEmptyRemaining.length > 2) {
      productCode = nonEmptyRemaining[2].trim().replace(/^(code|product\s*code|sku):\s*/i, '');
      bodyStartIndex = 3;
    }
  } else {
    // Default standard format: Line 1 = Title, Line 2 = Product Code, Line 3+ = Body
    productCode = line1;
    bodyStartIndex = 2;
  }

  const rawBody = nonEmptyRemaining.slice(bodyStartIndex).join('\n');
  const sections = rawBody
    .split(delimiter)
    .map((sec) => sec.trim())
    .filter((sec) => sec.length > 0);

  if (sections.length === 0) {
    throw new Error('No valid body sections found. Separate sections with "' + delimiter + '".');
  }

  return {
    imageUrls,
    title,
    productName,
    productCode,
    sections,
  };
}

/**
 * Builds the initial Header HTML message (Title & Product Code in UPPERCASE).
 */
function formatHeaderMessage({ title, productCode, productName, emoji = HEADLINE_EMOJI }) {
  const safeTitle = escapeHTML((title || '').trim().toUpperCase());
  const safeProductCode = escapeHTML((productCode || '').trim().toUpperCase());
  const cleanEmoji = escapeHTML(emoji || '📌');

  const lines = [
    `<b>${cleanEmoji} ${safeTitle} ${cleanEmoji}</b>`,
    ``,
  ];

  if (productName && productName.trim()) {
    const safeProductName = escapeHTML(productName.trim().toUpperCase());
    lines.push(`📦 <b>PRODUCT NAME:</b> <code>${safeProductName}</code>`);
  }

  lines.push(`🔖 <b>PRODUCT CODE:</b> <code>${safeProductCode}</code>`);

  return lines.join('\n');
}

/**
 * Builds each individual section message (1-click copyable block, no repeated headers).
 */
function formatSectionMessage(sectionText) {
  const safeSection = escapeHTML((sectionText || '').trim());
  return `<pre>${safeSection}</pre>`;
}

// --- 3. MIDDLEWARE: SECURITY & ACCESS CONTROL ---

bot.use(async (ctx, next) => {
  if (!ctx.from) return;

  const userId = String(ctx.from.id);

  if (ALLOWED_USER_IDS.length > 0 && !ALLOWED_USER_IDS.includes(userId)) {
    console.warn(`Unauthorized access attempt from User ID: ${userId} (@${ctx.from.username || 'unknown'})`);
    await ctx.reply(
      `⛔ <b>Access Denied</b>\nYour Telegram User ID (<code>${userId}</code>) is not authorized to use this bot.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  return next();
});

// --- 4. BOT COMMANDS & HANDLERS ---

bot.start(async (ctx) => {
  const welcomeMessage = [
    `👋 <b>Welcome to the Section Router Bot!</b>`,
    ``,
    `Send me a message using this updated structure:`,
    ``,
    `<pre>https://example.com/photo.jpg (Optional photo URL)\nPRODUCT TITLE\nPROD-CODE-123\nFirst section content...\n${SECTION_DELIMITER}\nSecond section content...\n${SECTION_DELIMITER}\nThird section content...</pre>`,
    ``,
    `📤 <b>Dispatch Order:</b>`,
    `1️⃣ <b>Photo(s):</b> Sent directly as photo or album`,
    `2️⃣ <b>Header:</b> Title & Product Code in UPPERCASE`,
    `3️⃣ <b>Sections:</b> Sent one-by-one as clean copyable blocks (no repeated headers)`,
    ``,
    `⚙️ <b>Active Config:</b>`,
    `• Target Chat: <code>${escapeHTML(TARGET_CHAT_ID)}</code>`,
    `• Target Topic: <code>${TARGET_TOPIC_ID || 'General'}</code>`,
    `• Delimiter: <code>${escapeHTML(SECTION_DELIMITER)}</code>`,
  ].join('\n');

  await ctx.reply(welcomeMessage, { parse_mode: 'HTML' });
});

bot.command('id', async (ctx) => {
  const chatId = ctx.chat.id;
  const topicId = ctx.message.message_thread_id || 'None (General / Not a Topic)';
  const userId = ctx.from.id;

  await ctx.reply(
    `🔍 <b>Diagnostic Info:</b>\n` +
    `• <b>Your User ID:</b> <code>${userId}</code>\n` +
    `• <b>Current Chat ID:</b> <code>${chatId}</code>\n` +
    `• <b>Current Topic ID:</b> <code>${topicId}</code>`,
    { parse_mode: 'HTML' }
  );
});

// Common dispatcher function
async function dispatchMessages({ ctx, imageUrls = [], directPhotoFileId = null, title, productName, productCode, sections }) {
  const sendOptions = {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  if (TARGET_TOPIC_ID) {
    sendOptions.message_thread_id = TARGET_TOPIC_ID;
  }

  const statusMsg = await ctx.reply(
    `⏳ Sending photo, uppercase header, and <b>${sections.length}</b> section(s)...`,
    { parse_mode: 'HTML' }
  );

  // 1. Send Direct Photo Attachment (if sent as a Telegram photo)
  if (directPhotoFileId) {
    await ctx.telegram.sendPhoto(TARGET_CHAT_ID, directPhotoFileId, sendOptions);
    await sleep(350);
  }
  // Or Send Photo(s) from Image URLs
  else if (imageUrls.length === 1) {
    await ctx.telegram.sendPhoto(TARGET_CHAT_ID, imageUrls[0], sendOptions);
    await sleep(350);
  } else if (imageUrls.length > 1) {
    for (let i = 0; i < imageUrls.length; i += 10) {
      const chunk = imageUrls.slice(i, i + 10);
      if (chunk.length === 1) {
        await ctx.telegram.sendPhoto(TARGET_CHAT_ID, chunk[0], sendOptions);
      } else {
        await ctx.telegram.sendMediaGroup(
          TARGET_CHAT_ID,
          chunk.map((url) => ({ type: 'photo', media: url })),
          sendOptions
        );
      }
      await sleep(350);
    }
  }

  // 2. Send Title & Product Code (UPPERCASE)
  const headerHtml = formatHeaderMessage({
    title,
    productCode,
    productName,
    emoji: HEADLINE_EMOJI,
  });
  await ctx.telegram.sendMessage(TARGET_CHAT_ID, headerHtml, sendOptions);
  await sleep(350);

  // 3. Send Section Messages One-by-One
  let sentCount = 0;
  for (const sectionText of sections) {
    const sectionHtml = formatSectionMessage(sectionText);
    await ctx.telegram.sendMessage(TARGET_CHAT_ID, sectionHtml, sendOptions);
    sentCount++;

    if (sentCount < sections.length) {
      await sleep(350);
    }
  }

  // Confirmation
  const hasPhotos = directPhotoFileId || imageUrls.length > 0;
  await ctx.telegram.editMessageText(
    ctx.chat.id,
    statusMsg.message_id,
    undefined,
    `✅ Successfully routed ${hasPhotos ? 'photo(s), ' : ''}header, and <b>${sentCount}</b> section(s) to the target topic!`,
    { parse_mode: 'HTML' }
  );
}

// Handler for Direct Photo Messages (e.g. user sends a photo with caption)
bot.on('photo', async (ctx) => {
  const caption = ctx.message.caption;
  if (!caption) {
    await ctx.reply('⚠️ Please provide the text with Title, Product Code, and sections in the photo caption.');
    return;
  }

  try {
    const photoSizes = ctx.message.photo;
    const fileId = photoSizes[photoSizes.length - 1].file_id;

    const parsed = parseInputPayload(caption, SECTION_DELIMITER);
    await dispatchMessages({
      ctx,
      directPhotoFileId: fileId,
      imageUrls: parsed.imageUrls,
      title: parsed.title,
      productName: parsed.productName,
      productCode: parsed.productCode,
      sections: parsed.sections,
    });
  } catch (error) {
    console.error('Error processing photo message:', error);
    await ctx.reply(`❌ <b>Failed:</b>\n<code>${escapeHTML(error.message)}</code>`, { parse_mode: 'HTML' });
  }
});

// Main Text Processing Handler
bot.on('text', async (ctx) => {
  const rawText = ctx.message.text;
  if (rawText.startsWith('/')) return;

  try {
    const parsed = parseInputPayload(rawText, SECTION_DELIMITER);
    await dispatchMessages({
      ctx,
      imageUrls: parsed.imageUrls,
      title: parsed.title,
      productName: parsed.productName,
      productCode: parsed.productCode,
      sections: parsed.sections,
    });
  } catch (error) {
    console.error('Error processing message:', error);
    await ctx.reply(
      `❌ <b>Processing Failed:</b>\n<code>${escapeHTML(error.message)}</code>`,
      { parse_mode: 'HTML' }
    );
  }
});

// --- 5. VERCEL SERVERLESS WEBHOOK HANDLER ---

module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      if (WEBHOOK_SECRET) {
        const incomingSecret = req.headers['x-telegram-bot-api-secret-token'];
        if (incomingSecret !== WEBHOOK_SECRET) {
          console.warn('Rejected webhook request due to invalid secret token.');
          return res.status(401).json({ error: 'Unauthorized webhook request' });
        }
      }

      await bot.handleUpdate(req.body);
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({
      status: 'online',
      service: 'Telegram Section Router Bot',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Webhook runtime error:', error);
    return res.status(200).json({ ok: false, error: error.message });
  }
};
