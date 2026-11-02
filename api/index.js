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

const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Splits text into safe chunks (<= 3900 chars) if needed
 */
function chunkText(text, maxLen = 3900) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx <= 0) splitIdx = maxLen;
    chunks.push(remaining.substring(0, splitIdx).trim());
    remaining = remaining.substring(splitIdx).trim();
  }
  return chunks;
}

/**
 * Parses raw input text according to the protocol:
 * Line 1: Headline
 * Line 2: Product Name
 * Line 3: Product Code
 * Line 4: (Optional) Image Link(s) or start of body sections
 * Line 5+: Body sections separated by delimiter
 */
function parseInputPayload(rawText, delimiter, directPhotoId = null) {
  const normalized = rawText.replace(/\r\n/g, '\n').trim();
  const lines = normalized.split('\n');

  if (lines.length < 3) {
    throw new Error(
      'Invalid input format. Your message must contain:\n' +
      'Line 1: Headline\n' +
      'Line 2: Product Name\n' +
      'Line 3: Product Code\n' +
      'Line 4+: Body sections separated by "' + delimiter + '"\n' +
      '(Optional: Line 4 can be Image URL(s) or attach photos directly)'
    );
  }

  const headline = lines[0].trim();
  const productName = (lines[1] || '').trim();
  const productCode = (lines[2] || '').trim();

  if (!headline || !productCode) {
    throw new Error('Headline (Line 1) and Product Code (Line 3) cannot be empty.');
  }

  let imageUrls = [];
  if (directPhotoId) {
    imageUrls.push(directPhotoId);
  }

  let bodyStartIndex = 3;

  // Check if Line 4 contains image links
  if (lines.length > 3) {
    const line4 = lines[3].trim();
    if (
      line4.startsWith('http://') ||
      line4.startsWith('https://') ||
      line4.toLowerCase().startsWith('img:') ||
      line4.toLowerCase().startsWith('image:')
    ) {
      const cleanLine = line4.replace(/^img:|^image:/i, '').trim();
      const extractedUrls = cleanLine
        .split(/[\s,]+/)
        .map((u) => u.trim())
        .filter((u) => u.startsWith('http://') || u.startsWith('https://'));
      if (extractedUrls.length > 0) {
        imageUrls.push(...extractedUrls);
        bodyStartIndex = 4;
      }
    }
  }

  const rawBody = lines.slice(bodyStartIndex).join('\n');
  const rawSections = rawBody
    .split(delimiter)
    .map((sec) => sec.trim())
    .filter((sec) => sec.length > 0);

  if (rawSections.length === 0) {
    throw new Error('No valid body content found for sections.');
  }

  const sections = [];
  for (const s of rawSections) {
    sections.push(...chunkText(s, 3900));
  }

  return {
    headline,
    productName,
    productCode,
    imageUrls,
    sections,
  };
}

/**
 * Builds the UPPERCASE Header message (Title, Product Name, Product Code)
 */
function formatHeaderMessage({ headline, productName, productCode, emoji }) {
  const safeHeadline = escapeHTML((headline || '').toUpperCase());
  const safeProductName = escapeHTML((productName || '').toUpperCase());
  const safeProductCode = escapeHTML((productCode || '').toUpperCase());
  const cleanEmoji = escapeHTML(emoji || '📌');

  const lines = [
    `<b>${cleanEmoji} ${safeHeadline} ${cleanEmoji}</b>`,
    ``,
  ];

  if (safeProductName) {
    lines.push(`📦 <b>PRODUCT NAME:</b> <code>${safeProductName}</code>`);
  }
  if (safeProductCode) {
    lines.push(`🔖 <b>PRODUCT CODE:</b> <code>${safeProductCode}</code>`);
  }

  return lines.join('\n');
}

/**
 * Builds clean section message (No duplicate product codes or headlines)
 */
function formatSectionMessage({ sectionText }) {
  const safeSection = escapeHTML(sectionText);
  return `<pre>${safeSection}</pre>`;
}

// --- 3. MIDDLEWARE & HANDLERS ---

