# Security

## Reporting

Please report vulnerabilities privately through GitHub's *Report a vulnerability* button on the Security tab, rather than opening a public issue.

For what is collected, where it is stored and who else can see it, see [PRIVACY.md](PRIVACY.md).

## Design notes

Pinpoint moves text and screenshots from your browser to your coding agent, so the trust boundaries matter.

- **The bridge listens on `127.0.0.1` only.** It also refuses any request carrying a web page's `Origin` header — only `chrome-extension://` callers and origin-less local CLI tools are accepted, so a site you happen to be visiting cannot read your notes or plant instructions for your agent. DNS rebinding does not help an attacker either: the `Host` header must be loopback.
- **The bridge identifies itself** with a `service: "pinpoint-bridge"` marker, so the extension will not mistake some other server on port 7331 for it and start posting your page content there.
- **Everything scraped from a page is labelled untrusted** in the markdown handed to an agent. Only the comment you typed is presented as an instruction; element text, HTML, attributes and styles are explicitly framed as data for locating the element.
- **The extension only injects itself into local development pages** — localhost, the loopback range, private LAN addresses, `.local`/`.test`/`.localhost` hosts and `file://`. Anywhere else it is not present unless you turn it on for that tab from the toolbar.
- **The `<all_urls>` host permission** is required by Chrome for `tabs.captureVisibleTab` (the element screenshot) and nothing else; a narrower permission does not grant that API.
- **Screenshots never become loose image files.** They are stored base64-encoded inside `~/.pinpoint/annotations.json`, and a queued capture is abandoned rather than taken if the page changed first — you never get a screenshot of the wrong page.
