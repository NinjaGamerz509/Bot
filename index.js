/**
  DarkMC Discord Bot - Full Version with Interactive /announce Panel
  Updated: Added Express keep-alive + /serverstart, /serverstop, /serverrestart, /serverstatus
  Notes:
    - By default commands simulate startup/shutdown (safe for Replit/public hosts)
    - To run actual server process: set LOCAL_SERVER=true in .env (bot must run on same machine as server.jar)
    - Optional AUTO_RESTART=true will auto-restart on crash when LOCAL_SERVER=true
  Admin ID: 1310109265389817888
  Requirements: discord.js v14+, Node 18+, .env with DISCORD_TOKEN & CLIENT_ID
*/

const { 
  Client, GatewayIntentBits, Partials,
  SlashCommandBuilder, Routes, REST,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, ComponentType
} = require('discord.js');

const fs = require('fs');
require('dotenv').config();

const { spawn } = require('child_process'); // for optional local server control
const express = require('express'); // keep-alive web server

// === CONFIG ===
const ADMIN_ID = '1310109265389817888';
const SERVER_IP = process.env.SERVER_IP || 'Not set';
const LOCAL_SERVER = (process.env.LOCAL_SERVER === 'true'); // if true, bot will attempt to spawn java process
const AUTO_RESTART = (process.env.AUTO_RESTART === ''); // if true and LOCAL_SERVER true, auto-restart on crash
const JAVA_CMD = process.env.JAVA_CMD || 'java'; // override if needed
const JAVA_ARGS = process.env.JAVA_ARGS ? process.env.JAVA_ARGS.split(' ') : ['-Xmx8G','-Xms8G','-jar','server.jar','nogui'];

// --- PERSISTENCE ---
let config = { welcomeChannelId: null, levelChannelId: null, autoRoleId: null, serverConsoleChannelId: null };
if (fs.existsSync('./config.json')) {
  try { config = JSON.parse(fs.readFileSync('./config.json')); } catch(e){ console.error('config.json parse error', e); }
}
let levels = {};
if (fs.existsSync('./levels.json')) {
  try { levels = JSON.parse(fs.readFileSync('./levels.json')); } catch(e){ console.error('levels.json parse error', e); }
}

function saveConfig(){ fs.writeFileSync('./config.json', JSON.stringify(config, null, 2)); }
function saveLevels(){ fs.writeFileSync('./levels.json', JSON.stringify(levels, null, 2)); }

// --- HELPERS ---
function isAdmin(user){ return user.id === ADMIN_ID; }
function getLevelData(userId){ if(!levels[userId]) levels[userId] = { xp: 0, level: 1 }; return levels[userId]; }
function xpForNextLevel(level){ return level * 100; }

// === EXPRESS KEEP-ALIVE (for Replit / uptime monitors) ===
const app = express();
app.get('/', (req, res) => res.send('✅ DarkMC Bot is alive and running!'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🌐 Web server running on port ${port}`));

// --- SERVER CONTROL STATE & LOGIC ---
let serverProcess = null;
let serverStatus = 'stopped'; // stopped | starting | started | stopping | restarting
let manualStop = false; // track if stop was manual (to avoid auto-restart if requested)

function makeStatusEmbed(title, desc, color='#00E5E5'){
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc)
    .setColor(color)
    .setFooter({ text: 'DarkMC • Server Status 💧' })
    .setTimestamp();
}

// Helper: Send console output to Discord (with rate limiting)
let consoleBuffer = [];
let consoleTimeout = null;

function sendConsoleOutput(client) {
  if (!config.serverConsoleChannelId || consoleBuffer.length === 0) {
    consoleBuffer = [];
    return;
  }
  
  const channel = client.channels.cache.get(config.serverConsoleChannelId);
  if (!channel) {
    consoleBuffer = [];
    return;
  }

  const output = consoleBuffer.join('');
  consoleBuffer = [];
  
  // Discord has 2000 char limit, split if needed
  const chunks = output.match(/[\s\S]{1,1900}/g) || [];
  chunks.forEach(chunk => {
    channel.send(`\`\`\`\n${chunk}\n\`\`\``).catch(console.error);
  });
}

