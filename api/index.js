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
 * @param {string} text
 * @returns {string} Escaped HTML string
 */
function escapeHTML(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Helper to pause execution between API calls to respect Telegram rate limits
 * and guarantee strict chronological message ordering.
 * @param {number} ms Milliseconds to delay
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parses raw input text according to the 4-part line protocol.
 * @param {string} rawText
 * @param {string} delimiter
 */
function parseInputPayload(rawText, delimiter) {
  // Normalize Windows (\r\n) line endings to Unix (\n)
  const normalized = rawText.replace(/\r\n/g, '\n').trim();
  const lines = normalized.split('\n');

  if (lines.length < 4) {
    throw new Error(
      'Invalid input format. Your message must contain at least 4 lines:\n' +
      'Line 1: Headline\n' +
      'Line 2: Product Name\n' +
      'Line 3: Product Code\n' +
      'Line 4+: Body sections separated by "' + delimiter + '"'
    );
  }

  const headline = lines[0].trim();
  const productName = lines[1].trim();
  const productCode = lines[2].trim();

  if (!headline || !productName || !productCode) {
    throw new Error('Headline (Line 1), Product Name (Line 2), and Product Code (Line 3) cannot be empty.');
  }

  // Rejoin from Line 4 onwards to form the raw body
  const rawBody = lines.slice(3).join('\n');

  // Split by the custom delimiter and strip empty chunks
  const sections = rawBody
    .split(delimiter)
    .map((sec) => sec.trim())
    .filter((sec) => sec.length > 0);

  if (sections.length === 0) {
    throw new Error('No valid body content found from Line 4 onwards.');
  }

  return {
    headline,
    productName,
    productCode,
    sections,
  };
}

/**
 * Builds the formatted HTML message for an individual section.
 * - Headline: Bold + Uppercase + Emojis (Not in code block)
 * - Product Name & Code: Inline <code> (1-click copyable)
 * - Section Chunk: Block <pre> (1-click copyable code block)
 */
function formatSectionMessage({ headline, productName, productCode, sectionText, emoji }) {
  const safeHeadline = escapeHTML(headline.toUpperCase());
  const safeProductName = escapeHTML(productName);
  const safeProductCode = escapeHTML(productCode);
  const safeSection = escapeHTML(sectionText);

  return [
    `<b>${emoji} ${safeHeadline} ${emoji}</b>`,
    ``,
    `📦 <b>Product Name:</b> <code>${safeProductName}</code>`,
    `🔖 <b>Product Code:</b> <code>${safeProductCode}</code>`,
    ``,
    `<pre>${safeSection}</pre>`,
  ].join('\n');
}

// --- 3. MIDDLEWARE: SECURITY & ACCESS CONTROL ---

bot.use(async (ctx, next) => {
  // Ignore updates that don't originate from a user (e.g., channel posts)
  if (!ctx.from) return;

  const userId = String(ctx.from.id);

  if (!ALLOWED_USER_IDS.includes(userId)) {
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
    `Send me a text message following this exact structure:`,
    ``,
    `<pre>Headline / Title Here\nProduct Name Here\nPROD-CODE-123\nFirst section content goes here...\n${SECTION_DELIMITER}\nSecond section content goes here...\n${SECTION_DELIMITER}\nThird section content goes here...</pre>`,
    ``,
    `⚙️ <b>Active Configuration:</b>`,
    `• <b>Target Chat ID:</b> <code>${escapeHTML(TARGET_CHAT_ID)}</code>`,
    `• <b>Target Topic ID:</b> <code>${TARGET_TOPIC_ID || 'None (General)'}</code>`,
    `• <b>Delimiter:</b> <code>${escapeHTML(SECTION_DELIMITER)}</code>`,
  ].join('\n');

  await ctx.reply(welcomeMessage, { parse_mode: 'HTML' });
});

// Helper command to inspect current chat & topic IDs
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

// Main Text Processing Handler
bot.on('text', async (ctx) => {
  const rawText = ctx.message.text;

  // Ignore slash commands
  if (rawText.startsWith('/')) return;

  try {
    // 1. Parse Input
    const { headline, productName, productCode, sections } = parseInputPayload(
      rawText,
      SECTION_DELIMITER
    );

    const statusMsg = await ctx.reply(
      `⏳ Processing and routing <b>${sections.length}</b> section(s) to target group...`,
      { parse_mode: 'HTML' }
    );

    let sentCount = 0;

    // 2. Sequential Dispatch Loop (Maintains strict order and prevents 429 Too Many Requests)
    for (const sectionText of sections) {
      const formattedMessage = formatSectionMessage({
        headline,
        productName,
        productCode,
        sectionText,
        emoji: HEADLINE_EMOJI,
      });

      const sendOptions = {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      };

      // Attach Topic Thread ID if configured
      if (TARGET_TOPIC_ID) {
        sendOptions.message_thread_id = TARGET_TOPIC_ID;
      }

      await ctx.telegram.sendMessage(TARGET_CHAT_ID, formattedMessage, sendOptions);
      sentCount++;

      // Delay 350ms between messages if more remain
      if (sentCount < sections.length) {
        await sleep(350);
      }
    }

    // 3. Update status confirmation
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `✅ Successfully routed <b>${sentCount}</b> section(s) to the target supergroup topic!`,
      { parse_mode: 'HTML' }
    );
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
    // Handle POST requests from Telegram Webhook
    if (req.method === 'POST') {
      // Optional: Verify secret token header if configured
      if (WEBHOOK_SECRET) {
        const incomingSecret = req.headers['x-telegram-bot-api-secret-token'];
        if (incomingSecret !== WEBHOOK_SECRET) {
          console.warn('Rejected webhook request due to invalid secret token.');
          return res.status(401).json({ error: 'Unauthorized webhook request' });
        }
      }

      // Pass the update payload to Telegraf
      await bot.handleUpdate(req.body);
      return res.status(200).json({ ok: true });
    }

    // Health-check response for browser GET requests
    return res.status(200).json({
      status: 'online',
      service: 'Telegram Section Router Bot',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Webhook runtime error:', error);
    // Always return 200 to Telegram on internal errors so Telegram doesn't infinitely retry bad payloads
    return res.status(200).json({ ok: false, error: error.message });
  }
};
