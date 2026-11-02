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
