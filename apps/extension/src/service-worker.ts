/// <reference types="chrome" />
import {
  badgeText,
  DEFAULT_INSTANCE,
  detectFileMime,
  formatApiError,
  formatIngestNotification,
  hostPattern,
  ingestUrl,
  MAX_UPLOAD_BYTES,
  sanitizeFilename,
  type ExtensionSettings,
  type IngestResponse,
} from "./lib";

const MENU_LINK = "send-link-to-auto";
const MENU_PAGE = "send-page-to-auto";
const ALARM_NAME = "refresh-badge";
const BADGE_COLOR = "#00695C";

async function loadSettings(): Promise<ExtensionSettings> {
  const r = await chrome.storage.local.get(["instance", "token"]);
  return { instance: (r.instance as string) || DEFAULT_INSTANCE, token: (r.token as string) || "" };
}

async function notify(title: string, message: string) {
  await chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
    title,
    message,
  });
}

async function refreshBadge() {
  const { instance, token } = await loadSettings();
  if (!token) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  try {
    const r = await fetch(`${instance}/v1/received-invoices`, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const list = (await r.json()) as { status?: string }[];
    const pending = list.filter((item) => item.status === "review").length;
    await chrome.storage.local.set({ pendingReview: pending, updatedAt: new Date().toISOString(), badgeError: null });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    await chrome.action.setBadgeText({ text: badgeText(pending) });
    await chrome.action.setTitle({
      title: pending ? `Auto: ${pending} invoice(s) to review` : "Auto: no pending invoices",
    });
  } catch (e) {
    await chrome.storage.local.set({ badgeError: e instanceof Error ? e.message : String(e) });
    await chrome.action.setBadgeText({ text: "" });
  }
}

async function sendUrl(url: string, permissionPromise: Promise<boolean>) {
  try {
    if (!(await permissionPromise)) {
      return await notify("Access denied", "Permission was not granted for that host.");
    }
    const { instance, token } = await loadSettings();
    if (!token) {
      await notify("Setup required", "Add your Auto API token in extension settings.");
      return await chrome.runtime.openOptionsPage();
    }
    const src = await fetch(url, { credentials: "include" });
    if (!src.ok) throw new Error(`Download failed (HTTP ${src.status})`);
    const bytes = new Uint8Array(await src.arrayBuffer());
    if (bytes.length > MAX_UPLOAD_BYTES) throw new Error("File exceeds 20 MiB limit");
    const mime = detectFileMime(bytes);
    if (!mime) throw new Error("Target URL is neither a PDF nor a Factur-X XML document");
    const name = sanitizeFilename(url, src.headers.get("content-disposition"), mime);
    const res = await fetch(ingestUrl(instance, name), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": mime },
      body: bytes,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(formatApiError(res.status, body));
    const msg = formatIngestNotification(body as IngestResponse, name);
    await notify(msg.title, msg.message);
    await refreshBadge();
  } catch (e) {
    await notify("Upload failed", e instanceof Error ? e.message : String(e));
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.create({ id: MENU_LINK, title: "Send invoice to Auto", contexts: ["link"] });
  chrome.contextMenus.create({
    id: MENU_PAGE,
    title: "Send current document to Auto",
    contexts: ["page"],
    documentUrlPatterns: ["*://*/*.pdf", "*://*/*.pdf?*", "*://*/*.xml", "*://*/*.xml?*"],
  });
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 15 });
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(() => void refreshBadge());
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM_NAME) void refreshBadge();
});

chrome.contextMenus.onClicked.addListener((info) => {
  const target = info.menuItemId === MENU_LINK ? info.linkUrl : info.pageUrl;
  if (!target || !/^https?:/.test(target)) {
    void notify("Unsupported link", "Only http(s) PDF and XML links can be uploaded.");
    return;
  }
  const crossSite = new URL(target).origin !== new URL(info.pageUrl ?? target).origin;
  const perm = crossSite ? chrome.permissions.request({ origins: [hostPattern(target)] }) : Promise.resolve(true);
  void sendUrl(target, perm);
});

chrome.runtime.onMessage.addListener((msg: { type?: string; url?: string }, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return false;
  const action =
    msg.type === "refreshBadge"
      ? refreshBadge
      : msg.type === "send" && typeof msg.url === "string" && /^https?:/.test(msg.url)
        ? () => sendUrl(msg.url!, Promise.resolve(true))
        : null;
  if (!action) return false;
  void action().then(() => reply({ ok: true }));
  return true;
});
