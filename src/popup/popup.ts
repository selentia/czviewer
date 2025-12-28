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
    renderPreview(parseInput(box.value));
  }

  function renderPreview({ ids, invalid }: ParseResult): void {
    const count = $('count');
    const chips = $('chips');
    const errors = $('errors');

    count.textContent = `인식된 채널: ${ids.length}`;
    chips.textContent = '';

    // Render channel chips
    for (const id of ids) {
      const chip = document.createElement('div');
      chip.className = 'chip';

      const label = document.createElement('span');
      label.className = 'chip-label';
      label.textContent = id;
      label.title = id;

      const short = document.createElement('code');
      short.textContent = id.slice(0, 6);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'chip-remove';
      removeBtn.title = '이 채널 제거';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        removeChannelFromInput(id);
      });

      chip.appendChild(label);
      chip.appendChild(short);
      chip.appendChild(removeBtn);
      chips.appendChild(chip);

      // Async channel name resolution
      void fetchChannelName(id).then((name) => {
        if (!name || !chip.isConnected) return;
        label.textContent = name;
        label.title = `${name} (${id})`;
      });
    }

    // Render invalid input summary
    if (invalid.length) {
      const sample = invalid.slice(0, 3).join(' / ');
      const moreCount = invalid.length - 3;
      errors.textContent = invalid.length > 3 ? `인식 불가: ${sample} 외 ${moreCount}개` : `인식 불가: ${sample}`;
    } else {
      errors.textContent = '';
    }
  }

  // ---------------------------------------------------------------------------
  // URL helpers
  // ---------------------------------------------------------------------------

  function buildUrl(ids: string[], base: string): string {
    const params = new URLSearchParams();
    for (const id of ids) params.append('c', id);
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

    const { ids } = parseInput(getInput().value);
    if (ids.includes(id)) return true;

    appendLine(url);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Entry
  // ---------------------------------------------------------------------------

  function main(): void {
    const input = getInput();

    loadSaved();
    renderPreview(parseInput(input.value));

    input.addEventListener('input', () => {
      saveNow();
      renderPreview(parseInput(input.value));
    });

    $('clear').addEventListener('click', () => {
      input.value = '';
      saveNow();
      renderPreview({ ids: [], invalid: [] });
      input.focus();
    });

    $('grab').addEventListener('click', async () => {
      const ok = await grabFromCurrentTab();
      saveNow();
      renderPreview(parseInput(input.value));
      if (!ok) {
        $('errors').textContent = '현재 탭에서 치지직 채널/라이브 URL을 찾지 못했어요.';
      }
    });

    $('open').addEventListener('click', async () => {
      const { ids } = parseInput(input.value);
      if (!ids.length) return;

      const tab = await new Promise<chrome.tabs.Tab | undefined>((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]));
      });

      const base = resolveBaseUrl(tab?.url);
      chrome.tabs.create({ url: buildUrl(ids, base) });
    });

    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        $('open').click();
      }
    });
  }

  main();
})();