function queueConsoleOutput(text, client) {
  consoleBuffer.push(text);
  
  if (consoleTimeout) clearTimeout(consoleTimeout);
  
  // Send buffered output after 2 seconds of no new output (or if buffer gets large)
  if (consoleBuffer.join('').length > 1500) {
    sendConsoleOutput(client);
  } else {
    consoleTimeout = setTimeout(() => sendConsoleOutput(client), 2000);
  }
}

// Internal: start the actual process (only if LOCAL_SERVER)
function spawnServerProcess(statusChannel, client) {
  if (!LOCAL_SERVER) return;
  if (serverProcess) return;

  try {
    serverProcess = spawn(JAVA_CMD, JAVA_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });
    console.log('Spawned server process with PID', serverProcess.pid);
    serverProcess.stdout.setEncoding('utf8');
    serverProcess.stderr.setEncoding('utf8');

    serverProcess.stdout.on('data', data => {
      const s = data.toString();
      process.stdout.write(`[MC STDOUT] ${s}`);
      
      // Send to Discord console channel
      if (config.serverConsoleChannelId && client) {
        queueConsoleOutput(s, client);
      }
      
      // Minecraft prints "Done (" when started successfully in many versions, also "Done" alone often appears.
      if (s.includes('Done') || s.toLowerCase().includes('for help, type "help"')) {
        if (serverStatus === 'starting' || serverStatus === 'restarting') {
          serverStatus = 'started';
          if (statusChannel) statusChannel.send({ embeds: [makeStatusEmbed('✅ Server has started!', `Server is online — join at \`${SERVER_IP}\``, '#00E5E5')] }).catch(console.error);
        }
      }
    });

    serverProcess.stderr.on('data', data => {
      const s = data.toString();
      process.stderr.write(`[MC STDERR] ${s}`);
      
      // Send errors to Discord console channel too
      if (config.serverConsoleChannelId && client) {
        queueConsoleOutput(`[ERROR] ${s}`, client);
      }
    });

    serverProcess.on('exit', (code, signal) => {
      console.log(`Minecraft process exited (code=${code}, signal=${signal})`);
      serverProcess = null;
      const prevStatus = serverStatus;
      // If stopping intentionally:
      if (manualStop) {
        manualStop = false;
        serverStatus = 'stopped';
        if (statusChannel) statusChannel.send({ embeds: [makeStatusEmbed('🛑 Server Stopped', 'Server has been stopped successfully.', '#ff5555')] }).catch(console.error);
        return;
      }
      // Unexpected exit (crash)
      serverStatus = 'stopped';
      if (statusChannel) statusChannel.send({ embeds: [makeStatusEmbed('❌ Server stopped unexpectedly', 'Server process exited.')] }).catch(console.error);

      // Auto-restart if enabled (and we weren't manually stopping)
      if (AUTO_RESTART) {
        console.log('AUTO_RESTART enabled — restarting in 5s...');
        if (statusChannel) statusChannel.send('🔁 Auto-restart enabled — attempting to restart in 5 seconds...');
        serverStatus = 'starting';
        setTimeout(() => {
          spawnServerProcess(statusChannel, client);
        }, 5000);
      }
    });
  } catch (err) {
    console.error('Failed to spawn server process:', err);
    serverProcess = null;
    serverStatus = 'stopped';
    if (statusChannel) statusChannel.send({ embeds: [makeStatusEmbed('❌ Failed to start server', `${err.message}` , '#ff5555')] }).catch(console.error);
  }
}

