/**
 * Hidden VGA surface for v86. Product UI uses the Workbench terminal, not this panel.
 */
export function ensureGuestScreenContainer(): HTMLElement {
  const existing = document.getElementById('ucd-guest-screen')
  if (existing != null) {
    return existing
  }
  const el = document.createElement('div')
  el.id = 'ucd-guest-screen'
  el.style.cssText = 'position:fixed;left:-9999px;top:0;width:640px;height:400px;overflow:hidden'
  el.innerHTML =
    '<div style="white-space:pre;font:14px monospace;line-height:14px"></div><canvas style="display:none"></canvas>'
  document.body.appendChild(el)
  return el
}
