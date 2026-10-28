import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import pg from 'pg';
import cron from 'node-cron';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

import {
  artPollCommand,
  handleArtPollInteraction,
  terminateActivePoll,
  deleteActivePoll,
  createNewArtifactPoll,
  ensureActivePoll,
  checkAndSnapshotPreClosure,
  getArtPollConfig,
  getAllArtPollConfigs
} from './artpoll/artPoll.js';

import {
  rsScoreBoardCommand,
  handleRSScoreBoardInteraction,
  handleRSMessageCreate,
  ensureRSConfigTableExist,
  refreshActiveRSBoards
} from './rsscoreboard/rsScoreBoard.js';

import {
  quantumSchedulerCommand,
  handleQuantumSchedulerInteraction,
  ensureQSTablesExist,
  refreshAllQSBoards
} from './quantumscheduler/quantumScheduler.js';

dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

function getModuleConfig() {
  try {
    const raw = fs.readFileSync(path.resolve('src/modules.json'), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load modules.json:', err);
    return { artPoll: true, wsRoster: false, rsScoreBoard: true, quantumScheduler: false };
  }
}

async function registerCommands() {
  const modules = getModuleConfig();
  const commands = [];

  if (modules.artPoll) {
    commands.push(artPollCommand.toJSON());
  }

  if (modules.rsScoreBoard) {
    commands.push(rsScoreBoardCommand.toJSON());
  }

  if (modules.quantumScheduler) {
    commands.push(quantumSchedulerCommand.toJSON());
  }

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('🔄 Registering global slash commands...');
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log('✅ Global slash commands updated across all servers.');
  } catch (err) {
    console.error('❌ Failed to register global slash commands:', err);
  }
}

client.once('clientReady', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await registerCommands();

  const modules = getModuleConfig();

  if (modules.rsScoreBoard) {
    await ensureRSConfigTableExist(pool);

    // Keep the countdown on running Corp RS Event boards current between runs
    cron.schedule('*/15 * * * *', async () => {
      try {
        await refreshActiveRSBoards(client, pool);
      } catch (err) {
        console.error('RSScoreBoard board refresh error:', err);
      }
    }, { timezone: 'UTC' });
  }

  if (modules.quantumScheduler) {
    await ensureQSTablesExist(pool);

    // Move the current-hour highlight and now marker on every schedule board
    const refreshBoards = async () => {
      try {
        await refreshAllQSBoards(client, pool);
      } catch (err) {
        console.error('QuantumScheduler board refresh error:', err);
      }
    };
    cron.schedule('*/15 * * * *', refreshBoards, { timezone: 'UTC' });
    refreshBoards();
  }

  if (modules.artPoll) {
    await ensureActivePoll(client, pool);

    // 1. Scheduled weekly pre-closure vote snapshot: Sunday 02:54 UTC
    cron.schedule('54 2 * * 0', async () => {
      console.log('📸 UTC Sunday 02:54 - Snapshotting active artifact poll votes...');
      await checkAndSnapshotPreClosure(client, pool);
    }, { timezone: 'UTC' });

    // 2. Scheduled weekly native termination: Sunday 02:58 UTC (Triggers Discord winner banner)
    cron.schedule('58 2 * * 0', async () => {
      console.log('🔒 UTC Sunday 02:58 - Natively terminating artifact polls...');
      await terminateActivePoll(client, pool);
    }, { timezone: 'UTC' });

    // 3. Scheduled weekly message deletion: Sunday 02:59 UTC (Purges closed poll widget)
    cron.schedule('59 2 * * 0', async () => {
      console.log('🗑️ UTC Sunday 02:59 - Deleting active artifact poll messages...');
      await deleteActivePoll(client, pool);
    }, { timezone: 'UTC' });

    // 4. Scheduled weekly repost: Sunday 03:00 UTC (Parallelized repost across guilds)
    cron.schedule('0 3 * * 0', async () => {
      console.log('🚀 UTC Sunday 03:00 - Reposting weekly artifact polls...');
      const configs = await getAllArtPollConfigs(pool);

      await Promise.allSettled(
        Object.entries(configs).map(async ([guildId, config]) => {
          if (!guildId || guildId === 'default') return;
          if (!config.enabled || !config.pollStarted || !config.channelId) return;
          await createNewArtifactPoll(client, pool, config.channelId, guildId);
        })
      );
    }, { timezone: 'UTC' });
  }
});

client.on('messageCreate', async (message) => {
  const modules = getModuleConfig();
  if (!modules.rsScoreBoard) return;

  try {
    await handleRSMessageCreate(message, client, pool);
  } catch (err) {
    console.error('RSScoreBoard message processing error:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  const modules = getModuleConfig();

  if (modules.artPoll) {
    const isArtPollCmd = interaction.isChatInputCommand() && interaction.commandName === 'artpoll';
    const isArtPollComp = interaction.isMessageComponent() && interaction.customId.startsWith('artpoll_');

    if (isArtPollCmd || isArtPollComp) {
      try {
        await handleArtPollInteraction(interaction, client, pool);
        return;
      } catch (err) {
        console.error('Interaction processing error:', err);
      }
    }
  }

  if (modules.rsScoreBoard) {
    const isRSBoardCmd = interaction.isChatInputCommand() && interaction.commandName === 'rsboard';
    const isRSBoardComp = interaction.isMessageComponent() && interaction.customId.startsWith('rsboard_');

    if (isRSBoardCmd || isRSBoardComp) {
      try {
        await handleRSScoreBoardInteraction(interaction, client, pool);
        return;
      } catch (err) {
        console.error('RSScoreBoard interaction error:', err);
      }
    }
  }

  if (modules.quantumScheduler) {
    const isQSCmd = (interaction.isChatInputCommand() || interaction.isAutocomplete()) && interaction.commandName === 'quantum';
    const isQSComp = interaction.isMessageComponent() && interaction.customId.startsWith('quantum_');

    if (isQSCmd || isQSComp) {
      try {
        await handleQuantumSchedulerInteraction(interaction, client, pool);
        return;
      } catch (err) {
        console.error('QuantumScheduler interaction error:', err);
      }
    }
  }
});

client.login(process.env.DISCORD_TOKEN);