// High-level start (handles simulation if LOCAL_SERVER=false)
async function startServer(statusChannel){
  if (serverStatus !== 'stopped') {
    if (statusChannel) statusChannel.send({ embeds: [makeStatusEmbed('⚠️ Already running or starting', 'Server is not in stopped state.')] }).catch(console.error);
    return;
  }
  serverStatus = 'starting';
  if (statusChannel) await statusChannel.send({ embeds: [makeStatusEmbed('🟢 Server Starting...', 'Please wait, the Minecraft server is starting...')] }).catch(console.error);

  if (LOCAL_SERVER) {
    manualStop = false;
    spawnServerProcess(statusChannel, client);
    // If spawn doesn't detect Done, we still keep status in 'starting' until process emits done log.
    // To avoid stuck 'starting', add a fallback: after 60s if still not 'started' mark as started (optional)
    setTimeout(() => {
      if (serverStatus === 'starting') {
        serverStatus = 'started';
        if (statusChannel) statusChannel.send({ embeds: [makeStatusEmbed('✅ Server Started (fallback)', `Server assumed online — join at \`${SERVER_IP}\``)] }).catch(console.error);
      }
    }, 60 * 1000);
  } else {
    // Simulation for hosted environments like Replit where we can't run java
    setTimeout(async () => {
      serverStatus = 'started';
      if (statusChannel) await statusChannel.send({ embeds: [makeStatusEmbed('✅ Server Started!', `DarkMC server is now online — join at \`${SERVER_IP}\``, '#00E5E5')] }).catch(console.error);
    }, 10000); // simulate 10s startup
  }
}

// High-level stop
async function stopServer(statusChannel){
  if (serverStatus === 'stopped') {
    if (statusChannel) return statusChannel.send({ embeds: [makeStatusEmbed('⚠️ Already stopped', 'Server is already stopped.')] }).catch(console.error);
    return;
  }

  serverStatus = 'stopping';
  if (statusChannel) await statusChannel.send({ embeds: [makeStatusEmbed('🔴 Server Stopping...', 'Please wait, server is shutting down...')] }).catch(console.error);

  if (LOCAL_SERVER && serverProcess) {
    // send "stop" to server stdin
    try {
      manualStop = true;
      serverProcess.stdin.write('stop\n');
      // If process doesn't exit in X secs, force kill
      setTimeout(() => {
        if (serverProcess) {
          console.log('Forcing server process kill after timeout');
          serverProcess.kill('SIGTERM');
        }
      }, 15000);
    } catch (err) {
      console.error('Error sending stop to server process:', err);
      try { serverProcess.kill('SIGTERM'); } catch(e){}
    }
  } else {
    // Simulation: just wait and mark stopped
    setTimeout(async () => {
      serverStatus = 'stopped';
      if (statusChannel) await statusChannel.send({ embeds: [makeStatusEmbed('🛑 Server Stopped', 'Server has been stopped successfully.')] }).catch(console.error);
    }, 8000);
  }
}

// High-level restart
async function restartServer(statusChannel){
  if (serverStatus === 'stopped') {
    if (statusChannel) return statusChannel.send({ embeds: [makeStatusEmbed('⚠️ Server is stopped', 'Use start command to start the server.')] }).catch(console.error);
    return;
  }

  serverStatus = 'restarting';
  if (statusChannel) await statusChannel.send({ embeds: [makeStatusEmbed('🔁 Server Restarting...', 'Server will stop and restart — please wait...')] }).catch(console.error);

  if (LOCAL_SERVER && serverProcess) {
    // send stop then wait for exit, spawn on exit (handled by spawnServerProcess if AUTO_RESTART false we'll manual restart)
    manualStop = false; // we want to restart
    serverProcess.stdin.write('stop\n');
    // wait for exit event and then spawn new
    const checkExit = setInterval(() => {
      if (!serverProcess) {
        clearInterval(checkExit);
        // small delay then start
        serverStatus = 'starting';
        if (statusChannel) statusChannel.send({ embeds: [makeStatusEmbed('🟡 Server Starting...', 'Booting up the server again...')] }).catch(console.error);
        setTimeout(() => spawnServerProcess(statusChannel, client), 3000);
      }
    }, 1000);
    // safety: if still alive after 20s, kill and spawn
    setTimeout(() => {
      if (serverProcess) {
        try { serverProcess.kill('SIGTERM'); } catch(e){}
      }
    }, 20000);
  } else {
    // Simulation path
    setTimeout(async () => {
      serverStatus = 'starting';
      if (statusChannel) await statusChannel.send({ embeds: [makeStatusEmbed('🟡 Server Starting...', 'Booting up the server again...')] }).catch(console.error);
      setTimeout(async () => {
        serverStatus = 'started';
        if (statusChannel) await statusChannel.send({ embeds: [makeStatusEmbed('✅ Server Restarted!', 'Server is back online 💧')] }).catch(console.error);
      }, 10000);
    }, 8000);
  }
}