if (bot) {
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

  bot.start(async (ctx) => {
    const welcomeMessage = [
      `👋 <b>Welcome to the Section Router Bot!</b>`,
      ``,
      `Send me a text message or a photo with a caption using this structure:`,
      ``,
      `<pre>Line 1: Headline / Title\nLine 2: Product Name\nLine 3: Product Code\nLine 4: (Optional) Image Link\nLine 5+: Body sections separated by "${SECTION_DELIMITER}"</pre>`,
      ``,
      `🚀 <b>New Dispatch Sequence:</b>`,
      `1️⃣ <b>Photos:</b> Directly posted first`,
      `2️⃣ <b>Header:</b> UPPERCASE Title & Product Code posted second`,
      `3️⃣ <b>Sections:</b> Clean 1-click copyable blocks posted one-by-one (no repetitive product codes)`,
      ``,
      `⚙️ <b>Target Destination:</b>`,
      `• Chat ID: <code>${escapeHTML(TARGET_CHAT_ID)}</code>`,
      `• Topic ID: <code>${TARGET_TOPIC_ID || 'General'}</code>`,
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

// Universal Dispatch Handler for both Text and Photo messages
async function handleIncomingDispatch(ctx) {
  let rawText = '';
  let directPhotoId = null;

  if (ctx.message.photo) {
    const photos = ctx.message.photo;
    directPhotoId = photos[photos.length - 1].file_id;
    rawText = ctx.message.caption || '';
  } else if (ctx.message.text) {
    rawText = ctx.message.text;
    if (rawText.startsWith('/')) return;
  }

  if (!rawText.trim()) {
    await ctx.reply('⚠️ Please provide the text payload (Headline, Product Name, Code, and Body sections).');
    return;
  }

  try {
    const { headline, productName, productCode, imageUrls, sections } = parseInputPayload(
      rawText,
      SECTION_DELIMITER,
      directPhotoId
    );

    const statusMsg = await ctx.reply(
      `⏳ Dispatching: <b>${imageUrls.length}</b> photo(s), <b>1</b> header, and <b>${sections.length}</b> section(s)...`,
      { parse_mode: 'HTML' }
    );

    const sendOptions = {
      disable_web_page_preview: true,
    };
    if (TARGET_TOPIC_ID) {
      sendOptions.message_thread_id = TARGET_TOPIC_ID;
    }

    // 1. Send Photos First
    let photosSent = 0;
    if (imageUrls.length > 0) {
      for (const img of imageUrls) {
        try {
          await ctx.telegram.sendPhoto(TARGET_CHAT_ID, img, sendOptions);
          photosSent++;
          await sleep(350);
        } catch (imgErr) {
          console.error('Failed to send photo in bot:', imgErr.message);
        }
      }
    }

    // 2. Send Uppercase Header
    const headerHtml = formatHeaderMessage({
      headline,
      productName,
      productCode,
      emoji: HEADLINE_EMOJI,
    });
    await ctx.telegram.sendMessage(TARGET_CHAT_ID, headerHtml, {
      ...sendOptions,
      parse_mode: 'HTML',
    });
    await sleep(350);

    // 3. Send Clean Individual Section Messages
    let sentCount = 0;
    for (const sectionText of sections) {
      const formattedMessage = formatSectionMessage({ sectionText });
      await ctx.telegram.sendMessage(TARGET_CHAT_ID, formattedMessage, {
        ...sendOptions,
        parse_mode: 'HTML',
      });
      sentCount++;

      if (sentCount < sections.length) {
        await sleep(350);
      }
    }

    // 4. Update status confirmation
    let summaryText = `✅ Successfully routed `;
    if (photosSent > 0) summaryText += `<b>${photosSent}</b> photo(s), `;
    summaryText += `<b>1</b> UPPERCASE header, and <b>${sentCount}</b> section(s) to the target topic!`;

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      summaryText,
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    console.error('Error processing message:', error);
    await ctx.reply(
      `❌ <b>Processing Failed:</b>\n<code>${escapeHTML(error.message)}</code>`,
      { parse_mode: 'HTML' }
    );
  }
}

  bot.on('text', handleIncomingDispatch);
  bot.on('photo', handleIncomingDispatch);
}

// --- 5. VERCEL SERVERLESS WEBHOOK HANDLER ---

module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      if (!bot) {
        return res.status(500).json({ error: 'BOT_TOKEN is not configured' });
      }
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
