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
  const STORAGE_KEY_AUTO_FF = 'cmv-auto-ff';
  const STORAGE_KEY_AUTO_FF_THRESHOLD = 'cmv-auto-ff-threshold';
  const HEADER_DEFAULT_ON = 'on';
  const HEADER_DEFAULT_OFF = 'off';
  const CHAT_POSITION_RIGHT = 'right';
  const CHAT_POSITION_LEFT = 'left';
  const AUTO_FF_ENABLED = '1';
  const AUTO_FF_DISABLED = '0';
  const AUTO_FF_THRESHOLD_DEFAULT = 12;
  const AUTO_FF_THRESHOLD_MIN = 5;
  const AUTO_FF_THRESHOLD_MAX = 30;

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

  let recognizedChannels: ChannelItem[] = [];
  let lastInvalid: string[] = [];

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

  function swapRecognized(index: number, direction: -1 | 1): void {
    const target = index + direction;
    if (target < 0 || target >= recognizedChannels.length) return;
    [recognizedChannels[index], recognizedChannels[target]] = [recognizedChannels[target], recognizedChannels[index]];
    syncInputFromRecognized();
    renderPreview();
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

    // Render channel chips
    const total = recognizedChannels.length;
    recognizedChannels.forEach((item, index) => {
      const id = item.id;
      const chip = document.createElement('div');
      chip.className = 'chip';

      const label = document.createElement('span');
      label.className = 'chip-label';
      label.textContent = item.label || id;
      label.title = item.label && item.label !== id ? `${item.label} (${id})` : id;

      const short = document.createElement('code');
      short.textContent = id.slice(0, 6);

      const moveUpBtn = document.createElement('button');
      moveUpBtn.type = 'button';
      moveUpBtn.className = 'chip-move chip-move-up';
      moveUpBtn.textContent = '\u2191';
      moveUpBtn.title = '위로 이동';
      moveUpBtn.setAttribute('aria-label', 'Move up');
      moveUpBtn.disabled = index === 0;
      moveUpBtn.addEventListener('click', () => swapRecognized(index, -1));

      const moveDownBtn = document.createElement('button');
      moveDownBtn.type = 'button';
      moveDownBtn.className = 'chip-move chip-move-down';
      moveDownBtn.textContent = '\u2193';
      moveDownBtn.title = '아래로 이동';
      moveDownBtn.setAttribute('aria-label', 'Move down');
      moveDownBtn.disabled = index === total - 1;
      moveDownBtn.addEventListener('click', () => swapRecognized(index, 1));

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'chip-remove';
      removeBtn.title = '이 채널 제거';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        removeChannelFromInput(id);
      });

      const actions = document.createElement('div');
      actions.className = 'chip-actions';
      actions.appendChild(moveUpBtn);
      actions.appendChild(moveDownBtn);
      actions.appendChild(removeBtn);

      chip.appendChild(label);
      chip.appendChild(short);
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

  // ---------------------------------------------------------------------------
  // URL helpers
  // ---------------------------------------------------------------------------

  type OpenSettings = {
    chatPosition: 'right' | 'left';
    headerDefault: 'on' | 'off';
    autoFfEnabled: boolean;
    autoFfThreshold: number;
  };

  function buildUrl(ids: string[], base: string, settings: OpenSettings): string {
    const params = new URLSearchParams();
    for (const id of ids) params.append('c', id);
    params.set('chat', settings.chatPosition);
    params.set('header', settings.headerDefault);
    params.set('autoFF', settings.autoFfEnabled ? '1' : '0');
    params.set('autoFFThreshold', String(settings.autoFfThreshold));
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
    const autoFfToggle = $('autoFfToggle') as HTMLInputElement | null;
    const autoFfThreshold = $('autoFfThreshold') as HTMLInputElement | null;
    const autoFfPresets = Array.from(document.querySelectorAll('.auto-ff-preset')) as HTMLButtonElement[];
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
        autoFfEnabled: autoFfToggle ? autoFfToggle.checked : loadAutoFfEnabled() === AUTO_FF_ENABLED,
        autoFfThreshold: normalizeAutoFfThreshold(autoFfThreshold?.value ?? loadAutoFfThreshold()),
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
