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

function formatHref(url) {
  if (!url) return '';
  let trimmed = String(url).trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = 'https://' + trimmed;
  }
  return trimmed;
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
 * Line 3: Product Code (SKU)
 * Optional lines: Costing, Sale Price, Sources, Link, Image Link(s)
 * Remainder: Body sections separated by delimiter
 */
function parseInputPayload(rawText, delimiter, directPhotoId = null) {
  const normalized = rawText.replace(/\r\n/g, '\n').trim();
  const lines = normalized.split('\n');

  if (lines.length < 3) {
    throw new Error(
      'Invalid input format. Your message must contain:\n' +
      'Line 1: Headline\n' +
      'Line 2: Product Name\n' +
      'Line 3: Product Code (SKU)\n' +
      'Line 4+: Body sections separated by "' + delimiter + '"'
    );
  }

  const headline = lines[0].trim();
  const productName = (lines[1] || '').trim();
  const productCode = (lines[2] || '').trim();

  if (!headline || !productCode) {
    throw new Error('Headline (Line 1) and Product Code (Line 3) cannot be empty.');
  }

  let costing = '';
  let salePrice = '';
  let sources = '';
  let link = '';
  let imageUrls = [];

  if (directPhotoId) {
    imageUrls.push(directPhotoId);
  }

  let bodyStartIndex = 3;

  // Check subsequent lines for optional metadata prefixes or links before body delimiter
  for (let i = 3; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === delimiter) {
      break;
    }
    const lower = line.toLowerCase();
    if (lower.startsWith('cost:') || lower.startsWith('costing:')) {
      costing = line.replace(/^cost:|^costing:/i, '').trim();
      bodyStartIndex = i + 1;
    } else if (lower.startsWith('sale:') || lower.startsWith('price:') || lower.startsWith('sale price:')) {
      salePrice = line.replace(/^sale:|^price:|^sale price:/i, '').trim();
      bodyStartIndex = i + 1;
    } else if (lower.startsWith('source:') || lower.startsWith('sources:')) {
      sources = line.replace(/^source:|^sources:/i, '').trim();
      bodyStartIndex = i + 1;
    } else if (lower.startsWith('link:')) {
      link = line.replace(/^link:/i, '').trim();
      bodyStartIndex = i + 1;
    } else if (lower.startsWith('img:') || lower.startsWith('image:')) {
      const cleanLine = line.replace(/^img:|^image:/i, '').trim();
      const extractedUrls = cleanLine
        .split(/[\s,]+/)
        .map((u) => u.trim())
        .filter((u) => u.startsWith('http://') || u.startsWith('https://'));
      if (extractedUrls.length > 0) {
        imageUrls.push(...extractedUrls);
      }
      bodyStartIndex = i + 1;
    } else if (line.startsWith('http://') || line.startsWith('https://')) {
      // Direct URL on its own line: treat as image URL or link
      if (/\.(jpeg|jpg|gif|png|webp)/i.test(line)) {
        imageUrls.push(line);
      } else if (!link) {
        link = line;
      }
      bodyStartIndex = i + 1;
    } else {
      // Regular text: start of body sections
      break;
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
    costing,
    salePrice,
    sources,
    link,
    imageUrls,
    sections,
  };
}

/**
 * Builds the UPPERCASE Header message (Title, Product Name, SKU, Costing, Sale Price, Sources, Link)
 */
function formatHeaderMessage({
  headline,
  productName,
  productCode,
  costing,
  salePrice,
  sources,
  link,
  emoji,
}) {
  const safeHeadline = escapeHTML((headline || '').toUpperCase());
  const safeProductName = escapeHTML((productName || '').toUpperCase());
  const safeProductCode = escapeHTML((productCode || '').toUpperCase());
  const safeCosting = escapeHTML((costing || '').toUpperCase());
  const safeSalePrice = escapeHTML((salePrice || '').toUpperCase());
  const cleanEmoji = escapeHTML(emoji || '📌');

  const lines = [
    `<b>${cleanEmoji} ${safeHeadline} ${cleanEmoji}</b>`,
    ``,
  ];

  if (safeProductName) {
    lines.push(`📦 <b>PRODUCT NAME:</b> <code>${safeProductName}</code>`);
  }
  if (safeProductCode) {
    lines.push(`🔖 <b>SKU / CODE:</b> <code>${safeProductCode}</code>`);
  }
  if (safeCosting) {
    lines.push(`💵 <b>COSTING:</b> <code>${safeCosting}</code>`);
  }
  if (safeSalePrice) {
    lines.push(`🏷️ <b>SALE PRICE:</b> <code>${safeSalePrice}</code>`);
  }

  if (sources && sources.trim()) {
    const rawSource = sources.trim();
    const urlMatch = rawSource.match(/https?:\/\/[^\s]+/) || (rawSource.includes('.') ? [rawSource] : null);
    if (urlMatch) {
      const cleanUrl = escapeHTML(formatHref(urlMatch[0]));
      lines.push(`🔗 <b>SOURCE:</b> <a href="${cleanUrl}">Source</a>`);
    } else {
      lines.push(`🔗 <b>SOURCE:</b> <code>${escapeHTML(rawSource.toUpperCase())}</code>`);
    }
  }

  if (link && link.trim()) {
    const cleanUrl = escapeHTML(formatHref(link.trim()));
    lines.push(`🌐 <b>LINK:</b> <a href="${cleanUrl}">Link</a>`);
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
      `<pre>Line 1: Headline / Title\nLine 2: Product Name\nLine 3: Product Code (SKU)\nCost: 1200 BDT (Optional)\nSale: 1800 BDT (Optional)\nSource: https://... (Optional)\nLink: https://... (Optional)\nLine 4+: Body sections separated by "${SECTION_DELIMITER}"</pre>`,
      ``,
      `🚀 <b>Dispatch Sequence:</b>`,
      `1️⃣ <b>Photos:</b> Directly posted first`,
      `2️⃣ <b>Header:</b> UPPERCASE Title & Product Code, Costing, Sale Price, clickable Source & Link`,
      `3️⃣ <b>Sections:</b> Clean 1-click copyable blocks posted one-by-one`,
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
}

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
    const {
      headline,
      productName,
      productCode,
      costing,
      salePrice,
      sources,
      link,
      imageUrls,
      sections,
    } = parseInputPayload(rawText, SECTION_DELIMITER, directPhotoId);

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
      costing,
      salePrice,
      sources,
      link,
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

if (bot) {
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
