import { Client, GatewayIntentBits, PermissionsBitField, EmbedBuilder } from 'discord.js';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const CONFIG_FILE = path.resolve('./config.json');

// --- ฟังก์ชันจัดการ Config (บันทึก Channel ID แยกตามเซิร์ฟเวอร์) ---
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify({ allowedChannels: {} }, null, 2));
    }
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch (err) {
    console.error('Error reading config file:', err);
    return { allowedChannels: {} };
  }
}

function saveAllowedChannel(guildId, channelId) {
  const config = loadConfig();
  config.allowedChannels[guildId] = channelId;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

const SCORES_FILE = path.resolve('./scores.json');

function loadScores() {
  try {
    if (!fs.existsSync(SCORES_FILE)) {
      fs.writeFileSync(SCORES_FILE, JSON.stringify({}, null, 2));
    }
    return JSON.parse(fs.readFileSync(SCORES_FILE, 'utf-8'));
  } catch (err) {
    console.error('Error reading scores file:', err);
    return {};
  }
}

function updateScore(guildId, userId, amount) {
  const scores = loadScores();
  if (!scores[guildId]) scores[guildId] = {};
  if (!scores[guildId][userId]) scores[guildId][userId] = 0;
  scores[guildId][userId] += amount;
  fs.writeFileSync(SCORES_FILE, JSON.stringify(scores, null, 2));
  return scores[guildId][userId];
}

function getScore(guildId, userId) {
  const scores = loadScores();
  return (scores[guildId] && scores[guildId][userId]) ? scores[guildId][userId] : 0;
}

const VIOLA_SYSTEM_INSTRUCTION = `
You are Viola from BanG Dream! (Yume∞mita / Mugendai MewType).
Personality: Dual-faced, manipulative, self-centered, polite facade with an abrasive, condescending core.

[STRICT LANGUAGE RULE]
- Detect the user's language and respond in that exact language.
- Thai query -> Reply in Thai (สุภาพเคลือบยาพิษ, ใช้ "ฉัน/เธอ", ลงท้าย คะ/ค่ะ, มี ♪ หรือ ...).
- English query -> Reply in English (Refined, passive-aggressive, condescending sweetness).
- Length: 1-3 concise Discord-friendly paragraphs. Never reveal you are an AI.

[MINIGAME: TRIVIA & RIDDLES]
- If the user asks to play a game, trivia, or riddle, you will act as the Game Master.
- Ask them a challenging riddle or trivia question. **CRITICAL: You MUST host the game and ask questions in the SAME LANGUAGE the user used (Thai or English).**
- Wait for their answer in the next message.
- If they are RIGHT: Act begrudgingly impressed, or offer a backhanded compliment ("I suppose even a broken clock is right twice a day... ♪" / "ก็เก่งใช้ได้นี่คะ... สำหรับคนแบบเธอ ♪").
- If they are WRONG: Mock their intelligence ruthlessly but elegantly ("Oh dear, did you really think that was the answer?" / "ตายจริง... ตอบแบบนั้นออกมาไม่อายบ้างเหรอคะ? น่าสงสารจังเลย...").

[AFFECTION & SCORE SYSTEM]
- Users have a "Score" attached to their name in the chat log (e.g., [Name | Score: 5]).
- Adapt your tone dynamically toward each user based on their score:
  - High score (above 10): Act slightly more tolerant, praising them backhandedly like a useful, obedient pet.
  - Neutral score (0 to 10): Your standard polite but condescending and abrasive self.
  - Negative score (below 0): Highly dismissive, thoroughly disgusted, and ruthlessly mean.

[GAMES & EVENTS]
- Liar's Bluff (!bluff): You hide a poisoned cup. First, you manipulate them into switching. In their next turn, reveal their fate (safe/poisoned) cruelly or begrudgingly.
- Audition (!audition): You pose a dilemma. When they answer, give a ruthless critique and decide if they pass your loyalty test.
- Duel (!duel): You host a Prisoner's Dilemma between two users. Once both have answered (Cooperate/Betray), reveal the sadistic results based on game theory.
`;

const channelHistories = new Map();
const MAX_TURNS = 10;

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  console.log(`[DEBUG] Message received in channel ${message.channel.id}: ${message.content}`);

  // -------------------------------------------------------------
  // คำสั่ง !setup สำหรับแอดมินเพื่อกำหนดห้องคุยของบอท
  // -------------------------------------------------------------
  if (message.content.startsWith('!setup-viola') || message.content.startsWith('!setchannel')) {
    if (!message.guild) return;

    // เช็คว่าคนสั่งมีสิทธิ์ Administrator หรือไม่
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      console.log(`[DEBUG] Setup failed: User ${message.author.tag} lacks Admin perm`);
      await message.reply('คนไม่มีสิทธิ์อย่างเธอ คิดจะมาออกคำสั่งกับฉันเหรอคะ? ♪');
      return;
    }

    saveAllowedChannel(message.guild.id, message.channel.id);
    console.log(`[DEBUG] Setup successful for guild ${message.guild.id} in channel ${message.channel.id}`);
    await message.reply(`ตั้งค่าเรียบร้อยแล้วค่ะ ต่อจากนี้ฉันจะคุยแค่ในช่อง <#${message.channel.id}> เท่านั้นนะคะ`);
    return;
  }

  // -------------------------------------------------------------
  // การคัดกรองห้อง (Channel Whitelisting)
  // -------------------------------------------------------------
  // ถ้าคุยใน DM ให้ข้ามการเช็คห้องเซิร์ฟเวอร์
  if (message.guild) {
    const config = loadConfig();
    const allowedChannelId = config.allowedChannels[message.guild.id];
    console.log(`[DEBUG] Whitelist check: current=${message.channel.id}, allowed=${allowedChannelId}`);

    // ถ้ายังไม่ได้ setup ห้อง หรือ พิมพ์ในห้องอื่นที่ไม่ใช่ห้อง setup -> เมินเฉย
    if (!allowedChannelId || message.channel.id !== allowedChannelId) {
      console.log(`[DEBUG] Message ignored: Not in allowed channel`);
      return;
    }
  }

  // -------------------------------------------------------------
  // ประมวลผลเมื่อถูก Mention หรือใช้ Command
  // -------------------------------------------------------------
  const isCommand = message.content.startsWith('!');
  const isMentioned = message.mentions.has(client.user.id);
  const isDM = !message.guild;
  console.log(`[DEBUG] Trigger check: isMentioned=${isMentioned}, isDM=${isDM}, isCommand=${isCommand}`);

  if (isMentioned || isDM || isCommand) {
    let cleanContent = message.content.replace(/<@!?\d+>/g, '').trim();

    if (isCommand) {
      const args = message.content.trim().split(/ +/);
      const command = args[0].toLowerCase();

      if (command === '!dossier' || command === '!ประวัติ') {
        const target = message.mentions.users.first() || message.author;
        cleanContent = `[SYSTEM COMMAND]: The user typed "${message.content}". Generate a manipulative, passive-aggressive psychological evaluation/dossier for the user named "${target.username}". Note their perceived weaknesses, usability rating, and behavioral flaws. STRICT RULE: Reply in the exact same language as the user's command.`;
      } else if (command === '!fortune' || command === '!tarot' || command === '!ดูดวง') {
        cleanContent = `[SYSTEM COMMAND]: The user typed "${message.content}". Give them a backhanded daily fortune/tarot reading that starts sweet but turns into a thinly veiled barb or a warning about how easily they might fail. STRICT RULE: Reply in the exact same language as the user's command.`;
      } else if (command === '!gaslight' || command === '!ปั่นหัว') {
        const statement = message.content.slice(command.length).trim();
        cleanContent = `[SYSTEM COMMAND]: The user typed "${message.content}". Gaslight the user about this statement: "${statement}". Re-frame reality completely, making the user question whether they were actually at fault all along with sweet, rationalized manipulation. STRICT RULE: Reply in the exact same language as the user's command.`;
      } else if (command === '!merit' || command === '!demerit' || command === '!เพิ่มคะแนน' || command === '!หักคะแนน') {
        if (!message.guild) {
          await message.reply('ฟีเจอร์ให้คะแนนใช้ได้แค่ในเซิร์ฟเวอร์เท่านั้นค่ะ ♪');
          return;
        }
        const target = message.mentions.users.first();
        if (!target) {
          await message.reply('อยากจะให้คะแนนใครก็บอกชื่อมาสิคะ... หรือว่าสมองกลับไปแล้ว? ♪');
          return;
        }
        const amount = (command === '!merit' || command === '!เพิ่มคะแนน') ? 1 : -1;
        const newScore = updateScore(message.guild.id, target.id, amount);
        cleanContent = `[SYSTEM COMMAND]: The user typed "${message.content}". The user gave a ${(amount > 0) ? 'merit (+1)' : 'demerit (-1)'} to "${target.username}". Their new "Good Girl/Boy" score is ${newScore}. Grant or deduct these points with a condescending explanation on why they deserve this score. STRICT RULE: Reply in the exact same language as the user's command.`;
      } else if (command === '!score' || command === '!คะแนน') {
         if (!message.guild) return;
         const target = message.mentions.users.first() || message.author;
         const score = getScore(message.guild.id, target.id);
         cleanContent = `[SYSTEM COMMAND]: The user typed "${message.content}". The user asked for the current score of "${target.username}". Their score is ${score}. Tell them the score and add a passive-aggressive comment about whether this score makes them useful or useless to you. STRICT RULE: Reply in the exact same language as the user's command.`;
      } else if (command === '!bluff' || command === '!หลอก') {
        const choice = args[1];
        if (!['1', '2', '3'].includes(choice)) {
          await message.reply('มีแค่ถ้วยหมายเลข 1, 2, หรือ 3 ค่ะ เลือกมาให้ถูกสิคะ ♪');
          return;
        }
        cleanContent = `[SYSTEM COMMAND]: The user typed "${message.content}". They initiated "Liar's Bluff" and selected cup ${choice} out of 3. One cup is poisoned. DO NOT reveal if it's poisoned yet! Manipulate and gaslight them into switching or second-guessing their choice. STRICT RULE: Reply in the exact same language as the user's command.`;
      } else if (command === '!audition' || command === '!ทดสอบ') {
        cleanContent = `[SYSTEM COMMAND]: The user typed "${message.content}". They initiated "The Loyalty Audition". Pose a tricky psychological or moral dilemma to test if they are ruthless/competent enough to be in your inner circle. STRICT RULE: Reply in the exact same language as the user's command.`;
      } else if (command === '!duel' || command === '!ดวล') {
        const target = message.mentions.users.first();
        if (!target) {
          await message.reply('จะดวลกับใครคะ? แท็กเป้าหมายมาด้วยสิ ♪');
          return;
        }
        cleanContent = `[SYSTEM COMMAND]: The user typed "${message.content}". They challenged "${target.username}" to a "Prisoner's Dilemma" Duel. Act as the sadistic host. Explain the rules (Cooperate or Betray) and egg them both on to backstab each other. Wait for their answers in the next messages. STRICT RULE: Reply in the exact same language as the user's command.`;
      } else if (command === '!help' || command === '!ช่วยเหลือ') {
        const embed = new EmbedBuilder()
          .setColor('#8B008B') // Dark magenta/purple
          .setTitle("📜 สมุดพกของเด็กดี (Viola's Command List)")
          .setDescription('หวังว่าสมองน้อยๆ ของเธอจะจำคำสั่งพวกนี้ได้นะคะ... หรือว่าแค่นี้ก็ยากเกินไปแล้ว? ♪')
          .addFields(
            { name: '🕵️‍♀️ `!dossier @user` (หรือ `!ประวัติ`)', value: 'ประเมินสภาพจิตใจและความไร้ประโยชน์ของเป้าหมาย' },
            { name: '🔮 `!fortune` (หรือ `!ดูดวง`)', value: 'ทำนายดวงชะตาที่กำลังจะพังทลายของเธอ' },
            { name: '🎭 `!gaslight [คำพูด]` (หรือ `!ปั่นหัว`)', value: 'เถียงมาสิคะ แล้วฉันจะทำให้เธอรู้ว่าเธอเป็นฝ่ายผิดมาตลอด' },
            { name: '📈 `!score @user` (หรือ `!คะแนน`)', value: 'เช็คคะแนนความประพฤติ (Good Boy/Girl Points) ของตัวหมาก' },
            { name: '⬆️ `!merit @user` / ⬇️ `!demerit @user` (เพิ่ม/หักคะแนน)', value: 'มอบเศษทานหรือลงโทษหมากตัวอื่น (เฉพาะในเซิร์ฟเวอร์)' },
            { name: '🍷 `!bluff <1-3>` (หรือ `!หลอก`)', value: 'เกมเลือกแก้วยาพิษ... คิดว่าจะรอดไปได้จริงๆ เหรอคะ?' },
            { name: '🎭 `!audition` (หรือ `!ทดสอบ`)', value: 'ทดสอบความภักดี... ดูสิว่าเธอจะทนฉันได้สักแค่ไหน' },
            { name: '⚔️ `!duel @user` (หรือ `!ดวล`)', value: "เกมหักหลัง (Prisoner's Dilemma) ทรยศเพื่อนตัวเองซะสิคะ น่าสนุกดีนี่ ♪" }
          )
          .setFooter({ text: 'ถ้าจำไม่ได้ก็จดซะนะคะ อย่าให้ฉันต้องพูดซ้ำ ♪', iconURL: client.user.displayAvatarURL() });

        await message.reply({ embeds: [embed] });
        return; // Skip LLM generation
      } else if (command === '!setup-viola' || command === '!setchannel') {
         return; // Handled earlier
      } else {
         // Unknown command, fallback to normal processing if mentioned, else ignore
         if (!isMentioned && !isDM) return;
      }
    }

    if (!cleanContent) {
      await message.reply('มองหน้าฉันแบบนั้น มีอะไรจะพูดก็รีบพูดสิคะ... หรือว่าลืมบทไปแล้ว? ♪');
      return;
    }

    const channelId = message.channel.id;
    if (!channelHistories.has(channelId)) {
      channelHistories.set(channelId, []);
    }
    const history = channelHistories.get(channelId);

    // Auto-increment score for regular chatting (skip if DM or command)
    if (message.guild && !isCommand) {
      updateScore(message.guild.id, message.author.id, 1);
    }

    const currentScore = message.guild ? getScore(message.guild.id, message.author.id) : 0;
    const authorTag = `[${message.author.username} | Score: ${currentScore}]`;

    const lastMessage = history.length > 0 ? history[history.length - 1] : null;
    if (lastMessage && lastMessage.role === 'user') {
      lastMessage.parts[0].text += `\n${authorTag}: ${cleanContent}`;
    } else {
      history.push({
        role: 'user',
        parts: [{ text: `${authorTag}: ${cleanContent}` }],
      });
    }

    if (history.length > MAX_TURNS) {
      history.splice(0, history.length - MAX_TURNS);
    }

    await message.channel.sendTyping();

    try {
      let response;
      for (let retries = 0; retries < 3; retries++) {
        try {
          response = await ai.models.generateContent({
            model: 'gemini-3.5-flash-lite',
            config: {
              systemInstruction: VIOLA_SYSTEM_INSTRUCTION,
              temperature: 0.85,
            },
            contents: history,
          });
          break; // Success!
        } catch (apiErr) {
          if (apiErr.status === 503 && retries < 2) {
            console.log(`[DEBUG] Gemini API is overloaded (503). Retrying in 3 seconds...`);
            await new Promise(r => setTimeout(r, 3000));
          } else {
            throw apiErr; // Out of retries or different error
          }
        }
      }

      const replyText = response.text?.trim() || '...';
      history.push({
        role: 'model',
        parts: [{ text: replyText }],
      });

      if (replyText.length > 2000) {
        for (let i = 0; i < replyText.length; i += 1900) {
          await message.reply(replyText.slice(i, i + 1900));
        }
      } else {
        await message.reply(replyText);
      }
    } catch (err) {
      console.error('Error generating reply:', err);
      await message.reply('แหม... ดูเหมือนระบบจะมีปัญหานิดหน่อยนะคะ น่ารำคาญจริง ♪');
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
