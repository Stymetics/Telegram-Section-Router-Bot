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

// Extract valid image URLs from string or array
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

// Formats the initial Header message (Title & Product Code in UPPERCASE)
function formatHeaderMessage({ headline, productCode, productName, emoji }) {
  const safeHeadline = escapeHTML((headline || '').trim().toUpperCase());
  const safeProductCode = escapeHTML((productCode || '').trim().toUpperCase());
  const cleanEmoji = escapeHTML(emoji || '📌');

  const lines = [
    `<b>${cleanEmoji} ${safeHeadline} ${cleanEmoji}</b>`,
    ``,
  ];

  if (productName && productName.trim()) {
    const safeProductName = escapeHTML(productName.trim().toUpperCase());
    lines.push(`📦 <b>PRODUCT NAME:</b> <code>${safeProductName}</code>`);
  }

  lines.push(`🔖 <b>PRODUCT CODE:</b> <code>${safeProductCode}</code>`);

  return lines.join('\n');
}

// Formats an individual section message (Clean 1-click copyable block without repeated header)
function formatSectionMessage(sectionText) {
  const safeSection = escapeHTML((sectionText || '').trim());
  return `<pre>${safeSection}</pre>`;
}

module.exports = async (req, res) => {
  // Only allow POST requests from the frontend
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  try {
    const {
      password,
      imageUrls,
      imageLinks,
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
    if (!headline || !productCode || !bodyText) {
      return res.status(400).json({
        ok: false,
        error: 'Headline / Title, Product Code, and Body Sections are required.',
      });
    }

    const targetChatId = (customChatId || DEFAULT_CHAT_ID || '').trim();
    const targetTopicId = (customTopicId || DEFAULT_TOPIC_ID || '').trim();

    if (!targetChatId) {
      return res.status(400).json({
        ok: false,
        error: 'Target Chat ID is missing. Set TARGET_CHAT_ID in environment or enter it in settings.',
      });
    }

    // 3. Extract Images and Sections
    const images = extractImageUrls(imageUrls || imageLinks);

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

    // Prepare Telegram Send Options
    const sendOptions = {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };

    if (targetTopicId && !isNaN(Number(targetTopicId))) {
      sendOptions.message_thread_id = Number(targetTopicId);
    }

    // 4. STEP 1: Send Photo(s) First (if provided)
    if (images.length === 1) {
      try {
        await bot.telegram.sendPhoto(targetChatId, images[0], sendOptions);
        await sleep(350);
      } catch (imgErr) {
        console.error('Failed to send single photo:', imgErr);
        return res.status(400).json({
          ok: false,
          error: `Telegram could not load the image from URL: ${images[0]}. Error: ${imgErr.message}`,
        });
      }
    } else if (images.length > 1) {
      try {
        // Send in batches of 10 (Telegram media group limit)
        for (let i = 0; i < images.length; i += 10) {
          const chunk = images.slice(i, i + 10);
          if (chunk.length === 1) {
            await bot.telegram.sendPhoto(targetChatId, chunk[0], sendOptions);
          } else {
            await bot.telegram.sendMediaGroup(
              targetChatId,
              chunk.map((url) => ({ type: 'photo', media: url })),
              sendOptions
            );
          }
          await sleep(350);
        }
      } catch (imgErr) {
        console.error('Failed to send media group:', imgErr);
        return res.status(400).json({
          ok: false,
          error: `Telegram could not load image album. Error: ${imgErr.message}`,
        });
      }
    }

    // 5. STEP 2: Send Title and Product Code in UPPERCASE
    const headerHtml = formatHeaderMessage({
      headline,
      productCode,
      productName,
      emoji,
    });
    await bot.telegram.sendMessage(targetChatId, headerHtml, sendOptions);
    await sleep(350);

    // 6. STEP 3: Send Each Section Sequentially (Without repeating product code)
    let sentCount = 0;
    for (const sectionText of sections) {
      const sectionHtml = formatSectionMessage(sectionText);

      await bot.telegram.sendMessage(targetChatId, sectionHtml, sendOptions);
      sentCount++;

      // Wait 350ms between messages to guarantee order
      if (sentCount < sections.length) {
        await sleep(350);
      }
    }

    return res.status(200).json({
      ok: true,
      sentCount,
      imagesCount: images.length,
      message: `Dispatched successfully! ${images.length > 0 ? images.length + ' image(s), ' : ''}Title/Code header, and ${sentCount} section message(s) sent.`,
    });
  } catch (error) {
    console.error('Error sending messages from web dashboard:', error);
    return res.status(500).json({
      ok: false,
      error: error.response?.description || error.message || 'Failed to send messages to Telegram.',
    });
  }
};
