/// <reference types="chrome" />
import { DEFAULT_INSTANCE, formatApiError, hostPattern, isValidApiToken, normalizeInstance } from "./lib";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("settings-form");
const instanceField = $<HTMLInputElement>("instance");
const tokenField = $<HTMLInputElement>("token");
const errorEl = $<HTMLParagraphElement>("error");
const submitBtn = $<HTMLButtonElement>("save-btn");

function showError(msg: string | null, field?: HTMLInputElement) {
  for (const el of [instanceField, tokenField]) el.removeAttribute("aria-invalid");
  errorEl.hidden = !msg;
  errorEl.textContent = msg ?? "";
  if (field) {
    field.setAttribute("aria-invalid", "true");
    field.setAttribute("aria-errormessage", "error");
    field.focus();
  }
}

async function renderStatus() {
  const s = await chrome.storage.local.get(["instance", "token", "pendingReview", "companyName", "badgeError"]);
  const instance = (s.instance as string) || DEFAULT_INSTANCE;
  instanceField.value = instance;
  const summary = $("summary");
  const openBtn = $<HTMLAnchorElement>("open-link");
  if (!s.token) {
    summary.textContent = "Extension not configured: enter your Auto API token below.";
    openBtn.hidden = true;
    return;
  }
  const n = Number(s.pendingReview ?? 0);
  const org = s.companyName ? `${s.companyName}: ` : "";
  summary.textContent = s.badgeError
    ? `Cannot reach ${new URL(instance).host}: ${s.badgeError}`
    : `${org}${n === 0 ? "no invoices awaiting review." : `${n} invoice(s) awaiting review.`}`;
  openBtn.href = `${instance}/app/inbox`;
  openBtn.hidden = false;
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  let instance: string;
  try {
    instance = normalizeInstance(instanceField.value || DEFAULT_INSTANCE);
  } catch (err) {
    showError((err as Error).message, instanceField);
    return;
  }
  const token = tokenField.value.trim();
  if (!isValidApiToken(token)) {
    showError("Invalid token format: expected prefix auto_", tokenField);
    return;
  }
  const perm =
    instance === DEFAULT_INSTANCE
      ? Promise.resolve(true)
      : chrome.permissions.request({ origins: [hostPattern(instance)] });
  void (async () => {
    submitBtn.disabled = true;
    submitBtn.textContent = "Testing connection...";
    try {
      if (!(await perm)) {
        showError("Host permission rejected.");
        return;
      }
      const res = await fetch(`${instance}/v1/me`, { headers: { authorization: `Bearer ${token}` } });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        showError(formatApiError(res.status, body), res.status === 401 ? tokenField : undefined);
        return;
      }
      const me = body as { companies?: { name?: string }[] };
      await chrome.storage.local.set({ instance, token, companyName: me.companies?.[0]?.name ?? null });
      tokenField.value = "";
      showError(null);
      await chrome.runtime.sendMessage({ type: "refreshBadge" });
      await renderStatus();
    } catch (err) {
      showError(`Instance unreachable: ${(err as Error).message}`, instanceField);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save and test";
    }
  })();
});

void renderStatus();
