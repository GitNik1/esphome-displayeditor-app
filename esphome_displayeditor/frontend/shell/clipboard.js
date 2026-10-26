// @ts-check

/**
 * Copy text, also where the Clipboard API is missing: Home Assistant opened
 * over plain http://homeassistant.local:8123 is not a secure context, so
 * `navigator.clipboard` does not exist there and every copy button failed.
 * Falls back to a hidden text area and the older copy command; resolves to
 * whether copying worked.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or not focused - try the fallback.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  // Inside an open modal dialog, everything outside it is inert.
  const modals = document.querySelectorAll("dialog:modal");
  (modals.length ? modals[modals.length - 1] : document.body).append(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}
