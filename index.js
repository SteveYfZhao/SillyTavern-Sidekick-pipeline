import {
  eventSource,
  event_types,
} from '/scripts/events.js';

import {
  extension_prompt_roles,
  extension_prompt_types,
  saveSettingsDebounced,
  setExtensionPrompt,
} from '/script.js';

import {
  extension_settings,
  getContext,
  renderExtensionTemplateAsync,
} from '/scripts/extensions.js';

import {
  callGenericPopup,
  POPUP_TYPE,
} from '/scripts/popup.js';

import { getTokenCountAsync } from '/scripts/tokenizers.js';

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

  wiCache: {},
  wiCacheStats: {
    hits: 0,
    misses: 0,
    lastUpdate: null,
  },

  rag: {
    enabled: false,
    threshold: 0.7,
    topK: 5,
    embeddingProvider: 'transformers',
  },

  memoryEnhancement: {
    enabled: false,
    optimizeTables: false,
    maxCellLength: 200,
    compressionLevel: 'balanced',
    autoOptimizeAfterMessages: 10,
    rowFilterMethod: 'vector',
    maxRowsInPrompt: 10,
    relevanceThreshold: 0.6,
  },
};

let lastRun = null;
let promptBefore = null;
let promptAfter = null;
let abortController = null;
let vectorExtensionAvailable = null;
let memoryEnhancementAvailable = null;

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

  if (!s.wiCache || typeof s.wiCache !== 'object') {
    s.wiCache = {};
  }
  if (!s.wiCacheStats || typeof s.wiCacheStats !== 'object') {
    s.wiCacheStats = structuredClone(defaultSettings.wiCacheStats);
  }

  if (!s.rag || typeof s.rag !== 'object') {
    s.rag = {};
  }
  for (const [k, v] of Object.entries(defaultSettings.rag)) {
    if (s.rag[k] === undefined) s.rag[k] = v;
  }

  if (!s.memoryEnhancement || typeof s.memoryEnhancement !== 'object') {
    s.memoryEnhancement = {};
  }
  for (const [k, v] of Object.entries(defaultSettings.memoryEnhancement)) {
    if (s.memoryEnhancement[k] === undefined) s.memoryEnhancement[k] = v;
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

// ========== Detection Functions ==========

async function detectVectorExtension() {
  if (vectorExtensionAvailable !== null) return vectorExtensionAvailable;
  
  try {
    // Check if vectors extension is loaded by checking extension_settings
    vectorExtensionAvailable = !!(extension_settings.vectors && typeof extension_settings.vectors === 'object');
    
    // Also verify API is available if extension settings exist
    if (vectorExtensionAvailable) {
      try {
        const response = await fetch('/api/vector/list-collections', {
          method: 'POST',
          headers: getContext().getRequestHeaders(),
          body: JSON.stringify({}),
        });
        vectorExtensionAvailable = response.ok;
      } catch (e) {
        vectorExtensionAvailable = false;
      }
    }
  } catch (e) {
    vectorExtensionAvailable = false;
  }
  
  return vectorExtensionAvailable;
}

function detectMemoryEnhancement() {
  if (memoryEnhancementAvailable !== null) return memoryEnhancementAvailable;
  
  try {
    // Try to import the BASE object from memory enhancement
    const meExtensionPath = '../../st-memory-enhancement/core/manager.js';
    // Check if extension exists by looking for its container in DOM
    const meExists = document.querySelector('[data-name=\"st-memory-enhancement\"]') !== null;
    memoryEnhancementAvailable = meExists;
  } catch (e) {
    memoryEnhancementAvailable = false;
  }
  
  return memoryEnhancementAvailable;
}

// ========== World Info Cache Functions ==========

async function summarizeWorldInfo() {
  const settings = getSettings();
  abortController = new AbortController();
  
  try {
    // Import world_info module
    const { world_info } = await import('/scripts/world-info.js');
    
    if (!world_info || !world_info.globalSelect) {
      toastr.error('No world info data found');
      return;
    }
    
    const allEntries = [];
    
    // Collect all enabled entries from global books
    for (const bookName of world_info.globalSelect || []) {
      const bookData = world_info[bookName];
      if (!bookData || !bookData.entries) continue;
      
      for (const [uid, entry] of Object.entries(bookData.entries)) {
        if (entry.disable) continue;
        allEntries.push({ uid: String(uid), entry, bookName });
      }
    }
    
    if (allEntries.length === 0) {
      toastr.info('No enabled world info entries found');
      return;
    }
    
    let processed = 0;
    let hits = 0;
    let misses = 0;
    
    const toast = toastr.info(`Processing world info entries: 0/${allEntries.length}`, 'Summarizing', { timeOut: 0, extendedTimeOut: 0 });
    
    for (const { uid, entry, bookName } of allEntries) {
      if (abortController.signal.aborted) {
        toastr.warning(`Cancelled: ${processed}/${allEntries.length} completed`);
        return;
      }
      
      const content = String(entry.content || '');
      const contentHash = String(getStringHash(content));
      
      // Check cache
      if (settings.wiCache[uid] && settings.wiCache[uid].contentHash === contentHash) {
        hits++;
        processed++;
        continue;
      }
      
      // Call Ollama for summaries
      misses++;
      
      const systemPrompt = `You are a summarization assistant. Create two levels of summary for the provided lore text.
Level 1: A concise 2-3 sentence summary that preserves most important details.
Level 2: An ultra-brief one-sentence summary with only the core essence.
Return ONLY valid JSON: {"level1": "...", "level2": "..."}`;
      
      const userPrompt = `Summarize this lore entry:\n\n${content}`;
      
      try {
        const raw = await callSidekickOllamaJSON({
          system: systemPrompt,
          user: userPrompt,
          model: settings.ollama.model,
          url: settings.ollama.url,
          temperature: 0.2,
          max_tokens: 500,
        });
        
        const result = safeJsonExtract(raw);
        
        if (result && result.level1 && result.level2) {
          settings.wiCache[uid] = {
            contentHash,
            level1: String(result.level1),
            level2: String(result.level2),
            original: content.slice(0, 500),
            keys: entry.key || [],
            timestamp: Date.now(),
            manuallyEdited: false,
          };
        }
      } catch (e) {
        console.error(`Failed to summarize WI entry ${uid}:`, e);
      }
      
      processed++;
      toast.find('.toast-message').text(`Processing world info entries: ${processed}/${allEntries.length}`);
      
      // Small delay to avoid overwhelming the API
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    settings.wiCacheStats.hits = hits;
    settings.wiCacheStats.misses = misses;
    settings.wiCacheStats.lastUpdate = Date.now();
    saveSettingsDebounced();
    
    toastr.clear(toast);
    toastr.success(`Summarized ${allEntries.length} entries (${hits} cached, ${misses} new)`);
    
  } catch (e) {
    console.error('summarizeWorldInfo failed:', e);
    toastr.error(`Failed: ${e.message}`);
  } finally {
    abortController = null;
  }
}

async function showWICacheViewer() {
  const settings = getSettings();
  const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'wi-cache-viewer');
  const popup = callGenericPopup(html, POPUP_TYPE.TEXT, 'World Info Cache', { wide: true, large: true, allowVerticalScrolling: true });
  
  await popup;
  
  // Populate stats
  $('#st_sidekick_cache_total').text(Object.keys(settings.wiCache).length);
  $('#st_sidekick_cache_hits').text(settings.wiCacheStats.hits || 0);
  $('#st_sidekick_cache_misses').text(settings.wiCacheStats.misses || 0);
  $('#st_sidekick_cache_last_update').text(
    settings.wiCacheStats.lastUpdate 
      ? new Date(settings.wiCacheStats.lastUpdate).toLocaleString() 
      : 'Never'
  );
  
  // Populate table
  const tbody = $('#st_sidekick_cache_table_body');
  tbody.empty();
  
  for (const [uid, entry] of Object.entries(settings.wiCache)) {
    const row = $('<tr></tr>');
    if (entry.manuallyEdited) row.addClass('st_sidekick_cache_row_edited');
    
    row.append(`<td>${(entry.keys || []).join(', ')}</td>`);
    row.append(`<td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis;">${entry.original || ''}</td>`);
    
    const level1Cell = $('<td class="editable"></td>').text(entry.level1 || '');
    const level2Cell = $('<td class="editable"></td>').text(entry.level2 || '');
    
    level1Cell.on('click', function() {
      const textarea = $('<textarea></textarea>').val(entry.level1);
      $(this).empty().append(textarea);
      textarea.focus();
      textarea.on('blur', function() {
        entry.level1 = textarea.val();
        entry.manuallyEdited = true;
        settings.wiCache[uid] = entry;
        saveSettingsDebounced();
        level1Cell.text(entry.level1);
        row.addClass('st_sidekick_cache_row_edited');
      });
    });
    
    level2Cell.on('click', function() {
      const textarea = $('<textarea></textarea>').val(entry.level2);
      $(this).empty().append(textarea);
      textarea.focus();
      textarea.on('blur', function() {
        entry.level2 = textarea.val();
        entry.manuallyEdited = true;
        settings.wiCache[uid] = entry;
        saveSettingsDebounced();
        level2Cell.text(entry.level2);
        row.addClass('st_sidekick_cache_row_edited');
      });
    });
    
    row.append(level1Cell);
    row.append(level2Cell);
    
    const actionsCell = $('<td></td>');
    const deleteBtn = $('<button class="menu_button">Delete</button>');
    deleteBtn.on('click', function() {
      delete settings.wiCache[uid];
      saveSettingsDebounced();
      row.remove();
      $('#st_sidekick_cache_total').text(Object.keys(settings.wiCache).length);
    });
    actionsCell.append(deleteBtn);
    row.append(actionsCell);
    
    tbody.append(row);
  }
  
  // Clear cache button
  $('#st_sidekick_cache_clear').off('click').on('click', async function() {
    const includeEdited = $('#st_sidekick_cache_include_edited').prop('checked');
    
    if (!includeEdited) {
      // Keep manually edited entries
      for (const uid in settings.wiCache) {
        if (!settings.wiCache[uid].manuallyEdited) {
          delete settings.wiCache[uid];
        }
      }
    } else {
      settings.wiCache = {};
    }
    
    settings.wiCacheStats = { hits: 0, misses: 0, lastUpdate: null };
    saveSettingsDebounced();
    
    // Close popup and re-summarize
    $('.popup-text-close').click();
    await summarizeWorldInfo();
  });
}

// ========== Message Summarization ==========

async function summarizeAssistantMessage(messageIndex) {
  const settings = getSettings();
  const ctx = getContext();
  const message = ctx.chat[messageIndex];
  
  if (!message || message.is_user || message.extra?.sidekick_summary) return;
  
  const content = String(message.mes || '').trim();
  if (!content || content.length < 50) return;
  
  try {
    const systemPrompt = 'Summarize the assistant message in ONE sentence (max 100 chars). Focus on key actions/information.';
    const raw = await callSidekickOllamaJSON({
      system: systemPrompt,
      user: content,
      model: settings.ollama.model,
      url: settings.ollama.url,
      temperature: 0.2,
      max_tokens: 100,
    });
    
    const summary = raw.trim().slice(0, 150);
    
    if (!message.extra) message.extra = {};
    message.extra.sidekick_summary = summary;
    ctx.saveChat();
    
  } catch (e) {
    console.error('Failed to summarize message:', e);
  }
}

async function summarizeAllMessages() {
  const ctx = getContext();
  const chat = ctx.chat || [];
  
  const assistantMessages = chat
    .map((m, i) => ({ msg: m, index: i }))
    .filter(({ msg }) => !msg.is_user && !msg.is_system && !msg.extra?.sidekick_summary);
  
  if (assistantMessages.length === 0) {
    toastr.info('All assistant messages already summarized');
    return;
  }
  
  const toast = toastr.info(`Summarizing messages: 0/${assistantMessages.length}`, 'Processing', { timeOut: 0 });
  
  for (let i = 0; i < assistantMessages.length; i++) {
    await summarizeAssistantMessage(assistantMessages[i].index);
    toast.find('.toast-message').text(`Summarizing messages: ${i + 1}/${assistantMessages.length}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  toastr.clear(toast);
  toastr.success(`Summarized ${assistantMessages.length} messages`);
}

// ========== Vector Indexing ==========

async function indexWorldInfoToVectors() {
  const settings = getSettings();
  
  if (!await detectVectorExtension()) {
    toastr.error('Vector extension not found. Please install it first.');
    return;
  }
  
  if (Object.keys(settings.wiCache).length === 0) {
    toastr.warning('No WI cache entries. Please run "Summarize World Info" first.');
    return;
  }
  
  const ctx = getContext();
  const collectionId = 'sidekick_wi_summaries';
  
  try {
    const toast = toastr.info('Indexing world info to vectors...', 'Processing', { timeOut: 0 });
    
    let indexed = 0;
    for (const [uid, entry] of Object.entries(settings.wiCache)) {
      const text = `${entry.level1}\\n${entry.level2}`;
      const hash = String(uid);
      
      const response = await fetch('/api/vector/insert', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({
          collectionId,
          text,
          hash,
          metadata: {
            entryUid: uid,
            keys: entry.keys,
            level1: entry.level1,
            level2: entry.level2,
          },
          source: settings.rag.embeddingProvider,
        }),
      });
      
      if (!response.ok) {
        console.warn(`Failed to index WI entry ${uid}`);
      }
      
      indexed++;
      toast.find('.toast-message').text(`Indexing: ${indexed}/${Object.keys(settings.wiCache).length}`);
    }
    
    toastr.clear(toast);
    toastr.success(`Indexed ${indexed} WI entries to vectors`);
    
  } catch (e) {
    console.error('Failed to index WI:', e);
    toastr.error(`Indexing failed: ${e.message}`);
  }
}

// ========== Prompt Diff Viewer ==========

async function showPromptDiffViewer() {
  if (!promptBefore || !promptAfter) {
    toastr.warning('No prompt data captured yet. Generate a message first.');
    return;
  }
  
  const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'prompt-viewer');
  const popup = callGenericPopup(html, POPUP_TYPE.TEXT, 'Prompt Diff', { wide: true, large: true });
  
  await popup;
  
  $('#st_sidekick_prompt_before').text(JSON.stringify(promptBefore, null, 2));
  $('#st_sidekick_prompt_after').text(JSON.stringify(promptAfter, null, 2));
  
  const removedCount = promptBefore.length - promptAfter.length;
  $('#st_sidekick_prompt_removed').text(removedCount);
  
  // Calculate tokens
  const beforeText = promptBefore.map(m => m.content).join('\\n');
  const afterText = promptAfter.map(m => m.content).join('\\n');
  
  const tokensBefore = await getTokenCountAsync(beforeText);
  const tokensAfter = await getTokenCountAsync(afterText);
  
  $('#st_sidekick_prompt_tokens_before').text(tokensBefore);
  $('#st_sidekick_prompt_tokens_after').text(tokensAfter);
}

// ========== Memory Enhancement Integration ==========

async function getMemoryEnhancementBase() {
  try {
    const { BASE } = await import('../../st-memory-enhancement/core/manager.js');
    return BASE;
  } catch (e) {
    return null;
  }
}

async function filterMemoryTableRows(lastUserMessage) {
  const settings = getSettings();
  
  if (!settings.memoryEnhancement.enabled || !detectMemoryEnhancement()) {
    return null;
  }
  
  const BASE = await getMemoryEnhancementBase();
  if (!BASE) return null;
  
  try {
    const sheets = BASE.getChatSheets();
    if (!sheets || sheets.length === 0) return null;
    
    const enabledSheets = sheets.filter(sheet => sheet.enable);
    if (enabledSheets.length === 0) return null;
    
    const allRows = [];
    
    // Collect all rows from all enabled sheets
    for (const sheet of enabledSheets) {
      if (!sheet.hashSheet || sheet.hashSheet.length <= 1) continue; // Skip if no data rows
      
      for (let rowIndex = 1; rowIndex < sheet.hashSheet.length; rowIndex++) {
        const row = sheet.hashSheet[rowIndex];
        const rowData = {
          sheetUid: sheet.uid,
          sheetName: sheet.name || 'Unnamed',
          rowIndex,
          cells: /** @type {string[]} */ ([]),
          text: '',
        };
        
        // Extract cell values
        for (const cellUid of row) {
          const cell = sheet.cells.get(cellUid);
          if (cell && cell.value) {
            rowData.cells.push(String(cell.value));
            rowData.text += String(cell.value) + ' ';
          }
        }
        
        rowData.text = rowData.text.trim();
        if (rowData.text.length > 0) {
          allRows.push(rowData);
        }
      }
    }
    
    if (allRows.length === 0) return null;
    
    // Apply filtering method
    let filteredRows = [];
    
    switch (settings.memoryEnhancement.rowFilterMethod) {
      case 'vector':
        filteredRows = await filterRowsByVector(allRows, lastUserMessage, settings);
        break;
      case 'keyword':
        filteredRows = filterRowsByKeyword(allRows, lastUserMessage, settings);
        break;
      case 'hybrid':
        // First keyword filter, then vector rank
        const keywordFiltered = filterRowsByKeyword(allRows, lastUserMessage, { ...settings, memoryEnhancement: { ...settings.memoryEnhancement, maxRowsInPrompt: Math.min(20, allRows.length) } });
        filteredRows = await filterRowsByVector(keywordFiltered, lastUserMessage, settings);
        break;
      default:
        filteredRows = allRows.slice(0, settings.memoryEnhancement.maxRowsInPrompt);
    }
    
    // Format for prompt
    if (filteredRows.length === 0) return null;
    
    const lines = ['[Memory Tables - Relevant Rows]'];
    let currentSheet = null;
    
    for (const row of filteredRows) {
      if (row.sheetName !== currentSheet) {
        currentSheet = row.sheetName;
        lines.push(`\\n${currentSheet}:`);
      }
      lines.push(`  ${row.cells.join(' | ')}`);
    }
    
    return lines.join('\\n');
    
  } catch (e) {
    if (settings.debug) {
      console.error('[SidekickPipeline] Memory Enhancement row filtering failed:', e);
    }
    return null;
  }
}

async function filterRowsByVector(rows, queryText, settings) {
  if (!await detectVectorExtension() || rows.length === 0) {
    return rows.slice(0, settings.memoryEnhancement.maxRowsInPrompt);
  }
  
  try {
    const ctx = getContext();
    const collectionId = 'sidekick_memory_rows';
    
    // Index rows if needed (check if collection exists)
    const checkResponse = await fetch('/api/vector/list-collections', {
      method: 'POST',
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify({}),
    });
    
    if (checkResponse.ok) {
      const collections = await checkResponse.json();
      const exists = collections.includes(collectionId);
      
      if (!exists) {
        // Index all rows
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          await fetch('/api/vector/insert', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({
              collectionId,
              text: row.text,
              hash: `${row.sheetUid}_${row.rowIndex}`,
              metadata: {
                sheetUid: row.sheetUid,
                sheetName: row.sheetName,
                rowIndex: row.rowIndex,
                cells: row.cells,
              },
              source: settings.rag.embeddingProvider,
            }),
          });
        }
      }
    }
    
    // Query for relevant rows
    const queryResponse = await fetch('/api/vector/query', {
      method: 'POST',
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify({
        collectionId,
        searchText: queryText,
        topK: settings.memoryEnhancement.maxRowsInPrompt,
        threshold: settings.memoryEnhancement.relevanceThreshold,
        source: settings.rag.embeddingProvider,
      }),
    });
    
    if (!queryResponse.ok) {
      return rows.slice(0, settings.memoryEnhancement.maxRowsInPrompt);
    }
    
    const results = await queryResponse.json();
    
    if (!results.metadata || results.metadata.length === 0) {
      return rows.slice(0, settings.memoryEnhancement.maxRowsInPrompt);
    }
    
    // Map results back to rows
    const filteredRows = results.metadata.map(meta => {
      const matchingRow = rows.find(r => 
        r.sheetUid === meta.sheetUid && r.rowIndex === meta.rowIndex
      );
      return matchingRow || {
        sheetUid: meta.sheetUid,
        sheetName: meta.sheetName,
        rowIndex: meta.rowIndex,
        cells: meta.cells,
        text: meta.cells.join(' '),
      };
    });
    
    return filteredRows;
    
  } catch (e) {
    console.error('Vector filtering failed:', e);
    return rows.slice(0, settings.memoryEnhancement.maxRowsInPrompt);
  }
}

function filterRowsByKeyword(rows, queryText, settings) {
  // Extract keywords from query
  const keywords = queryText
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 20);
  
  if (keywords.length === 0) {
    return rows.slice(0, settings.memoryEnhancement.maxRowsInPrompt);
  }
  
  // Score each row by keyword matches
  const scored = rows.map(row => {
    const rowText = row.text.toLowerCase();
    const matches = keywords.filter(kw => rowText.includes(kw)).length;
    return { row, score: matches };
  }).filter(item => item.score > 0);
  
  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  
  return scored
    .slice(0, settings.memoryEnhancement.maxRowsInPrompt)
    .map(item => item.row);
}

function setupUi() {
  const settings = getSettings();

  $('#st_sidekick_pipeline_enabled').prop('checked', !!settings.enabled);
  $('#st_sidekick_pipeline_reduce_history').prop('checked', !!settings.reduceHistory);
  $('#st_sidekick_pipeline_debug').prop('checked', !!settings.debug);

  $('#st_sidekick_pipeline_ollama_url').val(settings.ollama.url);
  $('#st_sidekick_pipeline_ollama_model').val(settings.ollama.model);
  $('#st_sidekick_pipeline_keep_last').val(settings.preserveLastMessages);

  $('#st_sidekick_pipeline_start_occ').val(settings.thresholds.startOccupancy);
  $('#st_sidekick_pipeline_cooldown').val(settings.thresholds.minTurnsBetween);
  
  // RAG settings
  $('#st_sidekick_pipeline_rag_enabled').prop('checked', !!settings.rag.enabled);
  $('#st_sidekick_pipeline_rag_threshold').val(settings.rag.threshold);
  $('#st_sidekick_pipeline_rag_topk').val(settings.rag.topK);
  $('#st_sidekick_pipeline_embedding_provider').val(settings.rag.embeddingProvider);
  
  // Memory Enhancement settings
  $('#st_sidekick_pipeline_memory_enabled').prop('checked', !!settings.memoryEnhancement.enabled);
  $('#st_sidekick_pipeline_memory_max_rows').val(settings.memoryEnhancement.maxRowsInPrompt);
  $('#st_sidekick_pipeline_memory_threshold').val(settings.memoryEnhancement.relevanceThreshold);
  $('#st_sidekick_pipeline_memory_filter_method').val(settings.memoryEnhancement.rowFilterMethod);

  const save = debounce(() => {
    const s = getSettings();
    s.enabled = $('#st_sidekick_pipeline_enabled').prop('checked');
    s.reduceHistory = $('#st_sidekick_pipeline_reduce_history').prop('checked');
    s.debug = $('#st_sidekick_pipeline_debug').prop('checked');

    s.ollama.url = String($('#st_sidekick_pipeline_ollama_url').val() || '').trim() || defaultSettings.ollama.url;
    s.ollama.model = String($('#st_sidekick_pipeline_ollama_model').val() || '').trim() || defaultSettings.ollama.model;
    s.preserveLastMessages = Number($('#st_sidekick_pipeline_keep_last').val() || defaultSettings.preserveLastMessages);

    s.thresholds.startOccupancy = Number($('#st_sidekick_pipeline_start_occ').val() || defaultSettings.thresholds.startOccupancy);
    s.thresholds.minTurnsBetween = Number($('#st_sidekick_pipeline_cooldown').val() || defaultSettings.thresholds.minTurnsBetween);
    
    // RAG settings
    s.rag.enabled = $('#st_sidekick_pipeline_rag_enabled').prop('checked');
    s.rag.threshold = Number($('#st_sidekick_pipeline_rag_threshold').val() || 0.7);
    s.rag.topK = Number($('#st_sidekick_pipeline_rag_topk').val() || 5);
    s.rag.embeddingProvider = String($('#st_sidekick_pipeline_embedding_provider').val() || 'transformers');
    
    // Memory Enhancement settings
    s.memoryEnhancement.enabled = $('#st_sidekick_pipeline_memory_enabled').prop('checked');
    s.memoryEnhancement.maxRowsInPrompt = Number($('#st_sidekick_pipeline_memory_max_rows').val() || 10);
    s.memoryEnhancement.relevanceThreshold = Number($('#st_sidekick_pipeline_memory_threshold').val() || 0.6);
    s.memoryEnhancement.rowFilterMethod = String($('#st_sidekick_pipeline_memory_filter_method').val() || 'vector');

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
  
  // New button handlers
  $('#st_sidekick_pipeline_summarize_wi').off('click').on('click', summarizeWorldInfo);
  $('#st_sidekick_pipeline_view_wi_cache').off('click').on('click', showWICacheViewer);
  $('#st_sidekick_pipeline_summarize_messages').off('click').on('click', summarizeAllMessages);
  $('#st_sidekick_pipeline_index_wi_vectors').off('click').on('click', indexWorldInfoToVectors);
  $('#st_sidekick_pipeline_show_prompt_diff').off('click').on('click', showPromptDiffViewer);
}

jQuery(async () => {
  const settingsHtml = await renderExtensionTemplateAsync(EXTENSION_NAME, 'settings', { defaultSettings });
  $('#extensions_settings2').append(settingsHtml);
  
  // Add wand menu button
  const wandHtml = await renderExtensionTemplateAsync(EXTENSION_NAME, 'wand-button');
  $('#st_sidekick_pipeline_wand_container').html(wandHtml);
  
  // Wire wand button to open settings
  $('#st_sidekick_pipeline_wand_button').on('click', () => {
    $('#extensionsMenuButton').trigger('click');
    setTimeout(() => {
      const settingsBlock = $('#st_sidekick_pipeline_settings').closest('.inline-drawer');
      if (settingsBlock.length) {
        settingsBlock[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 100);
  });
  
  setupUi();
  
  // Check for extensions and update UI
  await detectVectorExtension();
  detectMemoryEnhancement();
  
  if (!vectorExtensionAvailable) {
    $('#st_sidekick_vector_warning').show();
  }
  
  if (memoryEnhancementAvailable) {
    $('#st_sidekick_memory_status').text('✓ Memory Enhancement detected').css('color', 'green');
  } else {
    $('#st_sidekick_memory_status').text('✗ Not found (optional)').css('color', 'gray');
  }
  
  // Hook MESSAGE_RECEIVED for auto-summarization
  eventSource.on(event_types.MESSAGE_RECEIVED, async (messageIndex) => {
    const settings = getSettings();
    if (!settings.enabled) return;
    
    const ctx = getContext();
    const msg = ctx.chat[messageIndex];
    if (msg && !msg.is_user && !msg.is_system) {
      await summarizeAssistantMessage(messageIndex);
    }
  });

  eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, async (eventData) => {
    const settings = getSettings();
    if (!settings.enabled) return;
    if (!lastRun || !shouldRunForType(lastRun.type)) return;
    if (eventData?.dryRun) return;
    if (!Array.isArray(eventData.chat)) return;

    // Capture prompt before modifications
    promptBefore = JSON.parse(JSON.stringify(eventData.chat));
    
    const meta = getPipelineMetadata();
    
    // Memory Enhancement: Filter and inject relevant table rows
    if (settings.memoryEnhancement.enabled && detectMemoryEnhancement()) {
      try {
        const lastUserMsg = eventData.chat.filter(m => m.role === 'user').slice(-1)[0];
        if (lastUserMsg) {
          const memoryContext = await filterMemoryTableRows(lastUserMsg.content);
          if (memoryContext) {
            setExtensionPrompt(
              'st_sidekick_pipeline_memory',
              memoryContext,
              extension_prompt_types.IN_PROMPT,
              0,
              false,
              extension_prompt_roles.SYSTEM
            );
          }
        }
      } catch (e) {
        if (settings.debug) console.error('[SidekickPipeline] Memory Enhancement filtering failed:', e);
      }
    }
    
    // RAG: Inject relevant WI summaries
    if (settings.rag.enabled && await detectVectorExtension()) {
      try {
        const lastUserMsg = eventData.chat.filter(m => m.role === 'user').slice(-1)[0];
        if (lastUserMsg) {
          const ctx = getContext();
          const response = await fetch('/api/vector/query', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({
              collectionId: 'sidekick_wi_summaries',
              searchText: lastUserMsg.content,
              topK: settings.rag.topK,
              threshold: settings.rag.threshold,
              source: settings.rag.embeddingProvider,
            }),
          });
          
          if (response.ok) {
            const results = await response.json();
            if (results.metadata && results.metadata.length > 0) {
              const ragContext = results.metadata
                .map(m => `- ${m.level2 || m.text}`)
                .join('\\n');
              
              if (ragContext) {
                setExtensionPrompt(
                  'st_sidekick_pipeline_rag',
                  `[RAG Context]\\n${ragContext}`,
                  extension_prompt_types.IN_PROMPT,
                  0,
                  false,
                  extension_prompt_roles.SYSTEM
                );
              }
            }
          }
        }
      } catch (e) {
        if (settings.debug) console.error('[SidekickPipeline] RAG failed:', e);
      }
    }

    let removedMsgs = 0;
    if (settings.reduceHistory && meta?.lastState && meta?.lastMesHash && lastRun?.lastMesHash && meta.lastMesHash === lastRun.lastMesHash) {
      removedMsgs = reduceHistoryInPrompt(eventData.chat, meta.preserveLastMessages || settings.preserveLastMessages);
    }
    
    // Capture prompt after modifications
    promptAfter = JSON.parse(JSON.stringify(eventData.chat));

    if (settings.debug && removedMsgs) {
      console.debug('[SidekickPipeline] removed msgs:', removedMsgs);
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