// --- Slash commands registration (announce options optional now) ---
const commands = [
  new SlashCommandBuilder().setName('announce').setDescription('Open interactive announcement panel (admin only)'),
  new SlashCommandBuilder().setName('setwelcomechannel').setDescription('Set welcome channel')
    .addChannelOption(opt=>opt.setName('channel').setDescription('Select welcome channel').setRequired(false)),
  new SlashCommandBuilder().setName('setautorole').setDescription('Set auto role for new members')
    .addRoleOption(opt=>opt.setName('role').setDescription('Select role to assign').setRequired(false)),
  new SlashCommandBuilder().setName('setevent').setDescription('Set a server event')
    .addStringOption(opt=>opt.setName('name').setDescription('Event name').setRequired(true))
    .addStringOption(opt=>opt.setName('duration').setDescription('Duration (10s,5m,1h)').setRequired(true)),
  new SlashCommandBuilder().setName('greettest').setDescription('Test welcome greeting'),
  new SlashCommandBuilder().setName('uptime').setDescription('Check bot uptime'),
  new SlashCommandBuilder().setName('help').setDescription('Show bot commands'),
  new SlashCommandBuilder().setName('setlevelchannel').setDescription('Set channel for level-up messages')
    .addChannelOption(opt=>opt.setName('channel').setDescription('Select channel').setRequired(false)),
  new SlashCommandBuilder().setName('rank').setDescription('Check your level'),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Show top 10 active users'),
  new SlashCommandBuilder().setName('ping').setDescription('Check bot latency'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop the bot'),
  new SlashCommandBuilder().setName('restart').setDescription('Restart the bot'),
  // Server control commands
  new SlashCommandBuilder().setName('serverstart').setDescription('Start the Minecraft server (anyone)'),
  new SlashCommandBuilder().setName('serverstop').setDescription('Stop the Minecraft server (admin only)'),
  new SlashCommandBuilder().setName('serverrestart').setDescription('Restart the Minecraft server (admin only)'),
  new SlashCommandBuilder().setName('serverstatus').setDescription('Get the Minecraft server status'),
  new SlashCommandBuilder().setName('setconsolechannel').setDescription('Set channel for live server console output (admin only)')
    .addChannelOption(opt=>opt.setName('channel').setDescription('Select channel').setRequired(false))
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ Commands registered');
  } catch(err){ console.error('Failed to register commands', err); }
})();

// --- Client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

let botStartTime = Date.now();

// --- Announcement builder state map (per admin session) ---
const announceSessions = new Map();

// Utility to create the base builder embed + components
function makeAnnouncePanelEmbed(state){
  const embed = new EmbedBuilder()
    .setTitle('📣 Announcement Builder')
    .setColor('#00E5E5')
    .setDescription(
      `**Title:** ${state.title || '_Not set_'}\n` +
      `**Description:** ${state.description ? (state.description.length > 80 ? state.description.slice(0,77)+'...' : state.description) : '_Not set_'}\n` +
      `**Color:** ${state.color || '_Default (#00E5E5)_'}\n` +
      `**Image:** ${state.imageUrl ? '_Set_' : '_Not set_'}\n` +
      `**Channel:** ${state.channelId ? `<#${state.channelId}>` : '_Not selected_'}\n\n` +
      `_Tip: Use the buttons below to set each field. Session expires in 10 minutes._`
    )
    .setFooter({ text: 'DarkMC • Announcement Builder 💧' })
    .setTimestamp();
  return embed;
}

function makeAnnounceActionRows(){
  const row1 = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId('ann_title').setLabel('Title').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('ann_desc').setLabel('Description').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('ann_color').setLabel('Color').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ann_image').setLabel('Image (URL)').setStyle(ButtonStyle.Secondary)
    );
  const row2 = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId('ann_channel').setLabel('Pick Channel').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ann_send').setLabel('🚀 Send').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ann_close').setLabel('❌ Close').setStyle(ButtonStyle.Danger)
    );
  return [row1, row2];
}

