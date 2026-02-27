/**
 * @file src/popup/popup.ts
 *
 * @description
 * Popup UI logic for CZ MultiViewer extension.
 *
 * Responsibilities:
 * - Parse user input into CHZZK channel IDs
 * - Preview recognized / invalid channels
 * - Fetch channel display names via background
 * - Open hosted multiview page with selected channels
 *
 * Notes:
 * - This file contains no background logic
 * - All heavy work is delegated to background or hosted web page
 */

(() => {
  // ---------------------------------------------------------------------------
  // Global bridge
  // ---------------------------------------------------------------------------

  type PopupCMV = {
    MSG: Record<string, string>;
    safeTrim: (x: unknown) => string;
    extractChannelId: (input: string) => string | null;
    [key: string]: unknown;
  };

  const CMV = (globalThis as any).CMV as PopupCMV | undefined;
  if (!CMV) return;

  const { MSG, safeTrim, extractChannelId } = CMV;

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  // /multiview?c=... uses repeated params (e.g. ?c=aaa&c=bbb)
  const PROD_BASE_URL = 'https://czviewer.duna.me';
  const DEV_BASE_URL = 'http://localhost:8787';
  const STORAGE_KEY_HEADER_DEFAULT = 'cmv-header-default';
  const STORAGE_KEY_CHAT_POSITION = 'cmv-chat-position';
  const STORAGE_KEY_AUTO_REWARD_CLAIM = 'cmv-auto-reward-claim';
  const STORAGE_KEY_AUTO_FF = 'cmv-auto-ff';
  const STORAGE_KEY_AUTO_FF_THRESHOLD = 'cmv-auto-ff-threshold';
  const STORAGE_KEY_SHOW_CHAT_TIMESTAMP = 'czmv:showChatTimestamp';
  const STORAGE_KEY_FAVORITES = 'czmv:favorites';
  const HEADER_DEFAULT_ON = 'on';
  const HEADER_DEFAULT_OFF = 'off';
  const CHAT_POSITION_RIGHT = 'right';
  const CHAT_POSITION_LEFT = 'left';
  const AUTO_REWARD_CLAIM_ENABLED = '1';
  const AUTO_REWARD_CLAIM_DISABLED = '0';
  const AUTO_FF_ENABLED = '1';
  const AUTO_FF_DISABLED = '0';
  const AUTO_FF_THRESHOLD_DEFAULT = 12;
  const AUTO_FF_THRESHOLD_MIN = 5;
  const AUTO_FF_THRESHOLD_MAX = 30;
  const DEFAULT_SHOW_CHAT_TIMESTAMP = false;
  const FAVORITE_ICON_ON = '♥';
  const FAVORITE_ICON_OFF = '♡';

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

  const getInput = (): HTMLTextAreaElement => $('input') as HTMLTextAreaElement;

  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------

  type ParseResult = {
    ids: string[];
    invalid: string[];
  };

  type ChannelItem = {
    id: string;
    label: string;
  };

  type FavoriteChannel = {
    channelId: string;
    name?: string;
    addedAt: number;
  };

  let recognizedChannels: ChannelItem[] = [];
  let lastInvalid: string[] = [];
  let draggingChannelId: string | null = null;
  let dropTarget: { id: string; placeAfter: boolean } | null = null;

  /**
   * Parse raw textarea input into:
   * - unique channel IDs
   * - invalid (unrecognized) lines
   */
  function parseInput(text: string): ParseResult {
    const tokens = safeTrim(text)
      .split(/\r?\n/)
      .map((v) => safeTrim(v))
      .filter(Boolean);

    const uniq: string[] = [];
    const seen = new Set<string>();
    const invalid: string[] = [];

    for (const t of tokens) {
      const id = extractChannelId(t);
      if (!id) {
        invalid.push(t);
        continue;
      }
      if (!seen.has(id)) {
        seen.add(id);
        uniq.push(id);
      }
    }

    return { ids: uniq, invalid };
  }

  function syncRecognizedChannels(nextIds: string[]): void {
    const existing = new Map(recognizedChannels.map((item) => [item.id, item]));
    const nextSet = new Set(nextIds);
    const next: ChannelItem[] = [];

    for (const item of recognizedChannels) {
      if (nextSet.has(item.id)) {
        next.push(item);
      }
    }

    for (const id of nextIds) {
      if (!existing.has(id)) {
        next.push({ id, label: id });
      }
    }

    recognizedChannels = next;
  }

  function updateFromInputValue(value: string): void {
    const parsed = parseInput(value);
    lastInvalid = parsed.invalid;
    syncRecognizedChannels(parsed.ids);
    renderPreview();
  }

  function syncInputFromRecognized(): void {
    const box = getInput();
    const tokens = safeTrim(box.value)
      .split(/\r?\n/)
      .map((v) => safeTrim(v))
      .filter(Boolean);

    const idToLine = new Map<string, string>();
    const invalid: string[] = [];

    for (const token of tokens) {
      const id = extractChannelId(token);
      if (!id) {
        invalid.push(token);
        continue;
      }
      if (!idToLine.has(id)) {
        idToLine.set(id, token);
      }
    }

    const ordered = recognizedChannels.map((item) => idToLine.get(item.id) ?? item.id);
    const nextLines = invalid.length ? ordered.concat(invalid) : ordered;
    box.value = nextLines.join('\n');
    lastInvalid = invalid;
    saveNow();
  }

  function moveRecognizedNear(fromId: string, targetId: string, placeAfter: boolean): void {
    if (!fromId || !targetId || fromId === targetId) return;

    const fromIndex = recognizedChannels.findIndex((item) => item.id === fromId);
    const targetIndex = recognizedChannels.findIndex((item) => item.id === targetId);
    if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return;

    const [moved] = recognizedChannels.splice(fromIndex, 1);
    const baseIndex = recognizedChannels.findIndex((item) => item.id === targetId);
    if (baseIndex < 0) return;

    const insertIndex = placeAfter ? baseIndex + 1 : baseIndex;
    recognizedChannels.splice(insertIndex, 0, moved);

    syncInputFromRecognized();
  }

  function moveRecognizedToEnd(fromId: string): void {
    if (!fromId || recognizedChannels.length < 2) return;
    const lastId = recognizedChannels[recognizedChannels.length - 1]?.id;
    if (!lastId) return;
    moveRecognizedNear(fromId, lastId, true);
  }

  function clearDropIndicator(container: HTMLElement): void {
    container.querySelectorAll<HTMLElement>('.chip.is-drop-before, .chip.is-drop-after').forEach((el) => {
      el.classList.remove('is-drop-before', 'is-drop-after');
    });
  }

  function setDropIndicator(container: HTMLElement, target: { id: string; placeAfter: boolean } | null): void {
    clearDropIndicator(container);
    if (!target) return;

    const chipEls = container.querySelectorAll<HTMLElement>('.chip');
    for (const chipEl of chipEls) {
      if (chipEl.dataset.channelId !== target.id) continue;
      chipEl.classList.add(target.placeAfter ? 'is-drop-after' : 'is-drop-before');
      break;
    }
  }

  function resolveDropTarget(container: HTMLElement, clientY: number): { id: string; placeAfter: boolean } | null {
    const chipEls = container.querySelectorAll<HTMLElement>('.chip');

    for (const chipEl of chipEls) {
      const targetId = chipEl.dataset.channelId;
      if (!targetId || targetId === draggingChannelId) continue;

      const rect = chipEl.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;

      if (clientY < mid) return { id: targetId, placeAfter: false };
      if (clientY <= rect.bottom) return { id: targetId, placeAfter: true };
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Background helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve channel display name via background.
   * Returns null on failure.
   */
  function fetchChannelName(id: string): Promise<string | null> {
    return new Promise((resolve) => {
      if (!chrome?.runtime?.sendMessage) {
        resolve(null);
        return;
      }

      chrome.runtime.sendMessage(
        { type: MSG.FETCH_CHANNEL_NAME, id },
        (res: { ok?: boolean; name?: string | null } | undefined) => {
          if (!res || !res.ok) {
            resolve(null);
            return;
          }
          resolve(res.name ?? null);
        }
      );
    });
  }

  // ---------------------------------------------------------------------------
  // UI helpers
  // ---------------------------------------------------------------------------

  function removeChannelFromInput(targetId: string): void {
    const box = getInput();
    const lines = box.value.split(/\r?\n/);

    const kept: string[] = [];
    for (const line of lines) {
      const trimmed = safeTrim(line);
      if (!trimmed) continue;

      const lineId = extractChannelId(trimmed);
      if (lineId && lineId.toLowerCase() === targetId.toLowerCase()) {
        continue;
      }
      kept.push(trimmed);
    }

    box.value = kept.join('\n');
    saveNow();
    updateFromInputValue(box.value);
  }

  function renderPreview(): void {
    const count = $('count');
    const chips = $('chips');
    const errors = $('errors');

    const countPrefix = count.textContent?.split(':')[0] ?? '';
    count.textContent = countPrefix
      ? `${countPrefix}: ${recognizedChannels.length}`
      : String(recognizedChannels.length);
    chips.textContent = '';
    chips.ondragover = (e) => {
      if (!draggingChannelId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      dropTarget = resolveDropTarget(chips, e.clientY);
      setDropIndicator(chips, dropTarget);
    };
    chips.ondrop = (e) => {
      if (!draggingChannelId) return;
      e.preventDefault();
      const fromId = draggingChannelId;
      draggingChannelId = null;
      const target = dropTarget;
      dropTarget = null;
      clearDropIndicator(chips);
      if (target) {
        moveRecognizedNear(fromId, target.id, target.placeAfter);
      } else {
        moveRecognizedToEnd(fromId);
      }
      renderPreview();
    };
    chips.ondragleave = (e) => {
      const nextTarget = e.relatedTarget;
      if (nextTarget instanceof Node && chips.contains(nextTarget)) return;
      dropTarget = null;
      clearDropIndicator(chips);
    };

    // Render channel chips
    recognizedChannels.forEach((item) => {
      const id = item.id;
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.draggable = true;
      chip.dataset.channelId = id;
      chip.setAttribute('aria-label', '드래그로 순서 변경');

      const label = document.createElement('span');
      label.className = 'chip-label';
      label.textContent = item.label || id;
      label.title = item.label && item.label !== id ? `${item.label} (${id})` : id;

      const favoriteBtn = document.createElement('button');
      favoriteBtn.type = 'button';
      favoriteBtn.className = 'chip-fav';
      favoriteBtn.draggable = false;

      const syncFavoriteBtn = () => {
        const active = isFavorite(id);
        favoriteBtn.textContent = active ? FAVORITE_ICON_ON : FAVORITE_ICON_OFF;
        favoriteBtn.classList.toggle('is-active', active);
        favoriteBtn.title = active ? '즐겨찾기 삭제' : '즐겨찾기 추가';
      };

      syncFavoriteBtn();

      favoriteBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (isFavorite(id)) {
          removeFavorite(id);
        } else {
          addFavorite({
            channelId: id,
            name: item.label && item.label !== id ? item.label : undefined,
            addedAt: Date.now(),
          });
        }

        syncFavoriteBtn();
        renderFavoritesList();
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'chip-remove';
      removeBtn.title = '이 채널 제거';
      removeBtn.textContent = '×';
      removeBtn.draggable = false;
      removeBtn.addEventListener('click', () => {
        removeChannelFromInput(id);
      });

      const actions = document.createElement('div');
      actions.className = 'chip-actions';
      actions.appendChild(favoriteBtn);
      actions.appendChild(removeBtn);

      chip.addEventListener('dragstart', (e) => {
        draggingChannelId = id;
        dropTarget = null;
        chip.classList.add('is-dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', id);
        }
      });

      chip.addEventListener('dragend', () => {
        draggingChannelId = null;
        dropTarget = null;
        chip.classList.remove('is-dragging');
        clearDropIndicator(chips);
      });

      chip.appendChild(label);
      chip.appendChild(actions);
      chips.appendChild(chip);

      // Async channel name resolution
      if (item.label === id) {
        void fetchChannelName(id).then((name) => {
          if (!name) return;
          item.label = name;
          if (!chip.isConnected) return;
          label.textContent = name;
          label.title = `${name} (${id})`;
        });
      }
    });

    // Render invalid input summary
    if (lastInvalid.length) {
      const sample = lastInvalid.slice(0, 3).join(' / ');
      const moreCount = lastInvalid.length - 3;
      errors.textContent = lastInvalid.length > 3 ? `인식 불가: ${sample} 외 ${moreCount}개` : `인식 불가: ${sample}`;
    } else {
      errors.textContent = '';
    }
  }

  function renderFavoritesList(): void {
    const listEl = $('favoritesList') as HTMLElement | null;
    const emptyEl = $('favoritesEmpty') as HTMLElement | null;
    const noticeEl = $('favoritesNotice') as HTMLElement | null;
    if (!listEl) return;

    const setNotice = (message: string): void => {
      if (noticeEl) noticeEl.textContent = message;
    };

    const favorites = loadFavorites();
    listEl.textContent = '';
    setNotice('');

    if (emptyEl) {
      emptyEl.style.display = favorites.length ? 'none' : 'block';
    }

    favorites.forEach((fav) => {
      const item = document.createElement('div');
      item.className = 'favorite-item';

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'favorite-add';
      addBtn.textContent = formatFavoriteLabel(fav.channelId, fav.name);
      addBtn.title = fav.name ? `${fav.name} (${fav.channelId})` : fav.channelId;
      addBtn.addEventListener('click', () => {
        const resolvedId = extractChannelId(fav.channelId);
        if (resolvedId && recognizedChannels.some((item) => item.id === resolvedId)) {
          setNotice(`이미 추가됨: ${fav.name}`);
          return;
        }

        setNotice('');
        appendLine(fav.channelId);
        saveNow();
        updateFromInputValue(getInput().value);
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'favorite-remove';
      removeBtn.title = '즐겨찾기 삭제';
      removeBtn.textContent = '❌';
      removeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeFavorite(fav.channelId);
        setNotice('');
        renderFavoritesList();
        renderPreview();
      });

      item.appendChild(addBtn);
      item.appendChild(removeBtn);
      listEl.appendChild(item);
    });
  }

  // ---------------------------------------------------------------------------
  // URL helpers
  // ---------------------------------------------------------------------------

  type OpenSettings = {
    chatPosition: 'right' | 'left';
    headerDefault: 'on' | 'off';
    autoRewardClaimEnabled: boolean;
    autoFfEnabled: boolean;
    autoFfThreshold: number;
    showChatTimestamp: boolean;
  };

  function buildUrl(ids: string[], base: string, settings: OpenSettings): string {
    const params = new URLSearchParams();
    for (const id of ids) params.append('c', id);
    params.set('chat', settings.chatPosition);
    params.set('header', settings.headerDefault);
    params.set('lp', settings.autoRewardClaimEnabled ? '1' : '0');
    params.set('autoFF', settings.autoFfEnabled ? '1' : '0');
    params.set('autoFFThreshold', String(settings.autoFfThreshold));
    if (settings.showChatTimestamp) params.set('ts', '1');
    return `${base}/multiview?${params.toString()}`;
  }

  function resolveBaseUrl(tabUrl: string | undefined): string {
    if (typeof tabUrl === 'string' && tabUrl.startsWith(DEV_BASE_URL)) {
      return DEV_BASE_URL;
    }
    return PROD_BASE_URL;
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  function loadSaved(): void {
    const saved = localStorage.getItem('cmv-input');
    if (saved) {
      getInput().value = saved;
    }
  }

  function saveNow(): void {
    localStorage.setItem('cmv-input', getInput().value || '');
  }

  function loadHeaderDefault(): 'on' | 'off' {
    const saved = localStorage.getItem(STORAGE_KEY_HEADER_DEFAULT);
    return saved === HEADER_DEFAULT_OFF ? HEADER_DEFAULT_OFF : HEADER_DEFAULT_ON;
  }

  function saveHeaderDefault(value: 'on' | 'off'): void {
    localStorage.setItem(STORAGE_KEY_HEADER_DEFAULT, value);
  }

  function loadChatPosition(): 'right' | 'left' {
    const saved = localStorage.getItem(STORAGE_KEY_CHAT_POSITION);
    return saved === CHAT_POSITION_LEFT ? CHAT_POSITION_LEFT : CHAT_POSITION_RIGHT;
  }

  function saveChatPosition(value: 'right' | 'left'): void {
    localStorage.setItem(STORAGE_KEY_CHAT_POSITION, value);
  }

  function loadAutoRewardClaimEnabled(): '0' | '1' {
    const saved = localStorage.getItem(STORAGE_KEY_AUTO_REWARD_CLAIM);
    return saved === AUTO_REWARD_CLAIM_ENABLED ? AUTO_REWARD_CLAIM_ENABLED : AUTO_REWARD_CLAIM_DISABLED;
  }

  function saveAutoRewardClaimEnabled(value: '0' | '1'): void {
    localStorage.setItem(STORAGE_KEY_AUTO_REWARD_CLAIM, value);
  }

  function normalizeAutoFfThreshold(value: unknown): number {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return AUTO_FF_THRESHOLD_DEFAULT;
    return Math.min(AUTO_FF_THRESHOLD_MAX, Math.max(AUTO_FF_THRESHOLD_MIN, parsed));
  }

  function loadAutoFfEnabled(): '0' | '1' {
    const saved = localStorage.getItem(STORAGE_KEY_AUTO_FF);
    return saved === AUTO_FF_ENABLED ? AUTO_FF_ENABLED : AUTO_FF_DISABLED;
  }

  function saveAutoFfEnabled(value: '0' | '1'): void {
    localStorage.setItem(STORAGE_KEY_AUTO_FF, value);
  }

  function loadAutoFfThreshold(): number {
    const saved = localStorage.getItem(STORAGE_KEY_AUTO_FF_THRESHOLD);
    return normalizeAutoFfThreshold(saved);
  }

  function saveAutoFfThreshold(value: number): void {
    localStorage.setItem(STORAGE_KEY_AUTO_FF_THRESHOLD, String(normalizeAutoFfThreshold(value)));
  }

  function loadShowChatTimestamp(): Promise<boolean> {
    return Promise.resolve().then(() => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY_SHOW_CHAT_TIMESTAMP);
        if (raw === null) return DEFAULT_SHOW_CHAT_TIMESTAMP;
        return raw === 'true';
      } catch {
        return DEFAULT_SHOW_CHAT_TIMESTAMP;
      }
    });
  }

  function saveShowChatTimestamp(value: boolean): void {
    try {
      localStorage.setItem(STORAGE_KEY_SHOW_CHAT_TIMESTAMP, String(value));
    } catch {
      // ignore
    }
  }

  // ---------------------------------------------------------------------------
  // Favorites helpers
  // ---------------------------------------------------------------------------

  function normalizeFavoriteId(value: unknown): string {
    return safeTrim(value).toLowerCase();
  }

  function normalizeFavoriteName(value: unknown): string | undefined {
    const name = safeTrim(value);
    return name ? name : undefined;
  }

  function normalizeFavorites(input: unknown): FavoriteChannel[] {
    if (!Array.isArray(input)) return [];

    const byId = new Map<string, FavoriteChannel>();

    for (const raw of input) {
      const item = raw as Partial<FavoriteChannel> | null;
      const channelId = normalizeFavoriteId(item?.channelId);
      const addedAt = Number(item?.addedAt);
      if (!channelId || !Number.isFinite(addedAt)) continue;

      const name = normalizeFavoriteName(item?.name);
      const existing = byId.get(channelId);

      if (!existing || addedAt < existing.addedAt) {
        byId.set(channelId, {
          channelId,
          ...(name ? { name } : {}),
          addedAt,
        });
        continue;
      }

      if (!existing.name && name) {
        existing.name = name;
      }
    }

    const list = Array.from(byId.values());
    list.sort((a, b) => a.addedAt - b.addedAt);
    return list;
  }

  let favoritesCache: FavoriteChannel[] | null = null;
  let favoriteIdSetCache: Set<string> | null = null;

  function setFavoritesCache(list: unknown): FavoriteChannel[] {
    const normalized = normalizeFavorites(list);
    favoritesCache = normalized;
    favoriteIdSetCache = new Set(normalized.map((fav) => normalizeFavoriteId(fav.channelId)));
    return normalized;
  }

  function loadFavorites(): FavoriteChannel[] {
    if (favoritesCache) return favoritesCache;

    try {
      const raw = localStorage.getItem(STORAGE_KEY_FAVORITES);
      if (!raw) return setFavoritesCache([]);
      const parsed = JSON.parse(raw);
      return setFavoritesCache(parsed);
    } catch {
      return setFavoritesCache([]);
    }
  }

  function saveFavorites(list: FavoriteChannel[]): void {
    const normalized = setFavoritesCache(list);
    try {
      localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify(normalized));
    } catch {
      // ignore
    }
  }

  function isFavorite(channelId: string): boolean {
    const key = normalizeFavoriteId(channelId);
    if (!key) return false;
    if (!favoriteIdSetCache) {
      void loadFavorites();
    }
    return !!favoriteIdSetCache?.has(key);
  }

  function addFavorite(channel: FavoriteChannel): void {
    const key = normalizeFavoriteId(channel.channelId);
    if (!key) return;

    const list = loadFavorites();
    if (list.some((fav) => normalizeFavoriteId(fav.channelId) === key)) {
      return;
    }

    const name = normalizeFavoriteName(channel.name);
    list.push({
      channelId: key,
      ...(name ? { name } : {}),
      addedAt: Number.isFinite(channel.addedAt) && channel.addedAt > 0 ? channel.addedAt : Date.now(),
    });

    saveFavorites(list);
  }

  function removeFavorite(channelId: string): void {
    const key = normalizeFavoriteId(channelId);
    if (!key) return;

    const list = loadFavorites().filter((fav) => normalizeFavoriteId(fav.channelId) !== key);
    saveFavorites(list);
  }

  function formatFavoriteLabel(channelId: string, name?: string): string {
    const display = normalizeFavoriteName(name);
    if (display) return display;
    if (channelId.length <= 8) return channelId;
    return `${channelId.slice(0, 8)}…`;
  }

  // ---------------------------------------------------------------------------
  // Input helpers
  // ---------------------------------------------------------------------------

  function appendLine(value: string): void {
    const box = getInput();
    const cur = safeTrim(box.value);
    box.value = cur ? `${cur}\n${value}` : value;
  }

  async function grabFromCurrentTab(): Promise<boolean> {
    const tab = await new Promise<chrome.tabs.Tab | undefined>((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]));
    });

    const url = tab?.url ?? '';
    const id = extractChannelId(url);
    if (!id) return false;

    if (recognizedChannels.some((item) => item.id === id)) return true;

    appendLine(url);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Entry
  // ---------------------------------------------------------------------------

  function main(): void {
    const input = getInput();
    const headerToggle = $('headerDefaultToggle') as HTMLInputElement | null;
    const chatPositionRight = $('chatPositionRight') as HTMLInputElement | null;
    const chatPositionLeft = $('chatPositionLeft') as HTMLInputElement | null;
    const chatTimestampToggle = $('showChatTimestampToggle') as HTMLInputElement | null;
    const rewardClaimToggle = $('autoRewardClaimToggle') as HTMLInputElement | null;
    const autoFfToggle = $('autoFfToggle') as HTMLInputElement | null;
    const autoFfThreshold = $('autoFfThreshold') as HTMLInputElement | null;
    const autoFfPresets = Array.from(document.querySelectorAll('.auto-ff-preset')) as HTMLButtonElement[];
    const favoritesSection = $('favoritesSection') as HTMLElement | null;
    const favoritesToggle = $('favoritesToggle') as HTMLButtonElement | null;
    const optionsSection = $('optionsSection') as HTMLElement | null;
    const optionsToggle = $('optionsToggle') as HTMLButtonElement | null;

    loadSaved();
    if (headerToggle) {
      headerToggle.checked = loadHeaderDefault() === HEADER_DEFAULT_OFF;
      headerToggle.addEventListener('change', () => {
        const next = headerToggle.checked ? HEADER_DEFAULT_OFF : HEADER_DEFAULT_ON;
        saveHeaderDefault(next);
      });
    }
    if (chatPositionRight || chatPositionLeft) {
      const applyChatPositionValue = (value: 'right' | 'left') => {
        if (chatPositionRight) chatPositionRight.checked = value === CHAT_POSITION_RIGHT;
        if (chatPositionLeft) chatPositionLeft.checked = value === CHAT_POSITION_LEFT;
      };

      applyChatPositionValue(loadChatPosition());

      const onChatPositionChange = () => {
        const next = chatPositionLeft?.checked ? CHAT_POSITION_LEFT : CHAT_POSITION_RIGHT;
        applyChatPositionValue(next);
        saveChatPosition(next);
      };

      chatPositionRight?.addEventListener('change', onChatPositionChange);
      chatPositionLeft?.addEventListener('change', onChatPositionChange);
    }
    if (chatTimestampToggle) {
      void loadShowChatTimestamp().then((value) => {
        chatTimestampToggle.checked = value;
      });
      chatTimestampToggle.addEventListener('change', () => {
        saveShowChatTimestamp(!!chatTimestampToggle.checked);
      });
    }
    if (rewardClaimToggle) {
      rewardClaimToggle.checked = loadAutoRewardClaimEnabled() === AUTO_REWARD_CLAIM_ENABLED;
      rewardClaimToggle.addEventListener('change', () => {
        const next = rewardClaimToggle.checked ? AUTO_REWARD_CLAIM_ENABLED : AUTO_REWARD_CLAIM_DISABLED;
        saveAutoRewardClaimEnabled(next);
      });
    }
    if (autoFfThreshold) {
      autoFfThreshold.value = String(loadAutoFfThreshold());
      autoFfThreshold.addEventListener('change', () => {
        const next = normalizeAutoFfThreshold(autoFfThreshold.value);
        autoFfThreshold.value = String(next);
        saveAutoFfThreshold(next);
      });
    }
    if (autoFfToggle) {
      autoFfToggle.checked = loadAutoFfEnabled() === AUTO_FF_ENABLED;
      const syncAutoFfControls = () => {
        const enabled = !!autoFfToggle.checked;
        if (autoFfThreshold) autoFfThreshold.disabled = !enabled;
        autoFfPresets.forEach((btn) => {
          btn.disabled = !enabled;
        });
      };

      syncAutoFfControls();
      autoFfToggle.addEventListener('change', () => {
        const next = autoFfToggle.checked ? AUTO_FF_ENABLED : AUTO_FF_DISABLED;
        saveAutoFfEnabled(next);
        syncAutoFfControls();
      });
    }
    if (autoFfPresets.length && autoFfThreshold) {
      autoFfPresets.forEach((btn) => {
        btn.addEventListener('click', () => {
          const raw = btn.getAttribute('data-value');
          const next = normalizeAutoFfThreshold(raw);
          autoFfThreshold.value = String(next);
          saveAutoFfThreshold(next);
        });
      });
    }
    if (favoritesSection && favoritesToggle) {
      const syncFavoritesToggle = () => {
        const collapsed = favoritesSection.classList.contains('is-collapsed');
        favoritesToggle.setAttribute('aria-expanded', String(!collapsed));
      };

      syncFavoritesToggle();
      favoritesToggle.addEventListener('click', () => {
        favoritesSection.classList.toggle('is-collapsed');
        syncFavoritesToggle();
      });
    }
    if (optionsSection && optionsToggle) {
      const syncOptionsToggle = () => {
        const collapsed = optionsSection.classList.contains('is-collapsed');
        optionsToggle.setAttribute('aria-expanded', String(!collapsed));
      };

      syncOptionsToggle();
      optionsToggle.addEventListener('click', () => {
        optionsSection.classList.toggle('is-collapsed');
        syncOptionsToggle();
      });
    }
    updateFromInputValue(input.value);
    renderFavoritesList();

    input.addEventListener('input', () => {
      saveNow();
      updateFromInputValue(input.value);
    });

    $('clear').addEventListener('click', () => {
      input.value = '';
      saveNow();
      updateFromInputValue(input.value);
      input.focus();
    });

    $('grab').addEventListener('click', async () => {
      const ok = await grabFromCurrentTab();
      saveNow();
      updateFromInputValue(input.value);
      if (!ok) {
        $('errors').textContent = '현재 탭에서 치지직 채널/라이브 URL을 찾지 못했어요.';
      }
    });

    $('open').addEventListener('click', async () => {
      updateFromInputValue(input.value);
      const ids = recognizedChannels.map((item) => item.id);
      if (!ids.length) return;

      const tab = await new Promise<chrome.tabs.Tab | undefined>((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]));
      });

      const base = resolveBaseUrl(tab?.url);
      const showChatTimestamp = chatTimestampToggle ? chatTimestampToggle.checked : await loadShowChatTimestamp();
      const settings: OpenSettings = {
        chatPosition:
          chatPositionLeft || chatPositionRight
            ? chatPositionLeft?.checked
              ? CHAT_POSITION_LEFT
              : CHAT_POSITION_RIGHT
            : loadChatPosition(),
        headerDefault: headerToggle
          ? headerToggle.checked
            ? HEADER_DEFAULT_OFF
            : HEADER_DEFAULT_ON
          : loadHeaderDefault(),
        autoRewardClaimEnabled: rewardClaimToggle
          ? rewardClaimToggle.checked
          : loadAutoRewardClaimEnabled() === AUTO_REWARD_CLAIM_ENABLED,
        autoFfEnabled: autoFfToggle ? autoFfToggle.checked : loadAutoFfEnabled() === AUTO_FF_ENABLED,
        autoFfThreshold: normalizeAutoFfThreshold(autoFfThreshold?.value ?? loadAutoFfThreshold()),
        showChatTimestamp,
      };
      chrome.tabs.create({ url: buildUrl(ids, base, settings) });
    });

    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        $('open').click();
      }
    });
  }

  main();
})();
