/**
 * @file src/background/cookieBridge.ts
 *
 * @description Cookie bridge for partitioned Naver login cookies.
 *
 * Purpose:
 * - Replicate NID_AUT / NID_SES into partitioned cookie storage
 * - Scope only to CZ MultiViewer top-level sites
 * - Never interfere with normal *.naver.com browsing sessions
 *
 * This is required because:
 * - Chrome Partitioned Cookies isolate third-party contexts
 * - Chzzk APIs require Naver login cookies even in partitioned contexts
 */

// -----------------------------------------------------------------------------
// Types & Chrome gaps
// -----------------------------------------------------------------------------

// Chrome types still lack PartitionKey as of now
declare namespace chrome.cookies {
  interface PartitionKey {
    topLevelSite: string;
    [key: string]: string | undefined;
  }
}

type CookieDef = {
  name: string;
  domain: string;
  url: string;
};

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const PARTITION_KEYS: chrome.cookies.PartitionKey[] = [
  { topLevelSite: 'https://czviewer.duna.me' },
  { topLevelSite: 'https://www.czviewer.duna.me' },
  { topLevelSite: 'http://localhost:8787' },
];

const COOKIE_DEFS: CookieDef[] = [
  {
    name: 'NID_AUT',
    domain: '.naver.com',
    url: 'https://nid.naver.com/nidlogin.login',
  },
  {
    name: 'NID_SES',
    domain: '.naver.com',
    url: 'https://nid.naver.com/nidlogin.login',
  },
];

// -----------------------------------------------------------------------------
// Internal state
// -----------------------------------------------------------------------------

let listenerBound = false;

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function bindCookieListenerOnce(): void {
  if (listenerBound) return;
  chrome.cookies.onChanged.addListener(handleCookieChanged);
  listenerBound = true;
}

function matchCookie(cookie: chrome.cookies.Cookie | undefined): CookieDef | undefined {
  if (!cookie) return;
  return COOKIE_DEFS.find((def) => def.name === cookie.name && def.domain === cookie.domain);
}

/**
 * Ensure required cookie permissions exist.
 * If not granted, open permission UI and abort initialization.
 */
async function ensurePermissions(): Promise<void> {
  const granted = await chrome.permissions.contains({
    origins: [
      'https://api.chzzk.naver.com/*',
      'https://chzzk.naver.com/*',
      'https://*.naver.com/*',
      'https://czviewer.duna.me/*',
      'https://www.czviewer.duna.me/*',
      'http://localhost:8787/*',
    ],
  });

  if (!granted) {
    chrome.tabs.create({
      url: chrome.runtime.getURL('permission/permission.html'),
    });
    throw new Error('COOKIE_PERMISSION');
  }
}

// -----------------------------------------------------------------------------
// Core logic
// -----------------------------------------------------------------------------

/**
 * Copy a regular cookie into partitioned storage
 * for all allowed top-level sites.
 */
async function setPartitionCookies(cookie: chrome.cookies.Cookie, def: CookieDef): Promise<void> {
  // Already partitioned; do nothing
  if ((cookie as any).partitionKey) return;

  // Clone cookie into a mutable object
  const mutable: Partial<chrome.cookies.SetDetails> = { ...cookie };

  // Remove read-only / invalid fields
  delete (mutable as any).hostOnly;
  delete (mutable as any).session;
  delete (mutable as any).firstPartyDomain;

  for (const key of PARTITION_KEYS) {
    try {
      await chrome.cookies.set({
        ...mutable,
        url: def.url,
        secure: true,
        sameSite: chrome.cookies.SameSiteStatus.NO_RESTRICTION,
        partitionKey: key,
      });
    } catch (err) {
      console.warn('[cookieBridge] setPartitionCookie failed', err);
    }
  }
}

/**
 * Initial seeding:
 * Copy existing Naver login cookies into partitioned storage.
 */
async function seedPartitionCookies(): Promise<void> {
  for (const def of COOKIE_DEFS) {
    const base = await chrome.cookies.get({ name: def.name, url: def.url }).catch(() => null);

    if (!base) continue;
    await setPartitionCookies(base, def);
  }
}

/**
 * React to cookie updates and mirror them into partitioned storage.
 */
async function handleCookieChanged(changeInfo: chrome.cookies.CookieChangeInfo): Promise<void> {
  if (changeInfo.removed) return;

  const def = matchCookie(changeInfo.cookie);
  if (!def) return;

  await setPartitionCookies(changeInfo.cookie!, def);
}

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

async function initBridge(): Promise<void> {
  bindCookieListenerOnce();
  await ensurePermissions();
  await seedPartitionCookies();
}

chrome.runtime.onInstalled.addListener(() => {
  void initBridge().catch(() => {
    // permission UI already handled
  });
});

chrome.runtime.onStartup.addListener(() => {
  void initBridge().catch(() => {
    // permission UI already handled
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg === 'PING_COOKIE_BRIDGE') {
    void initBridge().catch(() => {
      // permission UI already handled
    });
    sendResponse?.({ ok: true });
    return true;
  }
});
