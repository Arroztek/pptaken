// SPDX-License-Identifier: AGPL-3.0-or-later
// The minimal, complete, WORKING slide script shown in the authoring guide (ADR-023). It is a tested fixture: the
// MCP tests check it passes the static script check and is stored without warnings, and the browser end-to-end test
// (apps/server/browser/script-errors-e2e.mjs) runs it in Chromium, Firefox and WebKit and checks that it reports no
// error and updates its text. Change it only together with those tests.

export const EXAMPLE_SCRIPT_SLIDE = {
  id: "counter",
  title: "Try it",
  html: "<div class='frame'><h2 class='title'>Try it</h2><button type='button' class='more'>Add one</button><p class='count'>0 clicks</p></div>",
  script: [
    "var root = slide.root;",
    "var button = root.querySelector('.more');",
    "var label = root.querySelector('.count');",
    "var clicks = 0;",
    "function render() { label.textContent = clicks + (clicks === 1 ? ' click' : ' clicks'); }",
    "button.addEventListener('click', function () { clicks += 1; render(); });",
    "slide.onEnter(function () { clicks = 0; render(); });",
  ].join("\n"),
} as const;
