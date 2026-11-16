// Emulated devices for "Switch to device". Sizes are the CSS viewport a web
// page sees (width × screen height). The bars are approximate heights of the
// phone's status bar and browser chrome, so the page area matches the device.
// The server has the matching user agents (DEVICES in lib/core.js).
window.SBS_DEVICES = [
  // iPhone (QA's list)
  { id: 'iphone-se-2022', name: 'iPhone SE (2022)', group: 'iPhone', kind: 'ios-home', w: 375, h: 667, status: 20, top: 0, bottom: 50, radius: 0, bezel: 14, chin: 72 },
  { id: 'iphone-15', name: 'iPhone 15', group: 'iPhone', kind: 'ios', w: 390, h: 844, status: 54, top: 0, bottom: 82, radius: 55, bezel: 12 },
  { id: 'iphone-17', name: 'iPhone 17', group: 'iPhone', kind: 'ios', w: 393, h: 852, status: 54, top: 0, bottom: 82, radius: 55, bezel: 12 },
  { id: 'iphone-16-pro-max', name: 'iPhone 16 Pro Max', group: 'iPhone', kind: 'ios', w: 428, h: 926, status: 54, top: 0, bottom: 82, radius: 58, bezel: 12 },
  { id: 'iphone-15-pro-max', name: 'iPhone 15 Pro Max', group: 'iPhone', kind: 'ios', w: 430, h: 932, status: 54, top: 0, bottom: 82, radius: 58, bezel: 12 },
  // iPhone Duo: widths measured in Safari (382 folded, 669 unfolded); the folded height is estimated.
  // `pair` links the folded and unfolded versions for the Fold / Unfold button.
  { id: 'iphone-duo-folded', name: 'iPhone Duo (folded)', group: 'iPhone', kind: 'ios-duo', w: 382, h: 556, status: 40, top: 0, bottom: 70, radius: 36, bezel: 12, pair: 'iphone-duo-unfolded', folded: true, note: 'height estimated' },
  { id: 'iphone-duo-unfolded', name: 'iPhone Duo (unfolded)', group: 'iPhone', kind: 'ios-duo', w: 669, h: 951, status: 40, top: 0, bottom: 70, radius: 30, bezel: 12, pair: 'iphone-duo-folded', crease: true },
  // iPad
  { id: 'ipad-pro-11', name: 'iPad Pro 11" (2025)', group: 'iPad', kind: 'ipad', w: 834, h: 1210, status: 24, top: 50, bottom: 0, radius: 18, bezel: 20 },
  { id: 'ipad-pro-12-9', name: 'iPad Pro 12.9" (2022)', group: 'iPad', kind: 'ipad', w: 1024, h: 1366, status: 24, top: 50, bottom: 0, radius: 18, bezel: 20 },
  // Android
  { id: 'pixel-9', name: 'Pixel 9', group: 'Android', kind: 'android', w: 412, h: 915, status: 30, top: 56, bottom: 18, radius: 44, bezel: 12 },
  { id: 'galaxy-s24', name: 'Galaxy S24', group: 'Android', kind: 'android', w: 360, h: 780, status: 30, top: 56, bottom: 18, radius: 40, bezel: 10 },
  // Surface Duo: Chrome DevTools' values. Spanned = both screens with the 34px hinge between them.
  { id: 'surface-duo', name: 'Surface Duo (one screen)', group: 'Android', kind: 'android', w: 540, h: 720, status: 24, top: 56, bottom: 0, radius: 10, bezel: 14, pair: 'surface-duo-spanned', folded: true },
  { id: 'surface-duo-spanned', name: 'Surface Duo (both screens)', group: 'Android', kind: 'android', w: 1114, h: 720, status: 24, top: 56, bottom: 0, radius: 10, bezel: 14, pair: 'surface-duo', hinge: 34 },
  { id: 'galaxy-tab-s9', name: 'Galaxy Tab S9', group: 'Android', kind: 'android-tab', w: 800, h: 1280, status: 28, top: 56, bottom: 0, radius: 18, bezel: 20 },
];
