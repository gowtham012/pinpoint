# Contributing

Thanks for taking a look. Pinpoint is small on purpose: a browser extension with no build step, and a Node bridge with two dependencies.

## Getting set up

```bash
git clone https://github.com/gowtham012/pinpoint
cd pinpoint/bridge && npm install
cd ../test && npm install && npx playwright install chromium
```

Or just `node bridge/cli.js setup`, which does all of that and asks the rest. Then load `extension/` unpacked in Chrome (`chrome://extensions` → Developer mode → Load unpacked), and you are developing.

There is no bundler and no transpiler. Edit the files, hit the reload arrow on the extension card, done.

## Running the tests

```bash
cd test
npm test                 # everything
node --test bridge.test.mjs   # bridge, CLI, hooks, MCP (fast)
node --test e2e.test.mjs      # real Chromium with the extension loaded
```

The browser suite loads the actual unpacked extension and drives real pages — React, Vue, shadow DOM, an iframe, a strict-CSP page, a 3,600-node stress page and a form that rebuilds its own DOM. It is slower but it is the suite that catches real bugs.

## What a good change looks like

**Every behaviour change comes with a test.** Most of the bugs this project has had were things that "obviously worked": a bar that rendered in the right place but got painted over, pins that re-attached to the wrong element after a re-render, screenshots silently dropped when you switched tabs. None of those show up in a screenshot; all of them show up in an assertion. If you cannot see how to test something, say so in the PR and we will work it out.

Prefer a test that describes the user's situation (`"switching tabs right after Send still gets the screenshot"`) over one that describes the implementation.

## Things worth knowing before you dig in

- **The content script runs in two worlds.** `content.js` is the isolated world; `inspector.js` runs in the page's MAIN world because React fibers and Vue instances are invisible from the isolated one. They talk over a synchronous CustomEvent round-trip.
- **Screenshots are taken by the service worker, not the page**, after the annotation is already stored. That is deliberate: navigating away must cost you the picture, never the comment.
- **Selectors prefer stable attributes** (`button[data-action="next"]`) over positions, and every annotation carries a fingerprint so a pin can tell whether the element its selector now matches is really the one you clicked.
- **The icons are generated, not hand-edited.** `bash tools/make-icons.sh` cuts `extension/icon{16,48,128}.png` and the in-page bar's mark out of `tools/logo/mark.png`.
- **The bridge refuses any request carrying a web page's `Origin`.** Only the extension and local CLI tools may talk to it. Page-scraped content is labelled as untrusted data wherever it reaches an agent.

## Publishing

Listing the extension on the Chrome Web Store is [docs/chrome-web-store.md](docs/chrome-web-store.md):
packaging, the permission justifications reviewers ask for, the listing copy and the screenshot list.
[PRIVACY.md](PRIVACY.md) is the policy the Store requires a URL for, and it must keep matching the code.

## Reporting a bug

Include the page (a URL or a minimal HTML file), what you expected, what happened, and the output of `node bridge/cli.js status`. If it is a rendering problem, a screenshot of the whole viewport helps more than a crop.
