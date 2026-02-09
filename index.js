import {
  eventSource,
  event_types,
  extension_prompt_roles,
  extension_prompt_types,
  saveSettingsDebounced,
  setExtensionPrompt,
  getTokenCountAsync,
  callGenericPopup,
  POPUP_TYPE,
} from '/script.js';

import {
  extension_settings,
  getContext,
  renderExtensionTemplateAsync,
} from '/scripts/extensions.js';

import { getStringHash, debounce } from '/scripts/utils.js';

function getExtensionNameFromUrl() {
  try {
    const url = String(import.meta.url || '');
    const marker = '/scripts/extensions/';
    const start = url.indexOf(marker);
    if (start < 0) return null;
    const after = url.slice(start + marker.length);
    const parts = after.split('/');
    if (parts.length < 2) return null;
    return parts.slice(0, -1).join('/');
  } catch {
    return null;
  }
}

const EXTENSION_NAME = getExtensionNameFromUrl() || 'third-party/st-sidekick-pipeline';
const SETTINGS_KEY = 'st_sidekick_pipeline';
const PROMPT_KEY = 'st_sidekick_pipeline_memory';

const defaultSettings = {
  enabled: true,
  filterOperationalInstructions: true,
  reduceHistory: true,
  debug: false,

  ollama: {
    url: 'http://localhost:11434/v1',
    model: 'qwen3:8b',
    temperature: 0.2,
    max_tokens: 1400,
  },

  preserveLastMessages: 8,

  thresholds: {
    startOccupancy: 0.78,
    minTurnsBetween: 6,
  },

  instructionFilterPatterns: [
    '(?im)^\\s*(you must|you should|always|never)\\s+.*(track|update|calculate|compute|manage)\\b.*$',
    '(?im)^\\s*\\[?(inventory|stats|status|system|quest|objective)\\]?\\s*:?\\s*(update|calculate|compute|track)\\b.*$',
    '(?im)\\b(update|calculate|compute|track|manage)\\b.*\\b(inventory|stats|status|numbers|hp|mana|gold|coins)\\b',
  ],
};

let lastRun = null;

function getSettings() {
  if (!extension_settings[SETTINGS_KEY] || typeof extension_settings[SETTINGS_KEY] !== 'object') {
    extension_settings[SETTINGS_KEY] = structuredClone(defaultSettings);
  }

  const s = extension_settings[SETTINGS_KEY];
  for (const [k, v] of Object.entries(defaultSettings)) {
    if (s[k] === undefined) s[k] = structuredClone(v);
  }
  for (const [k, v] of Object.entries(defaultSettings.ollama)) {
    if (!s.ollama) s.ollama = {};
    if (s.ollama[k] === undefined) s.ollama[k] = v;
  }
  for (const [k, v] of Object.entries(defaultSettings.thresholds)) {
    if (!s.thresholds) s.thresholds = {};
    if (s.thresholds[k] === undefined) s.thresholds[k] = v;
  }

  if (!Array.isArray(s.instructionFilterPatterns)) {
    s.instructionFilterPatterns = structuredClone(defaultSettings.instructionFilterPatterns);
  }

  return s;
}

function setStatus(text) {
  const el = document.getElementById('st_sidekick_pipeline_status');
  if (!el) return;
  el.textContent = String(text || '');
}

