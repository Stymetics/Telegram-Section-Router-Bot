require('dotenv').config();
const { Telegraf } = require('telegraf');

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
const DEFAULT_CHAT_ID = (process.env.TARGET_CHAT_ID || '').trim();
const DEFAULT_TOPIC_ID = (process.env.TARGET_TOPIC_ID || '').trim();

const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;

function escapeHTML(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Format Header Message - Title & Product Code in UPPERCASE
function formatHeaderMessage({ headline, productName, productCode, emoji = '📌' }) {
  const safeHeadline = escapeHTML((headline || '').trim().toUpperCase());
  const safeProductName = escapeHTML((productName || '').trim().toUpperCase());
  const safeProductCode = escapeHTML((productCode || '').trim().toUpperCase());
  const cleanEmoji = escapeHTML((emoji || '📌').trim());

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

// Format Section Message - Clean content, NO redundant product codes
function formatSectionMessage({ sectionText, sectionIndex, totalSections, showIndex = false }) {
  const safeSection = escapeHTML(sectionText.trim());
  if (showIndex && totalSections > 1) {
    return [
      `<b>[Part ${sectionIndex}/${totalSections}]</b>`,
      `<pre>${safeSection}</pre>`,
    ].join('\n');
  }
  return `<pre>${safeSection}</pre>`;
}

// Split text if it exceeds Telegram safe chunk limit (3900 chars)
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

// Send Photos (single or media group)
async function sendPhotos(botInstance, targetChatId, imageUrls, baseOptions) {
  if (!imageUrls || imageUrls.length === 0) return { count: 0, errors: [] };

  const errors = [];
  let sentCount = 0;

  if (imageUrls.length === 1) {
    try {
      await botInstance.telegram.sendPhoto(targetChatId, imageUrls[0], baseOptions);
      sentCount++;
    } catch (err) {
      console.error('Error sending single photo:', err.message);
      errors.push(`Image 1 failed: ${err.message}`);
    }
    return { count: sentCount, errors };
  }

  // Telegram sendMediaGroup takes 2-10 items per group
  for (let i = 0; i < imageUrls.length; i += 10) {
    const chunk = imageUrls.slice(i, i + 10);
    const media = chunk.map((url) => ({
      type: 'photo',
      media: url,
    }));

    try {
      await botInstance.telegram.sendMediaGroup(targetChatId, media, baseOptions);
      sentCount += chunk.length;
    } catch (groupErr) {
      console.warn('sendMediaGroup failed, fallback to individual sendPhoto:', groupErr.message);
      for (const url of chunk) {
        try {
          await botInstance.telegram.sendPhoto(targetChatId, url, baseOptions);
          sentCount++;
          await sleep(350);
        } catch (singleErr) {
          console.error(`Failed to send photo (${url}):`, singleErr.message);
          errors.push(`Image (${url}): ${singleErr.message}`);
        }
      }
    }
    if (i + 10 < imageUrls.length) {
      await sleep(400);
    }
  }

  return { count: sentCount, errors };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  try {
    const {
      action,
      password,
      headline,
      productName,
      productCode,
      imageUrls,
      bodyText,
      delimiter = process.env.SECTION_DELIMITER || '---',
      emoji = process.env.HEADLINE_EMOJI || '📌',
      customChatId,
      customTopicId,
      pinHeader = false,
      silent = false,
      showIndex = false,
    } = req.body || {};

    // ১. Vercel-এ ADMIN_PASSWORD সেট করা আছে কি না চেক করা
    if (!ADMIN_PASSWORD) {
      return res.status(500).json({
        ok: false,
        error: 'Vercel-এ ADMIN_PASSWORD খুঁজে পাওয়া যায়নি! Environment Variables-এ ADMIN_PASSWORD যোগ করে প্রজেক্টটি Redeploy করুন।',
      });
    }

    const incomingPassword = String(password || '').trim();

    // ২. পাসওয়ার্ড যাচাই (স্পেস বাদ দিয়ে)
    if (incomingPassword !== ADMIN_PASSWORD) {
      return res.status(401).json({
        ok: false,
        error: 'পাসওয়ার্ড ভুল হয়েছে! আপনার Vercel-এর ADMIN_PASSWORD-এর সাথে মিলছে না।',
      });
    }

    // ৩. যদি শুধু লগইন চেক করার রিকোয়েস্ট হয়, তবে এখানেই সাকসেস রিটার্ন করবে
    if (action === 'verify') {
      return res.status(200).json({
        ok: true,
        message: 'Login Successful!',
      });
    }

    // ৪. মেসেজ পাঠানোর মূল কাজ
    if (!bot) {
      return res.status(500).json({
        ok: false,
        error: 'Vercel-এ BOT_TOKEN সেট করা নেই!',
      });
    }

    if (!headline || !productCode || !bodyText) {
      return res.status(400).json({
        ok: false,
        error: 'Headline, Product Code, এবং Body পূরণ করা আবশ্যক।',
      });
    }

    const targetChatId = (customChatId || DEFAULT_CHAT_ID || '').trim();
    const targetTopicId = (customTopicId || DEFAULT_TOPIC_ID || '').trim();

    if (!targetChatId) {
      return res.status(400).json({
        ok: false,
        error: 'Target Chat ID পাওয়া যায়নি। Vercel-এ TARGET_CHAT_ID দিন অথবা ওয়েবসাইটের Advanced অপশনে লিখুন।',
      });
    }

    // ছবি লিঙ্ক ফিল্টার করা
    let parsedImages = [];
    if (Array.isArray(imageUrls)) {
      parsedImages = imageUrls
        .map((u) => String(u || '').trim())
        .filter((u) => u.startsWith('http://') || u.startsWith('https://'));
    } else if (typeof imageUrls === 'string' && imageUrls.trim().length > 0) {
      parsedImages = imageUrls
        .split(/[\n,]+/)
        .map((u) => u.trim())
        .filter((u) => u.startsWith('http://') || u.startsWith('https://'));
    }

    // বডি টেক্সট সেকশনে ভাগ করা
    const rawSections = bodyText
      .replace(/\r\n/g, '\n')
      .split(delimiter)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (rawSections.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'Body-তে কোনো টেক্সট পাওয়া যায়নি।',
      });
    }

    // যদি কোনো সেকশন ৩৯০০ অক্ষরের বেশি হয়, স্বয়ংক্রিয়ভাবে ছোট চাঙ্কে ভাগ করা
    const sections = [];
    for (const sec of rawSections) {
      const chunks = chunkText(sec, 3900);
      sections.push(...chunks);
    }

    const baseOptions = {};
    if (targetTopicId && !isNaN(Number(targetTopicId))) {
      baseOptions.message_thread_id = Number(targetTopicId);
    }
    if (silent) {
      baseOptions.disable_notification = true;
    }

    // ধাপ ১: সবার প্রথমে ছবি পাঠানো (যদি লিঙ্ক দেওয়া থাকে)
    let photosSent = 0;
    let photoErrors = [];
    if (parsedImages.length > 0) {
      const imgResult = await sendPhotos(bot, targetChatId, parsedImages, baseOptions);
      photosSent = imgResult.count;
      photoErrors = imgResult.errors;
      await sleep(400);
    }

    // ধাপ ২: আপার কেসে টাইটেল এবং প্রোডাক্ট কোড সহ হেডার মেসেজ পাঠানো
    const headerHtml = formatHeaderMessage({
      headline,
      productName,
      productCode,
      emoji,
    });

    const headerOptions = {
      ...baseOptions,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };

    const headerMsg = await bot.telegram.sendMessage(targetChatId, headerHtml, headerOptions);

    // হেডার পিন করার অপশন থাকলে পিন করা
    if (pinHeader && headerMsg?.message_id) {
      try {
        await bot.telegram.pinChatMessage(targetChatId, headerMsg.message_id, {
          disable_notification: true,
        });
      } catch (pinErr) {
        console.warn('Pin chat message warning:', pinErr.message);
      }
    }

    await sleep(350);

    // ধাপ ৩: মেসেজগুলো আলাদা আলাদা করে পাঠানো (উপরে কোনো প্রোডাক্ট কোড বা টাইটেল থাকবে না)
    let sentCount = 0;
    for (let i = 0; i < sections.length; i++) {
      const sectionText = sections[i];
      const sectionHtml = formatSectionMessage({
        sectionText,
        sectionIndex: i + 1,
        totalSections: sections.length,
        showIndex,
      });

      const sectionOptions = {
        ...baseOptions,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      };

      await bot.telegram.sendMessage(targetChatId, sectionHtml, sectionOptions);
      sentCount++;

      if (sentCount < sections.length) {
        await sleep(350);
      }
    }

    let summary = 'সফলভাবে ';
    if (photosSent > 0) summary += `${photosSent}টি ছবি, `;
    summary += `১টি হেডার এবং ${sentCount}টি সেকশন মেসেজ টেলিগ্রামে পাঠানো হয়েছে!`;
    if (photoErrors.length > 0) {
      summary += ` (${photoErrors.length}টি ছবির লিঙ্ক লোড করা যায়নি)`;
    }

    return res.status(200).json({
      ok: true,
      photosSent,
      sentCount,
      photoErrors,
      message: summary,
    });
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      ok: false,
      error: error.response?.description || error.message || 'টেলিগ্রামে মেসেজ পাঠাতে সমস্যা হয়েছে।',
    });
  }
};
