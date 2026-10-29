require('dotenv').config();
const { Telegraf } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DEFAULT_CHAT_ID = process.env.TARGET_CHAT_ID;
const DEFAULT_TOPIC_ID = process.env.TARGET_TOPIC_ID;

const bot = new Telegraf(BOT_TOKEN);

// Escape HTML characters so symbols like <, >, & never break Telegram formatting
function escapeHTML(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Delay helper to keep messages in order and avoid Telegram rate limits
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Formats a single section according to your strict rules
function formatSectionMessage({ headline, productName, productCode, sectionText, emoji }) {
  const safeHeadline = escapeHTML(headline.trim().toUpperCase());
  const safeProductName = escapeHTML(productName.trim());
  const safeProductCode = escapeHTML(productCode.trim());
  const safeSection = escapeHTML(sectionText.trim());
  const cleanEmoji = escapeHTML(emoji || '📌');

  return [
    `<b>${cleanEmoji} ${safeHeadline} ${cleanEmoji}</b>`,
    ``,
    `📦 <b>Product Name:</b> <code>${safeProductName}</code>`,
    `🔖 <b>Product Code:</b> <code>${safeProductCode}</code>`,
    ``,
    `<pre>${safeSection}</pre>`,
  ].join('\n');
}

module.exports = async (req, res) => {
  // Only allow POST requests from the frontend
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  try {
    const {
      password,
      headline,
      productName,
      productCode,
      bodyText,
      delimiter = process.env.SECTION_DELIMITER || '---',
      emoji = process.env.HEADLINE_EMOJI || '📌',
      customChatId,
      customTopicId,
    } = req.body || {};

    // 1. Check Admin Password
    if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid Admin Password! Please check your password and try again.',
      });
    }

    // 2. Validate Required Inputs
    if (!headline || !productName || !productCode || !bodyText) {
      return res.status(400).json({
        ok: false,
        error: 'Headline, Product Name, Product Code, and Body Sections are all required.',
      });
    }

    const targetChatId = (customChatId || DEFAULT_CHAT_ID || '').trim();
    const targetTopicId = (customTopicId || DEFAULT_TOPIC_ID || '').trim();

    if (!targetChatId) {
      return res.status(400).json({
        ok: false,
        error: 'Target Chat ID is missing. Set TARGET_CHAT_ID in Vercel or enter it in Advanced Settings.',
      });
    }

    // 3. Split Body into Sections
    const sections = bodyText
      .replace(/\r\n/g, '\n')
      .split(delimiter)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (sections.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'No valid sections found in the body text.',
      });
    }

    // 4. Send Each Section Sequentially
    let sentCount = 0;
    for (const sectionText of sections) {
      const htmlMessage = formatSectionMessage({
        headline,
        productName,
        productCode,
        sectionText,
        emoji,
      });

      const sendOptions = {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      };

      if (targetTopicId && !isNaN(Number(targetTopicId))) {
        sendOptions.message_thread_id = Number(targetTopicId);
      }

      await bot.telegram.sendMessage(targetChatId, htmlMessage, sendOptions);
      sentCount++;

      // Wait 350ms between messages to guarantee order
      if (sentCount < sections.length) {
        await sleep(350);
      }
    }

    return res.status(200).json({
      ok: true,
      sentCount,
      message: `Successfully sent ${sentCount} separate message(s) to your Telegram Topic!`,
    });
  } catch (error) {
    console.error('Error sending messages from web dashboard:', error);
    return res.status(500).json({
      ok: false,
      error: error.response?.description || error.message || 'Failed to send messages to Telegram.',
    });
  }
};