// --- Ready ---
client.on('ready', () => console.log(`✅ ${client.user.tag} is online`));

// --- Guild Member Welcome (light aqua card) ---
client.on('guildMemberAdd', async member => {
  if (config.autoRoleId) {
    const role = member.guild.roles.cache.get(config.autoRoleId);
    if (role) await member.roles.add(role).catch(console.error);
  }
  if (config.welcomeChannelId) {
    const channel = member.guild.channels.cache.get(config.welcomeChannelId);
    if (channel) {
      const embed = new EmbedBuilder()
        .setColor('#00E5E5')
        .setTitle('🎉 Welcome to DarkMC!')
        .setDescription(`Hey! 🎉\nWelcome to the DarkMC Community 💀\nChill maar, chat kar aur apna level badha ⚡\nCheck #rules aur #updates channels!`)
        .setThumbnail(member.user.displayAvatarURL())
        .setFooter({ text: 'DarkMC • Stay Cool 💧' });
      channel.send({ embeds: [embed] }).catch(console.error);
    }
  }
});

// --- Level system on message (keeps JSON persistence) ---
client.on('messageCreate', async msg => {
  if (msg.author.bot) return;
  const data = getLevelData(msg.author.id);
  const xpGain = Math.floor(Math.random() * 11) + 5;
  data.xp += xpGain;
  const nextXp = xpForNextLevel(data.level);
  if (data.xp >= nextXp) {
    data.level++;
    data.xp -= nextXp;
    if (config.levelChannelId) {
      const channel = msg.guild.channels.cache.get(config.levelChannelId);
      if (channel) {
        const embed = new EmbedBuilder()
          .setColor('#00E5E5')
          .setTitle('🎯 Level Up!')
          .setDescription(`You just reached **Level ${data.level}!** 🔥\nKeep chatting and flex your grind!`);
        channel.send({ embeds: [embed] }).catch(console.error);
      }
    }
  }
  debounceSaveLevels();
});

// --- Debounced save for levels (to reduce disk writes) ---
let saveLevelsTimeout = null;
function debounceSaveLevels(){
  if(saveLevelsTimeout) return;
  saveLevelsTimeout = setTimeout(()=>{
    saveLevels();
    saveLevelsTimeout = null;
  }, 10000); // 10 seconds
}