function safeJsonExtract(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function formatStateForPrompt(stateObj) {
  if (!stateObj || typeof stateObj !== 'object') return '';
  const lines = [];

  const summary = Array.isArray(stateObj.rolling_summary) ? stateObj.rolling_summary : [];
  const openLoops = Array.isArray(stateObj.open_loops) ? stateObj.open_loops : [];
  const facts = stateObj.facts_state && typeof stateObj.facts_state === 'object' ? stateObj.facts_state : {};

  lines.push('[Pipeline Memory v1]');
  if (summary.length > 0) {
    lines.push('Plot beats:');
    for (const s of summary.slice(0, 18)) lines.push(`- ${s}`);
  }

  const inv = Array.isArray(facts.inventory) ? facts.inventory : [];
  if (inv.length > 0) {
    lines.push('Inventory: ' + inv.slice(0, 40).join(', '));
  }

  if (facts.status && typeof facts.status === 'object') {
    const statusPairs = Object.entries(facts.status).slice(0, 20).map(([k, v]) => `${k}: ${v}`);
    if (statusPairs.length > 0) lines.push('Status: ' + statusPairs.join(' | '));
  }

  if (Array.isArray(facts.quests) && facts.quests.length > 0) {
    lines.push('Quests:');
    for (const q of facts.quests.slice(0, 10)) {
      if (!q || typeof q !== 'object') continue;
      const name = q.name || 'Quest';
      const stage = q.stage || '';
      const next = q.next_step ? ` (next: ${q.next_step})` : '';
      lines.push(`- ${name}: ${stage}${next}`);
    }
  }

  if (openLoops.length > 0) {
    lines.push('Open loops:');
    for (const o of openLoops.slice(0, 12)) lines.push(`- ${o}`);
  }

  lines.push('Writer rules: Use this memory as authoritative facts/state. Do not invent inventory/stat changes; reflect only what is in state unless the user explicitly changes it in their message.');

  return lines.join('\n');
}

async function callSidekickOllamaJSON({ system, user, model, url, temperature, max_tokens }) {
  const ctx = getContext();
  const body = {
    chat_completion_source: 'custom',
    custom_url: url,
    custom_include_headers: '',
    model: model,
    stream: false,
    temperature: temperature,
    max_tokens: max_tokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };

  const response = await fetch('/api/backends/chat-completions/generate', {
    method: 'POST',
    headers: ctx.getRequestHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Sidekick request failed: HTTP ${response.status} ${response.statusText} ${text}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
  return String(content || '');
}

function pickSummarizeIndices(coreChat, keepLast) {
  const nonSystemIndices = [];
  for (let i = 0; i < coreChat.length; i++) {
    const m = coreChat[i];
    if (!m || !m.mes) continue;
    if (m.is_system) continue;
    nonSystemIndices.push(i);
  }

  const preserveCount = Math.max(2, Math.min(50, Number(keepLast) || defaultSettings.preserveLastMessages));
  const cutoff = Math.max(0, nonSystemIndices.length - preserveCount);
  const summarize = new Set(nonSystemIndices.slice(0, cutoff));
  const preserve = new Set(nonSystemIndices.slice(cutoff));

  return { summarize, preserve, preserveCount, nonSystemCount: nonSystemIndices.length };
}

function buildChunkText(coreChat, summarizeIndices) {
  const rows = [];
  for (let i = 0; i < coreChat.length; i++) {
    if (!summarizeIndices.has(i)) continue;
    const m = coreChat[i];
    if (!m || !m.mes) continue;
    const role = m.is_user ? 'user' : 'assistant';
    const name = (m.name || '').replace(/\\s+/g, ' ').trim();
    const content = String(m.mes).trim();
    if (!content) continue;
    rows.push(`[${i}] (${role}${name ? `:${name}` : ''}) ${content}`);
  }
  return rows.join('\\n');
}

function getPipelineMetadata() {
  const ctx = getContext();
  const meta = ctx.chatMetadata || {};
  return meta[SETTINGS_KEY] && typeof meta[SETTINGS_KEY] === 'object' ? meta[SETTINGS_KEY] : null;
}

function setPipelineMetadata(newObj) {
  const ctx = getContext();
  const metaKey = SETTINGS_KEY;
  ctx.updateChatMetadata({ [metaKey]: newObj }, false);
  ctx.saveMetadataDebounced();
}

function shouldRunForType(type) {
  return type === 'normal' || type === 'continue';
}

async function maybeSummarize(coreChat, contextSize, type, { force = false } = {}) {
  const settings = getSettings();
  if (!settings.enabled) return;
  if (!shouldRunForType(type)) return;

  const ctx = getContext();
  const chatId = ctx.chatId || null;

  const lastMes = coreChat.length ? String(coreChat[coreChat.length - 1]?.mes ?? '') : '';
  const lastMesHash = lastMes ? String(getStringHash(lastMes)) : null;

  lastRun = {
    type,
    contextSize,
    chatId,
    coreChatLen: coreChat.length,
    lastMesHash,
  };

  const { summarize, preserveCount, nonSystemCount } = pickSummarizeIndices(coreChat, settings.preserveLastMessages);

  if (summarize.size === 0 || nonSystemCount <= preserveCount + 2) {
    setStatus('Sidekick: not enough history to summarize.');
    return;
  }

  const tokenSource = coreChat.filter(m => m && m.mes && !m.is_system).map(m => m.mes).join('\\n');
  const tokenCount = await getTokenCountAsync(tokenSource);
  const occupancy = contextSize > 0 ? (tokenCount / contextSize) : 0;

  const meta = getPipelineMetadata();
  const lastCompressedAtTurn = Number(meta?.lastCompressedAtTurn ?? -9999);
  const currentTurn = coreChat.length;
  const turnsSince = currentTurn - lastCompressedAtTurn;

  const threshold = Number(settings.thresholds.startOccupancy) || defaultSettings.thresholds.startOccupancy;
  const cooldown = Number(settings.thresholds.minTurnsBetween) || defaultSettings.thresholds.minTurnsBetween;

  if (!force) {
    if (occupancy < threshold) {
      setStatus(`Sidekick: noop (occupancy ${(occupancy * 100).toFixed(1)}%, tokens ~${tokenCount}/${contextSize}).`);
      return;
    }
    if (turnsSince < cooldown) {
      setStatus(`Sidekick: cooling down (${turnsSince}/${cooldown} turns since last summarize).`);
      return;
    }
  }

  const chunkText = buildChunkText(coreChat, summarize);
  if (!chunkText.trim()) {
    setStatus('Sidekick: chunk empty, skipping.');
    return;
  }

  setStatus(`Sidekick: summarizing ${summarize.size} msgs (occupancy ${(occupancy * 100).toFixed(1)}%).`);

  const systemPrompt = [
    'You are a summarization + state extraction assistant for an ongoing roleplay/story chat.',
    'Return VALID JSON ONLY (no markdown).',
    'Rules:',
    '- Do not invent facts. If uncertain, omit.',
    '- Keep rolling_summary compact, chronological, and concrete.',
    '- facts_state should contain inventory/status/quests/relationships/locations/flags if present.',
    '- open_loops are unresolved promises/questions.',
    'Output schema (keys required): version, rolling_summary, anchors, facts_state, open_loops, safety_constraints, provenance.',
    'Set version = "state.v1".',
    'anchors may be empty for MVP; if present, quotes must be verbatim from the input chunk.',
  ].join('\\n');

  const userPrompt = [
    `Chat chunk to summarize (each line has an index):`,
    chunkText,
  ].join('\\n\\n');

  let raw;
  try {
    raw = await callSidekickOllamaJSON({
      system: systemPrompt,
      user: userPrompt,
      model: String(settings.ollama.model),
      url: String(settings.ollama.url),
      temperature: Number(settings.ollama.temperature) || 0.2,
      max_tokens: Number(settings.ollama.max_tokens) || 1400,
    });
  } catch (e) {
    console.error(e);
    setStatus(`Sidekick: summarize failed: ${e.message}`);
    return;
  }

  const stateObj = safeJsonExtract(raw);
  const issues = [];
  if (!stateObj || typeof stateObj !== 'object') {
    issues.push('Invalid JSON from sidekick');
  } else {
    const required = ['version', 'rolling_summary', 'anchors', 'facts_state', 'open_loops', 'safety_constraints', 'provenance'];
    for (const k of required) {
      if (!(k in stateObj)) issues.push(`Missing field: ${k}`);
    }
  }

  const stateText = formatStateForPrompt(stateObj);
  if (stateText) {
    setExtensionPrompt(PROMPT_KEY, stateText, extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
  }

  setPipelineMetadata({
    version: 'pipeline_meta.v1',
    lastCompressedAtTurn: currentTurn,
    lastTokenCount: tokenCount,
    lastContextSize: contextSize,
    lastOccupancy: occupancy,
    preserveLastMessages: preserveCount,
    lastMesHash,
    lastState: stateObj,
    lastIssues: issues,
    updatedAt: Date.now(),
  });

  if (issues.length > 0) {
    setStatus(`Sidekick: summarized with issues: ${issues.join('; ')}`);
  } else {
    setStatus('Sidekick: summary/state updated.');
  }
}

function applyInstructionFilterToSystemMessages(chatMessages, patterns) {
  const regexes = [];
  for (const p of patterns) {
    try {
      regexes.push(new RegExp(p));
    } catch {
      // ignore
    }
  }

  let removedLines = 0;

  for (const msg of chatMessages) {
    if (!msg || msg.role !== 'system' || typeof msg.content !== 'string') continue;

    const lines = msg.content.split('\\n');
    const kept = [];
    for (const line of lines) {
      const shouldRemove = regexes.some(r => r.test(line));
      if (shouldRemove) {
        removedLines++;
      } else {
        kept.push(line);
      }
    }
    msg.content = kept.join('\\n');
  }

  return removedLines;
}

function reduceHistoryInPrompt(chatMessages, keepLast) {
  const nonSystem = [];
  for (let i = 0; i < chatMessages.length; i++) {
    const m = chatMessages[i];
    if (!m) continue;
    if (m.role === 'user' || m.role === 'assistant') {
      nonSystem.push(i);
    }
  }

  const preserveCount = Math.max(2, Math.min(50, Number(keepLast) || defaultSettings.preserveLastMessages));
  if (nonSystem.length <= preserveCount + 2) return 0;

  const cutoff = nonSystem.length - preserveCount;
  const removeIndices = new Set(nonSystem.slice(0, cutoff));

  const filtered = [];
  let removed = 0;
  for (let i = 0; i < chatMessages.length; i++) {
    if (removeIndices.has(i)) {
      removed++;
      continue;
    }
    filtered.push(chatMessages[i]);
  }

  chatMessages.length = 0;
  chatMessages.push(...filtered);
  return removed;
}

function showLastStatePopup() {
  const meta = getPipelineMetadata();
  const payload = meta?.lastState ? JSON.stringify(meta.lastState, null, 2) : '(no state yet)';
  const issues = Array.isArray(meta?.lastIssues) && meta.lastIssues.length ? `\\n\\nIssues:\\n- ${meta.lastIssues.join('\\n- ')}` : '';
  callGenericPopup(`<pre class=\"st_sidekick_pipeline_mono\">${payload.replaceAll('<', '&lt;')}</pre>${issues ? `<pre class=\"st_sidekick_pipeline_mono\">${issues.replaceAll('<', '&lt;')}</pre>` : ''}`, POPUP_TYPE.TEXT, 'Sidekick Pipeline');
}

function setupUi() {
  const settings = getSettings();

  $('#st_sidekick_pipeline_enabled').prop('checked', !!settings.enabled);
  $('#st_sidekick_pipeline_filter_instructions').prop('checked', !!settings.filterOperationalInstructions);
  $('#st_sidekick_pipeline_reduce_history').prop('checked', !!settings.reduceHistory);
  $('#st_sidekick_pipeline_debug').prop('checked', !!settings.debug);

  $('#st_sidekick_pipeline_ollama_url').val(settings.ollama.url);
  $('#st_sidekick_pipeline_ollama_model').val(settings.ollama.model);
  $('#st_sidekick_pipeline_keep_last').val(settings.preserveLastMessages);

  $('#st_sidekick_pipeline_start_occ').val(settings.thresholds.startOccupancy);
  $('#st_sidekick_pipeline_cooldown').val(settings.thresholds.minTurnsBetween);

  const save = debounce(() => {
    const s = getSettings();
    s.enabled = $('#st_sidekick_pipeline_enabled').prop('checked');
    s.filterOperationalInstructions = $('#st_sidekick_pipeline_filter_instructions').prop('checked');
    s.reduceHistory = $('#st_sidekick_pipeline_reduce_history').prop('checked');
    s.debug = $('#st_sidekick_pipeline_debug').prop('checked');

    s.ollama.url = String($('#st_sidekick_pipeline_ollama_url').val() || '').trim() || defaultSettings.ollama.url;
    s.ollama.model = String($('#st_sidekick_pipeline_ollama_model').val() || '').trim() || defaultSettings.ollama.model;
    s.preserveLastMessages = Number($('#st_sidekick_pipeline_keep_last').val() || defaultSettings.preserveLastMessages);

    s.thresholds.startOccupancy = Number($('#st_sidekick_pipeline_start_occ').val() || defaultSettings.thresholds.startOccupancy);
    s.thresholds.minTurnsBetween = Number($('#st_sidekick_pipeline_cooldown').val() || defaultSettings.thresholds.minTurnsBetween);

    saveSettingsDebounced();
  }, 250);

  $('#st_sidekick_pipeline_settings input').off('input').on('input', save);
  $('#st_sidekick_pipeline_show_state').off('click').on('click', showLastStatePopup);
  $('#st_sidekick_pipeline_force').off('click').on('click', async () => {
    const ctx = getContext();
    const chat = ctx.chat || [];
    const contextSize = ctx.maxContext || 4096;
    await maybeSummarize(chat, contextSize, 'normal', { force: true });
  });
}

jQuery(async () => {
  const settingsHtml = await renderExtensionTemplateAsync(EXTENSION_NAME, 'settings', { defaultSettings });
  $('#extensions_settings2').append(settingsHtml);
  setupUi();

  eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, async (eventData) => {
    const settings = getSettings();
    if (!settings.enabled) return;
    if (!lastRun || !shouldRunForType(lastRun.type)) return;
    if (eventData?.dryRun) return;
    if (!Array.isArray(eventData.chat)) return;

    const meta = getPipelineMetadata();

    let removedLines = 0;
    if (settings.filterOperationalInstructions) {
      removedLines = applyInstructionFilterToSystemMessages(eventData.chat, settings.instructionFilterPatterns);
    }

    let removedMsgs = 0;
    if (settings.reduceHistory && meta?.lastState && meta?.lastMesHash && lastRun?.lastMesHash && meta.lastMesHash === lastRun.lastMesHash) {
      removedMsgs = reduceHistoryInPrompt(eventData.chat, meta.preserveLastMessages || settings.preserveLastMessages);
    }

    if (settings.debug && (removedLines || removedMsgs)) {
      console.debug('[SidekickPipeline] filtered lines:', removedLines, 'removed msgs:', removedMsgs);
    }
  });

  globalThis.stSidekickPipelineInterceptor = async (chat, contextSize, abort, type) => {
    try {
      await maybeSummarize(chat, contextSize, type, { force: false });
    } catch (e) {
      console.error('[SidekickPipeline] interceptor failed', e);
    }
  };
});
