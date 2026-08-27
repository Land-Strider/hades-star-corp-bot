import fs from 'fs';
import path from 'path';
import { PermissionFlagsBits } from 'discord.js';

const configPath = path.resolve('src/artpoll/artPollConfig.json');

const DEFAULT_CONFIG = {
  enabled: true,
  channelId: '',
  allowedRoleIds: [],
  roleMentionId: '',
  pollStarted: false,
  statsEnabled: false
};

let configs = {};

function loadConfigs() {
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);

      // Legacy single-guild format migration
      if (parsed.channelId !== undefined || parsed.allowedRoleIds !== undefined) {
        const fallbackGuildId = process.env.POLL_GUILD_ID || 'default';
        configs[fallbackGuildId] = {
          enabled: parsed.enabled ?? true,
          channelId: parsed.channelId || '',
          allowedRoleIds: parsed.allowedRoleIds || [],
          roleMentionId: parsed.roleMentionId || '',
          pollStarted: parsed.pollStarted ?? false,
          statsEnabled: parsed.statsEnabled ?? false
        };
        saveConfigs();
      } else {
        configs = parsed;
      }
    }
  } catch (err) {
    console.error('Failed to read artPollConfig.json:', err);
  }
}

function saveConfigs() {
  try {
    fs.writeFileSync(configPath, JSON.stringify(configs, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save artPollConfig.json:', err);
  }
}

loadConfigs();

export function getArtPollConfig(guildId) {
  if (!guildId) return { ...DEFAULT_CONFIG };
  if (!configs[guildId]) {
    configs[guildId] = { ...DEFAULT_CONFIG };
  }
  return configs[guildId];
}

export function saveArtPollConfig(guildId, config) {
  if (!guildId) return;
  configs[guildId] = { ...DEFAULT_CONFIG, ...config };
  saveConfigs();
}

export function getAllArtPollConfigs() {
  return configs;
}

export function hasPollPermission(member, config) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (config.allowedRoleIds && config.allowedRoleIds.length > 0) {
    return config.allowedRoleIds.some(roleId => member.roles.cache.has(roleId));
  }
  return member.permissions.has(PermissionFlagsBits.ManageChannels);
}