// --- Interaction (slash commands / buttons / modals / select menus) ---
client.on('interactionCreate', async interaction => {
  try {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;
      const user = interaction.user;

      // Admin-only commands list (existing)
      const adminOnly = ['announce','setwelcomechannel','setautorole','setevent','setlevelchannel','stop','restart','serverstop','serverrestart','setconsolechannel'];

      if (adminOnly.includes(cmd) && !isAdmin(user)) {
        return interaction.reply({ content: '⛔ Only admin can use this command.', ephemeral: true });
      }

      // --- /announce opens panel for admin ---
      if (cmd === 'announce') {
        if (!isAdmin(user)) return interaction.reply({ content: '⛔ Only admin can open announce panel.', ephemeral: true });
        // create initial state
        const state = {
          guildId: interaction.guildId,
          authorId: user.id,
          title: null,
          description: null,
          color: '#00E5E5',
          imageUrl: null,
          imageSetAt: null,
          channelId: null,
          expiresAt: Date.now() + 10 * 60 * 1000 // 10 minutes
        };
        const embed = makeAnnouncePanelEmbed(state);
        const rows = makeAnnounceActionRows();
        const panel = await interaction.reply({ embeds: [embed], components: rows, fetchReply: true, ephemeral: false });

        // store session by message id
        announceSessions.set(panel.id, { state, panelMessageId: panel.id, guildId: interaction.guildId });
        // collector for buttons on that panel (10 minutes)
        const collector = panel.createMessageComponentCollector({ time: 10 * 60 * 1000 });

        collector.on('collect', async comp => {
          // ensure only the admin who opened can interact
          if (comp.user.id !== user.id) {
            return comp.reply({ content: '⛔ Only the admin who opened this panel can interact.', ephemeral: true });
          }

          // refresh session reference
          const session = announceSessions.get(panel.id);
          if (!session) return comp.reply({ content: 'Session expired or not found.', ephemeral: true });

          // Handle button ids
          if (comp.isButton()) {
            switch (comp.customId) {
              case 'ann_title': {
                const modal = new ModalBuilder()
                  .setCustomId(`modal_title_${panel.id}`)
                  .setTitle('Set Announcement Title');
                const input = new TextInputBuilder()
                  .setCustomId('title_input')
                  .setLabel('Title (leave empty to clear)')
                  .setStyle(TextInputStyle.Short)
                  .setMaxLength(256)
                  .setRequired(false);
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                await comp.showModal(modal);
                break;
              }
              case 'ann_desc': {
                const modal = new ModalBuilder()
                  .setCustomId(`modal_desc_${panel.id}`)
                  .setTitle('Set Announcement Description');
                const input = new TextInputBuilder()
                  .setCustomId('desc_input')
                  .setLabel('Description')
                  .setStyle(TextInputStyle.Paragraph)
                  .setMaxLength(4000)
                  .setRequired(false);
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                await comp.showModal(modal);
                break;
              }
              case 'ann_color': {
                const modal = new ModalBuilder()
                  .setCustomId(`modal_color_${panel.id}`)
                  .setTitle('Set Embed Color (hex)');
                const input = new TextInputBuilder()
                  .setCustomId('color_input')
                  .setLabel('Hex color (e.g. #00E5E5)')
                  .setStyle(TextInputStyle.Short)
                  .setMaxLength(7)
                  .setRequired(false);
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                await comp.showModal(modal);
                break;
              }
              case 'ann_image': {
                const modal = new ModalBuilder()
                  .setCustomId(`modal_image_${panel.id}`)
                  .setTitle('Set Image URL (valid 10 min)');
                const input = new TextInputBuilder()
                  .setCustomId('image_input')
                  .setLabel('Image URL (https://...)')
                  .setStyle(TextInputStyle.Short)
                  .setMaxLength(1000)
                  .setRequired(false);
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                await comp.showModal(modal);
                break;
              }
              case 'ann_channel': {
                // show a select menu listing up to 25 text channels in guild
                const channels = comp.guild.channels.cache
                  .filter(ch => ch.isTextBased() && ch.viewable)
                  .map(ch => ({ label: ch.name.slice(0,100), value: ch.id }));
                // slice to 25
                const options = channels.slice(0, 25);
                if (options.length === 0) {
                  await comp.reply({ content: 'No selectable channels available.', ephemeral: true });
                  return;
                }
                const menu = new StringSelectMenuBuilder()
                  .setCustomId(`select_channel_${panel.id}`)
                  .setPlaceholder('Choose channel for announcement')
                  .addOptions(options);
                const row = new ActionRowBuilder().addComponents(menu);
                await comp.reply({ content: 'Choose a channel from the menu below:', components: [row], ephemeral: true });
                break;
              }
              case 'ann_send': {
                // Validate fields and send
                const s = announceSessions.get(panel.id);
                if (!s) return comp.reply({ content: 'Session expired.', ephemeral: true });
                const st = s.state;
                if (!st.channelId) return comp.reply({ content: '❌ Please select a channel first.', ephemeral: true });
                // if imageUrl present, ensure it was set within 10 minutes
                if (st.imageUrl && st.imageSetAt && (Date.now() - st.imageSetAt) > 10 * 60 * 1000) {
                  return comp.reply({ content: '❌ The provided image URL is older than 10 minutes. Set it again.', ephemeral: true });
                }
                // build embed
                const annEmbed = new EmbedBuilder()
                  .setTitle(st.title || 'Announcement')
                  .setDescription(st.description || 'No description provided.')
                  .setColor(st.color || '#00E5E5')
                  .setFooter({ text: 'DarkMC • Announcement 💧' })
                  .setTimestamp();
                if (st.imageUrl) annEmbed.setImage(st.imageUrl);
                const target = comp.guild.channels.cache.get(st.channelId);
                if (!target) return comp.reply({ content: '❌ Selected channel not found or bot has no access.', ephemeral: true });
                await target.send({ embeds: [annEmbed] }).catch(err => console.error('Failed to send announcement', err));
                // cleanup panel
                announceSessions.delete(panel.id);
                // update panel to show sent
                await comp.update({ content: '✅ Announcement sent!', embeds: [], components: [] });
                return;
              }
              case 'ann_close': {
                announceSessions.delete(panel.id);
                await comp.update({ content: '❌ Announcement session closed.', embeds: [], components: [] });
                return;
              }
            } // switch
          } // isButton
        }); // collector.on collect

        collector.on('end', async () => {
          // if session still exists and not sent, expire it
          if (announceSessions.has(panel.id)) {
            announceSessions.delete(panel.id);
            try { await panel.edit({ content: '⏳ Announcement builder session expired.', embeds: [], components: [] }); } catch(e){ /* message may be deleted */ }
          }
        });

        return;
      } // announce

      // --- other commands (existing behavior) ---
      if (cmd === 'setwelcomechannel') {
        const ch = interaction.options.getChannel('channel');
        if (!ch) return interaction.reply({ content: '❌ Please provide a channel.', ephemeral: true });
        if (config.welcomeChannelId === ch.id) return interaction.reply({ content: 'Hey! Yehi channel pe welcome messages already set hain 🎉', ephemeral: true });
        config.welcomeChannelId = ch.id;
        saveConfig();
        return interaction.reply({ content: `✅ Welcome channel set to ${ch}` });
      }

      if (cmd === 'setautorole') {
        const role = interaction.options.getRole('role');
        if (!role) return interaction.reply({ content: '❌ Please provide a role.', ephemeral: true });
        config.autoRoleId = role.id;
        saveConfig();
        return interaction.reply({ content: `✅ Auto role set to ${role}` });
      }

      if (cmd === 'setevent') {
        const name = interaction.options.getString('name');
        const duration = interaction.options.getString('duration');
        return interaction.reply({ content: `✅ Event "${name}" set for ${duration}` });
      }

      if (cmd === 'greettest') {
        if (!config.welcomeChannelId) return interaction.reply({ content: '❌ Welcome channel not set', ephemeral: true });
        const channel = interaction.guild.channels.cache.get(config.welcomeChannelId);
        if (channel) channel.send('Test Greeting! Welcome!');
        return interaction.reply({ content: '✅ Greeting test sent' });
      }

      if (cmd === 'uptime') {
        const ms = Date.now() - botStartTime;
        const seconds = Math.floor(ms / 1000) % 60;
        const minutes = Math.floor(ms / 60000) % 60;
        const hours = Math.floor(ms / 3600000);
        return interaction.reply({ content: `Bot Uptime: ${hours}h ${minutes}m ${seconds}s` });
      }

      if (cmd === 'help') {
        const embed = new EmbedBuilder()
          .setTitle('DarkMC Bot Commands')
          .setDescription(`
**General Commands:**
/help - Show this help  
/ping - Check bot latency  
/uptime - Check bot uptime  

**Level System:**
/rank - Check your level  
/leaderboard - Top 10 users  

**Admin Commands:**
/announce - Open announcement panel  
/setwelcomechannel <channel>  
/setautorole <role>  
/setlevelchannel <channel>  
/setconsolechannel <channel> - Live server console  
/setevent <name> <duration>  
/greettest - Test welcome  
/stop - Stop bot  
/restart - Restart bot  

**Minecraft Server:**
/serverstart - Start server (anyone)  
/serverstop - Stop server (admin)  
/serverrestart - Restart server (admin)  
/serverstatus - Check status
          `)
          .setColor('#00E5E5')
          .setFooter({ text: 'DarkMC • Made with 💧' });
        return interaction.reply({ embeds: [embed] });
      }

      if (cmd === 'setlevelchannel') {
        const ch = interaction.options.getChannel('channel');
        if (!ch) return interaction.reply({ content: '❌ Please provide a channel.', ephemeral: true });
        if (config.levelChannelId === ch.id) return interaction.reply({ content:'Chill maar bhai, yehi channel pe level-up messages already jayenge 💧', ephemeral: true });
        config.levelChannelId = ch.id;
        saveConfig();
        return interaction.reply({ content: `✅ Level-up messages will be sent in ${ch}` });
      }

      if (cmd === 'setconsolechannel') {
        const ch = interaction.options.getChannel('channel');
        if (!ch) return interaction.reply({ content: '❌ Please provide a channel.', ephemeral: true });
        if (config.serverConsoleChannelId === ch.id) return interaction.reply({ content:'Server console output already is channel pe aa raha hai 💧', ephemeral: true });
        config.serverConsoleChannelId = ch.id;
        saveConfig();
        return interaction.reply({ content: `✅ Server console output will be shown in ${ch}\nNote: Only works when LOCAL_SERVER=true` });
      }

      if (cmd === 'rank') {
        const data = getLevelData(user.id);
        return interaction.reply({ content: `You are Level **${data.level}** with **${data.xp} XP**` });
      }

      if (cmd === 'leaderboard') {
        const lb = Object.entries(levels)
          .sort(([,a],[,b]) => b.level - a.level || b.xp - a.xp)
          .slice(0,10)
          .map(([id,data], i) => `${i+1}. <@${id}> — Level ${data.level} (${data.xp} XP)`)
          .join('\n') || 'No data yet.';
        return interaction.reply({ content: lb });
      }

      if (cmd === 'ping') {
        return interaction.reply({ content: `🏓 Pong! Latency: ${client.ws.ping}ms` });
      }

      // === /stop (stop the bot) ===
      if (cmd === 'stop') {
        if (!isAdmin(user)) return interaction.reply({ content: '⛔ Only admin can stop the bot.', ephemeral: true });
        await interaction.reply({ content: 'Shutting down bot... Bye!' });
        process.exit(0);
      }

      // === /restart (restart the bot) ===
      if (cmd === 'restart') {
        if (!isAdmin(user)) return interaction.reply({ content: '⛔ Only admin can restart the bot.', ephemeral: true });
        await interaction.reply({ content: 'Restarting bot...' });
        process.exit(0); // on hosting platform, use process manager to restart
      }

      // -----------------------
      // === Server commands ===
      // -----------------------
      if (cmd === 'serverstart') {
        // Anyone can start as requested
        // Use channel for status messages
        const ch = interaction.channel;
        await interaction.reply({ embeds: [makeStatusEmbed('🟢 Starting Server', 'Attempting to start the Minecraft server...')] }).catch(console.error);
        // Start it
        startServer(ch);
        return;
      }

      if (cmd === 'serverstop') {
        // Admin only enforced above
        const ch = interaction.channel;
        await interaction.reply({ embeds: [makeStatusEmbed('🔴 Stopping Server', 'Attempting to stop the Minecraft server...')] }).catch(console.error);
        stopServer(ch);
        return;
      }

      if (cmd === 'serverrestart') {
        // Admin only enforced above
        const ch = interaction.channel;
        await interaction.reply({ embeds: [makeStatusEmbed('🔁 Restarting Server', 'Attempting to restart the Minecraft server...')] }).catch(console.error);
        restartServer(ch);
        return;
      }

      if (cmd === 'serverstatus') {
        return interaction.reply({ embeds: [makeStatusEmbed('📡 Server Status', `Current status: **${serverStatus}**\nIP: \`${SERVER_IP}\``)] });
      }

    } // isChatInputCommand
    // --- component interactions (buttons/modals/selects) handled earlier in your code (announce builder) ---
  } catch (err) {
    console.error('Interaction handler error:', err);
    try { if (interaction && !interaction.replied) interaction.reply({ content: '❌ An error occurred.', ephemeral: true }); } catch(e){}
  }
});

// --- KEEP-ALIVE LOGS ---
setInterval(() => console.log("🔁 Keep-alive ping: " + new Date().toLocaleTimeString()), 5 * 60 * 1000);

// --- LOGIN ---
client.login(process.env.DISCORD_TOKEN);