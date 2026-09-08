// Runs in the page's MAIN world so it can read framework internals (React fibers, Vue instances)
// that are invisible from the isolated content-script world. Communicates via a synchronous
// CustomEvent round-trip: content.js dispatches "pinpoint:inspect" on the element, we answer by
// dispatching "pinpoint:inspect-result" on the same element with a JSON string.
(() => {
  if (window.__pinpointInspector) return;
  window.__pinpointInspector = true;

  function reactHint(el, hint) {
    let node = el, fiber = null;
    while (node && !fiber) {
      const key = Object.keys(node).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
      if (key) fiber = node[key];
      else node = node.parentElement;
    }
    if (!fiber) return false;
    hint.framework = "react";
    let f = fiber, guard = 0;
    while (f && guard++ < 80 && hint.components.length < 8) {
      const t = f.type;
      let name = null;
      if (typeof t === "function") name = t.displayName || t.name;
      else if (t && typeof t === "object") name = t.displayName || t.render?.displayName || t.render?.name || t.type?.displayName || t.type?.name;
      if (name && name !== "Fragment" && !/^(Provider|Consumer|Context|Suspense|Boundary|Anonymous)$/.test(name) && hint.components[hint.components.length - 1] !== name) hint.components.push(name);
      if (!hint.file && f._debugSource) {
        hint.file = f._debugSource.fileName;
        hint.line = f._debugSource.lineNumber;
        hint.column = f._debugSource.columnNumber ?? null;
      }
      // React 19 dev: _debugStack is an Error whose stack mentions the source file.
      if (!hint.file && f._debugStack && typeof f._debugStack.stack === "string") {
        const m = f._debugStack.stack.match(/\((?:webpack-internal:\/\/\/|file:\/\/|https?:\/\/[^/]+\/)?([^)\s]+?\.(?:[jt]sx?|vue|svelte)):(\d+):(\d+)\)/);
        if (m && !/node_modules/.test(m[1])) { hint.file = m[1]; hint.line = Number(m[2]); hint.column = Number(m[3]); }
      }
      f = f.return;
    }
    if (hint.file) hint.file = hint.file.replace(/^.*?\/((src|app|pages|components|lib)\/)/, "$1").replace(/\?.*$/, "");
    return true;
  }

  function vueHint(el, hint) {
    let v = el;
    for (let i = 0; v && i < 12; i++, v = v.parentElement) {
      const inst = v.__vueParentComponent || v.__vue__;
      if (!inst) continue;
      hint.framework = "vue";
      let c = inst, guard = 0;
      while (c && guard++ < 10 && hint.components.length < 8) {
        const type = c.type || c.$options;
        const name = type?.name || type?.__name;
        if (name) hint.components.push(name);
        if (!hint.file && type?.__file) hint.file = type.__file;
        c = c.parent || c.$parent;
      }
      return true;
    }
    return false;
  }

  function attrHints(el, hint) {
    let cur = el;
    for (let i = 0; cur && i < 6; i++, cur = cur.parentElement) {
      const get = (n) => cur.getAttribute(n);
      const src = get("data-source") || get("data-loc") || get("data-inspector-relative-path") || get("data-source-file") || get("data-file") || get("data-locatorjs-id");
      if (src && !hint.file) {
        const m = src.match(/^(.*?):(\d+)(?::(\d+))?$/);
        hint.file = m ? m[1] : src;
        hint.line = m ? Number(m[2]) : Number(get("data-inspector-line") || get("data-line")) || null;
        hint.column = m && m[3] ? Number(m[3]) : Number(get("data-inspector-column")) || null;
      }
      for (const n of ["data-component", "data-sentry-component", "data-sentry-source-file", "data-testid", "data-test", "data-cy"]) {
        const v = get(n);
        if (v && !hint.attributes[n]) hint.attributes[n] = v;
      }
    }
  }

  function inspect(el) {
    const hint = { framework: null, components: [], file: null, line: null, column: null, attributes: {} };
    try { attrHints(el, hint); } catch {}
    try { reactHint(el, hint) || vueHint(el, hint); } catch {}
    if (!hint.framework) {
      if ([...el.classList].some((c) => /^svelte-/.test(c))) hint.framework = "svelte";
      else if ([...el.attributes].some((a) => /^_ngcontent|^ng-/.test(a.name))) hint.framework = "angular";
      else if (el.closest("[data-astro-cid], astro-island")) hint.framework = "astro";
    }
    return hint;
  }

  document.addEventListener("pinpoint:inspect", (e) => {
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    let result;
    try { result = inspect(el); } catch (err) { result = { error: String(err) }; }
    el.dispatchEvent(new CustomEvent("pinpoint:inspect-result", { detail: JSON.stringify(result) }));
  }, true);
})();
