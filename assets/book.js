(() => {
  "use strict";

  const root = document.documentElement;
  const body = document.body;
  const sections = Array.from(document.querySelectorAll(".book-section"));
  const sectionById = new Map(sections.map((section) => [section.id, section]));
  const navLinks = Array.from(document.querySelectorAll("#book-nav a[data-section-id]"));
  const reader = document.querySelector("#reader-content");
  const sidebar = document.querySelector("#book-sidebar");
  const sidebarToggle = document.querySelector("#toc-toggle");
  const sidebarScrim = document.querySelector("#sidebar-scrim");
  const outline = document.querySelector("#page-outline");
  const outlineList = document.querySelector("#page-outline-list");
  const previousButton = document.querySelector("#prev-section");
  const nextButton = document.querySelector("#next-section");
  const progressBar = document.querySelector("#reading-progress-bar");
  const themeButton = document.querySelector("#theme-toggle");
  const fontDecrease = document.querySelector("#font-decrease");
  const fontIncrease = document.querySelector("#font-increase");
  const searchButton = document.querySelector("#search-toggle");
  const searchDialog = document.querySelector("#search-dialog");
  const searchInput = document.querySelector("#book-search");
  const searchResults = document.querySelector("#search-results");

  const BOOK_TITLE = "Astrophysics of Gaseous Nebulae and Active Galactic Nuclei";
  const FONT_MIN = 16;
  const FONT_MAX = 22;
  const FONT_DEFAULT = 18;
  const SEARCH_LIMIT = 60;

  let activeSection = null;
  let activeSectionIndex = 0;
  let outlineObserver = null;
  let scrollFrame = 0;
  let searchIndex = null;
  let searchTimer = 0;
  let targetAlignmentObserver = null;
  let targetAlignmentTimer = 0;

  function safeStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (_error) {
      // Reader settings remain usable for this visit when storage is blocked.
    }
  }

  function escapeHtml(value) {
    return value.replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    })[character]);
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function normalized(value) {
    return value.toLocaleLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
  }

  function setTheme(theme, persist = true) {
    const nextTheme = theme === "dark" ? "dark" : "light";
    root.dataset.theme = nextTheme;
    if (themeButton) {
      const dark = nextTheme === "dark";
      themeButton.setAttribute("aria-pressed", String(dark));
      themeButton.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
      const icon = themeButton.querySelector("[aria-hidden='true']");
      if (icon) icon.textContent = dark ? "☀" : "◐";
    }
    const themeMeta = document.querySelector("meta[name='theme-color']");
    if (themeMeta) themeMeta.content = nextTheme === "dark" ? "#0a0b10" : "#f7f3f0";
    if (persist) safeStorageSet("agn-reader-theme", nextTheme);
  }

  function initializeTheme() {
    setTheme("light", false);
  }

  function setFontSize(size, persist = true) {
    const nextSize = Math.max(FONT_MIN, Math.min(FONT_MAX, Number(size) || FONT_DEFAULT));
    root.style.setProperty("--reader-size", `${nextSize}px`);
    if (fontDecrease) fontDecrease.disabled = nextSize <= FONT_MIN;
    if (fontIncrease) fontIncrease.disabled = nextSize >= FONT_MAX;
    if (persist) safeStorageSet("agn-reader-font-size", String(nextSize));
  }

  function currentFontSize() {
    return Number.parseFloat(getComputedStyle(root).getPropertyValue("--reader-size")) || FONT_DEFAULT;
  }

  function initializeFontSize() {
    setFontSize(safeStorageGet("agn-reader-font-size") || FONT_DEFAULT, false);
  }

  function openSidebar() {
    body.classList.add("sidebar-open");
    sidebarToggle?.setAttribute("aria-expanded", "true");
    sidebarToggle?.setAttribute("aria-label", "Close table of contents");
    if (sidebarScrim) sidebarScrim.hidden = false;
    const currentLink = document.querySelector("#book-nav a[aria-current='page']");
    window.requestAnimationFrame(() => currentLink?.focus({ preventScroll: true }));
  }

  function closeSidebar({ restoreFocus = false } = {}) {
    body.classList.remove("sidebar-open");
    sidebarToggle?.setAttribute("aria-expanded", "false");
    sidebarToggle?.setAttribute("aria-label", "Open table of contents");
    if (sidebarScrim) sidebarScrim.hidden = true;
    if (restoreFocus) sidebarToggle?.focus();
  }

  function targetFromHash() {
    const encoded = window.location.hash.slice(1);
    if (!encoded) return sectionById.get("cover") || sections[0];
    try {
      return document.getElementById(decodeURIComponent(encoded)) || sectionById.get("cover") || sections[0];
    } catch (_error) {
      return sectionById.get("cover") || sections[0];
    }
  }

  function sectionForTarget(target) {
    if (!target) return sections[0];
    return target.classList?.contains("book-section") ? target : target.closest?.(".book-section") || sections[0];
  }

  function sectionHeadingText(section) {
    return section.dataset.title || section.querySelector("h1")?.textContent.trim() || BOOK_TITLE;
  }

  function readableHeadingText(heading) {
    if (heading.dataset.headingText) return heading.dataset.headingText;
    const clone = heading.cloneNode(true);
    clone.querySelectorAll(".math-source[data-tex]").forEach((math) => {
      math.replaceWith(` ${math.getAttribute("aria-label") || math.dataset.tex} `);
    });
    clone.querySelectorAll(".heading-permalink").forEach((link) => link.remove());
    return clone.textContent.replace(/\s+/g, " ").trim();
  }

  function ensurePermalinks(section) {
    section.querySelectorAll("h2[id], h3[id]").forEach((heading) => {
      if (heading.closest(".publication-details, .printed-contents")) return;
      if (heading.querySelector(":scope > .heading-permalink")) return;
      const anchor = document.createElement("a");
      anchor.className = "heading-permalink";
      anchor.href = `#${heading.id}`;
      anchor.setAttribute("aria-label", `Link to ${readableHeadingText(heading)}`);
      anchor.title = "Link to this section";
      anchor.textContent = "#";
      heading.append(anchor);
    });
  }

  function renderMath(section) {
    const mathNodes = Array.from(section.querySelectorAll(".math-source:not([data-math-rendered])"));
    if (!mathNodes.length) return;

    if (!window.katex?.render) {
      section.classList.add("math-fallback");
      window.addEventListener("load", () => renderMath(section), { once: true });
      return;
    }

    mathNodes.forEach((node) => {
      const tex = node.dataset.tex || node.textContent.trim();
      node.dataset.tex = tex;
      node.setAttribute("aria-label", tex);
      try {
        window.katex.render(tex, node, {
          displayMode: node.dataset.display === "block",
          throwOnError: false,
          strict: "ignore",
          trust: false,
          output: "htmlAndMathml",
        });
        node.dataset.mathRendered = "true";
      } catch (_error) {
        node.classList.add("math-error");
        node.dataset.mathRendered = "error";
        node.textContent = tex;
      }
    });
  }

  function updateNavigation(section) {
    navLinks.forEach((link) => {
      const current = link.dataset.sectionId === section.id;
      link.classList.toggle("is-active", current);
      if (current) {
        link.setAttribute("aria-current", "page");
        link.scrollIntoView({ block: "nearest", behavior: "auto" });
      } else {
        link.removeAttribute("aria-current");
      }
    });
  }

  function setPagerButton(button, targetSection, direction) {
    if (!button) return;
    button.disabled = !targetSection;
    button.dataset.targetSection = targetSection?.id || "";
    const directionNode = button.querySelector(".pager-direction");
    const titleNode = button.querySelector(".pager-title");
    if (directionNode) directionNode.textContent = direction;
    if (titleNode) titleNode.textContent = targetSection ? sectionHeadingText(targetSection) : "";
  }

  function updatePager(index) {
    setPagerButton(previousButton, sections[index - 1], "Previous");
    setPagerButton(nextButton, sections[index + 1], "Next");
  }

  function buildOutline(section) {
    if (!outline || !outlineList) return;
    outlineObserver?.disconnect();
    outlineObserver = null;
    outlineList.replaceChildren();

    const headings = Array.from(section.querySelectorAll("h2[id], h3[id]"))
      .filter((heading) => !heading.closest(".publication-details, .printed-contents"));

    if (!headings.length || section.dataset.kind === "index") {
      outline.hidden = true;
      return;
    }

    const fragment = document.createDocumentFragment();
    headings.forEach((heading) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = `#${heading.id}`;
      link.dataset.level = heading.tagName.slice(1);
      link.textContent = readableHeadingText(heading);
      item.append(link);
      fragment.append(item);
    });
    outlineList.append(fragment);
    outline.hidden = false;

    outlineObserver = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      outlineList.querySelectorAll("a").forEach((link) => {
        const current = link.hash === `#${visible.target.id}`;
        link.classList.toggle("is-active", current);
        if (current) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      });
    }, { rootMargin: "-15% 0px -72% 0px", threshold: [0, 1] });

    headings.forEach((heading) => outlineObserver.observe(heading));
  }

  function updateDocumentTitle(section) {
    const title = sectionHeadingText(section);
    document.title = section.id === "cover" ? BOOK_TITLE : `${title} · ${BOOK_TITLE}`;
  }

  function clearTargetAlignment() {
    targetAlignmentObserver?.disconnect();
    targetAlignmentObserver = null;
    if (targetAlignmentTimer) window.clearTimeout(targetAlignmentTimer);
    targetAlignmentTimer = 0;
  }

  function stabilizeTargetAlignment(target, section) {
    const align = () => {
      if (activeSection !== section || targetFromHash() !== target) return;
      target.scrollIntoView({ block: "start", behavior: "auto" });
    };

    if (typeof ResizeObserver === "function") {
      targetAlignmentObserver = new ResizeObserver(() => {
        window.requestAnimationFrame(align);
      });
      targetAlignmentObserver.observe(section);
    }
    document.fonts?.ready.then(() => window.requestAnimationFrame(align));
    targetAlignmentTimer = window.setTimeout(() => {
      align();
      clearTargetAlignment();
    }, 1800);
  }

  function showTarget(target, { scroll = true, focus = false } = {}) {
    clearTargetAlignment();
    const section = sectionForTarget(target);
    const index = Math.max(0, sections.indexOf(section));
    const changed = activeSection !== section;

    sections.forEach((candidate) => {
      candidate.hidden = candidate !== section;
      candidate.setAttribute("aria-hidden", String(candidate !== section));
    });

    activeSection = section;
    activeSectionIndex = index;
    ensurePermalinks(section);
    updateNavigation(section);
    updatePager(index);
    buildOutline(section);
    updateDocumentTitle(section);
    renderMath(section);
    closeSidebar();

    window.requestAnimationFrame(() => {
      if (scroll) {
        if (target === section || changed) {
          window.scrollTo({ top: 0, behavior: "auto" });
        }
        if (target !== section) {
          target.scrollIntoView({ block: "start", behavior: "auto" });
          stabilizeTargetAlignment(target, section);
        }
      }
      if (focus) reader?.focus({ preventScroll: true });
      updateReadingProgress();
    });
  }

  function routeFromHash(options = {}) {
    const target = targetFromHash();
    showTarget(target, options);
  }

  function updateReadingProgress() {
    if (!activeSection || !progressBar) return;
    const top = activeSection.offsetTop;
    const scrollable = Math.max(1, activeSection.offsetHeight - window.innerHeight + 90);
    const progress = Math.max(0, Math.min(1, (window.scrollY - top + 90) / scrollable));
    progressBar.style.width = `${(progress * 100).toFixed(2)}%`;
  }

  function requestProgressUpdate() {
    if (scrollFrame) return;
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = 0;
      updateReadingProgress();
    });
  }

  function buildSearchIndex() {
    if (searchIndex) return searchIndex;
    const entries = [];

    sections.forEach((section) => {
      let nearestHeading = section.id;
      const blocks = section.querySelectorAll("h2[id], h3[id], p, figcaption, tr, li");
      blocks.forEach((block) => {
        if (block.closest(".publication-details") && section.id === "cover") return;
        if (block.closest(".printed-contents")) return;
        if (block.matches("h2[id], h3[id]")) nearestHeading = block.id;
        if (block.parentElement?.closest("li") && block.tagName === "LI") return;
        const clone = block.cloneNode(true);
        clone.querySelectorAll(".math-source[data-tex]").forEach((math) => {
          math.replaceWith(` ${math.dataset.tex} `);
        });
        clone.querySelectorAll(".heading-permalink").forEach((link) => link.remove());
        const rawText = clone.textContent.replace(/\s+/g, " ").trim();
        if (rawText.length < 3) return;
        entries.push({
          sectionId: section.id,
          sectionTitle: sectionHeadingText(section),
          targetId: block.id || nearestHeading || section.id,
          text: rawText,
          normalizedText: normalized(rawText),
        });
      });
    });

    searchIndex = entries;
    return entries;
  }

  function snippetFor(text, terms) {
    const normalizedText = normalized(text);
    const firstMatch = terms
      .map((term) => normalizedText.indexOf(term))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
    const start = Math.max(0, firstMatch - 72);
    const end = Math.min(text.length, start + 220);
    let snippet = text.slice(start, end).trim();
    if (start > 0) snippet = `…${snippet}`;
    if (end < text.length) snippet = `${snippet}…`;
    const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
    return escapeHtml(snippet).replace(pattern, "<mark>$1</mark>");
  }

  function runSearch(query) {
    if (!searchResults) return;
    const terms = normalized(query).split(" ").filter((term) => term.length > 1);
    if (!terms.length) {
      searchResults.innerHTML = '<p class="search-empty">Type at least two characters to search the complete book.</p>';
      return;
    }

    const results = buildSearchIndex()
      .filter((entry) => terms.every((term) => entry.normalizedText.includes(term)))
      .map((entry) => {
        const titleText = normalized(entry.sectionTitle);
        const exactPhrase = entry.normalizedText.includes(terms.join(" "));
        const score = (exactPhrase ? 8 : 0)
          + terms.reduce((total, term) => total + (titleText.includes(term) ? 4 : 0), 0)
          + Math.max(0, 3 - entry.normalizedText.length / 500);
        return { ...entry, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, SEARCH_LIMIT);

    if (!results.length) {
      searchResults.innerHTML = `<p class="search-empty">No results for “${escapeHtml(query.trim())}”. Try fewer or broader terms.</p>`;
      return;
    }

    const heading = `<p class="search-status">${results.length}${results.length === SEARCH_LIMIT ? "+" : ""} result${results.length === 1 ? "" : "s"}</p>`;
    const items = results.map((result) => `
      <a class="search-result" href="#${encodeURIComponent(result.targetId)}" data-search-target="${escapeHtml(result.targetId)}">
        <span class="search-result__section">${escapeHtml(result.sectionTitle)}</span>
        <span class="search-result__text">${snippetFor(result.text, terms)}</span>
      </a>`).join("");
    searchResults.innerHTML = heading + items;
  }

  function openSearch() {
    if (!searchDialog) return;
    if (typeof searchDialog.showModal === "function") searchDialog.showModal();
    else searchDialog.setAttribute("open", "");
    if (!searchIndex) {
      searchResults.innerHTML = '<p class="search-empty">Ready to search the complete book.</p>';
    }
    window.requestAnimationFrame(() => searchInput?.focus());
  }

  function closeSearch() {
    if (!searchDialog) return;
    if (typeof searchDialog.close === "function" && searchDialog.open) searchDialog.close();
    else searchDialog.removeAttribute("open");
  }

  function navigateToSection(sectionId) {
    if (!sectionId || !sectionById.has(sectionId)) return;
    const nextHash = `#${sectionId}`;
    if (window.location.hash === nextHash) routeFromHash({ scroll: true, focus: true });
    else window.location.hash = sectionId;
  }

  sidebarToggle?.addEventListener("click", () => {
    if (body.classList.contains("sidebar-open")) closeSidebar({ restoreFocus: true });
    else openSidebar();
  });
  sidebarScrim?.addEventListener("click", () => closeSidebar({ restoreFocus: true }));
  navLinks.forEach((link) => link.addEventListener("click", () => closeSidebar()));
  previousButton?.addEventListener("click", () => navigateToSection(previousButton.dataset.targetSection));
  nextButton?.addEventListener("click", () => navigateToSection(nextButton.dataset.targetSection));
  themeButton?.addEventListener("click", () => setTheme(root.dataset.theme === "dark" ? "light" : "dark"));
  fontDecrease?.addEventListener("click", () => setFontSize(currentFontSize() - 1));
  fontIncrease?.addEventListener("click", () => setFontSize(currentFontSize() + 1));
  searchButton?.addEventListener("click", openSearch);

  searchInput?.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => runSearch(searchInput.value), 100);
  });

  searchResults?.addEventListener("click", (event) => {
    const result = event.target.closest("a[data-search-target]");
    if (!result) return;
    closeSearch();
  });

  searchDialog?.addEventListener("click", (event) => {
    if (event.target === searchDialog) closeSearch();
  });

  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[href^='#']");
    if (!link || link.closest("#search-results")) return;
    if (link.hash && link.hash === window.location.hash) {
      event.preventDefault();
      routeFromHash({ scroll: true, focus: false });
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && body.classList.contains("sidebar-open")) {
      event.preventDefault();
      closeSidebar({ restoreFocus: true });
      return;
    }
    const commandSearch = (event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k";
    const slashSearch = event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey
      && !event.target.matches("input, textarea, [contenteditable='true']");
    if (commandSearch || slashSearch) {
      event.preventDefault();
      openSearch();
    }
  });

  window.addEventListener("hashchange", () => routeFromHash({ scroll: true, focus: true }));
  window.addEventListener("wheel", clearTargetAlignment, { passive: true });
  window.addEventListener("touchstart", clearTargetAlignment, { passive: true });
  window.addEventListener("scroll", requestProgressUpdate, { passive: true });
  window.addEventListener("resize", requestProgressUpdate, { passive: true });
  window.matchMedia?.("(min-width: 961px)").addEventListener?.("change", (event) => {
    if (event.matches) closeSidebar();
  });

  initializeTheme();
  initializeFontSize();
  routeFromHash({ scroll: Boolean(window.location.hash), focus: false });

  const scheduleIndex = window.requestIdleCallback || ((callback) => window.setTimeout(callback, 1200));
  scheduleIndex(buildSearchIndex);
})();
