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
