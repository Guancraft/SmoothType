(() => {
  "use strict";

  // -----------------------------
  // SmoothType v1.3
  // 只绘制平滑的“替代光标”，不读取、记录或上传用户输入内容。
  // -----------------------------

  const DEFAULTS = Object.freeze({
    enabled: true,
    duration: 72,
    caretWidth: 1.5,
    blinkInterval: 530,
    disabledHosts: []
  });

  const SUPPORTED_INPUT_TYPES = new Set([
    "text",
    "search",
    "url",
    "tel",
    "email"
  ]);

  let settings = { ...DEFAULTS };
  let activeEditable = null;
  let nativeCaretBackup = null;
  let composing = false;
  let scheduled = false;
  let caretVisible = false;
  let blinkTimer = 0;
  let overlayHost = null;
  let shadowRoot = null;
  let caret = null;
  let mirror = null;

  function currentHost() {
    try {
      return location.hostname || "";
    } catch {
      return "";
    }
  }

  function isSiteEnabled() {
    return (
      settings.enabled &&
      !settings.disabledHosts.includes(currentHost())
    );
  }

  function isSupportedInput(element) {
    if (!(element instanceof HTMLInputElement)) return false;
    return (
      SUPPORTED_INPUT_TYPES.has((element.type || "text").toLowerCase()) &&
      !element.disabled &&
      !element.readOnly
    );
  }

  function isSupportedTextarea(element) {
    return (
      element instanceof HTMLTextAreaElement &&
      !element.disabled &&
      !element.readOnly
    );
  }

  function editingHostFor(element) {
    if (!(element instanceof HTMLElement)) return null;

    if (isSupportedInput(element) || isSupportedTextarea(element)) {
      return element;
    }

    if (!element.isContentEditable) return null;

    let host = element;
    while (
      host.parentElement &&
      host.parentElement.isContentEditable
    ) {
      host = host.parentElement;
    }
    return host;
  }

  function editableFromEvent(event) {
    const path = typeof event.composedPath === "function"
      ? event.composedPath()
      : [event.target];

    for (const item of path) {
      if (!(item instanceof HTMLElement)) continue;
      const editable = editingHostFor(item);
      if (editable) return editable;
    }
    return null;
  }

  function editableContainsNode(editable, node) {
    if (!editable || !node) return false;
    if (editable === node) return true;
    return editable.contains(node.nodeType === Node.TEXT_NODE ? node.parentNode : node);
  }

  function ensureOverlay() {
    if (overlayHost?.isConnected && caret) return;

    overlayHost = document.createElement("div");
    overlayHost.setAttribute("data-smooth-type-overlay", "");
    // v1.1 修复：
    // v1.0 的宿主元素是 0×0，并设置了 contain:paint，
    // 浏览器会把位于宿主范围外的假光标完全裁掉。
    // 现在让覆盖层真正铺满视口，并明确关闭绘制裁剪。
    overlayHost.style.cssText = [
      "position:fixed!important",
      "inset:0!important",
      "display:block!important",
      "width:auto!important",
      "height:auto!important",
      "margin:0!important",
      "padding:0!important",
      "border:0!important",
      "pointer-events:none!important",
      "z-index:2147483647!important",
      "overflow:visible!important",
      "contain:none!important",
      "transform:none!important"
    ].join(";");

    shadowRoot = overlayHost.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
      }

      #smooth-type-caret {
        position: fixed;
        top: 0;
        left: 0;
        width: 1.5px;
        height: 20px;
        border-radius: 999px;
        background: currentColor;
        color: rgb(20, 20, 20);
        opacity: 0;
        pointer-events: none;
        transform: translate3d(-9999px, -9999px, 0);
        transform-origin: top left;
        will-change: transform, height, opacity;
        transition-property: transform, height, width;
        transition-duration: 72ms;
        transition-timing-function: cubic-bezier(0.22, 0.8, 0.35, 1);
      }

      #smooth-type-caret.visible {
        opacity: 1;
      }

      #smooth-type-caret.blinking {
        animation-name: smooth-type-blink;
        animation-duration: 530ms;
        animation-timing-function: steps(1, end);
        animation-iteration-count: infinite;
      }

      @keyframes smooth-type-blink {
        0%, 54% { opacity: 1; }
        55%, 100% { opacity: 0; }
      }

      @media (prefers-reduced-motion: reduce) {
        #smooth-type-caret {
          transition-duration: 0ms !important;
        }
      }
    `;

    caret = document.createElement("div");
    caret.id = "smooth-type-caret";

    shadowRoot.append(style, caret);

    const parent = document.documentElement || document;
    parent.appendChild(overlayHost);
  }

  function ensureMirror() {
    if (mirror?.isConnected) return mirror;

    mirror = document.createElement("div");
    mirror.setAttribute("aria-hidden", "true");
    mirror.setAttribute("data-smooth-type-mirror", "");
    mirror.style.cssText = [
      "position:fixed",
      "left:-100000px",
      "top:-100000px",
      "visibility:hidden",
      "pointer-events:none",
      "z-index:-2147483648",
      "overflow:visible",
      "contain:layout style",
      "margin:0"
    ].join(";");

    (document.documentElement || document).appendChild(mirror);
    return mirror;
  }

  function readCaretColor(element) {
    try {
      const style = getComputedStyle(element);
      const caretColor = style.caretColor;
      if (
        caretColor &&
        caretColor !== "auto" &&
        caretColor !== "transparent" &&
        !caretColor.endsWith(", 0)")
      ) {
        return caretColor;
      }
      return style.color || "rgb(20, 20, 20)";
    } catch {
      return "rgb(20, 20, 20)";
    }
  }

  function hideNativeCaret(element) {
    // 已经隐藏的是同一个输入框时，不要重复覆盖备份值。
    if (nativeCaretBackup?.element === element) return;

    restoreNativeCaret();

    nativeCaretBackup = {
      element,
      value: element.style.getPropertyValue("caret-color"),
      priority: element.style.getPropertyPriority("caret-color")
    };

    element.style.setProperty("caret-color", "transparent", "important");
  }

  function restoreNativeCaret() {
    if (!nativeCaretBackup) return;

    const { element, value, priority } = nativeCaretBackup;
    if (element?.isConnected) {
      if (value) {
        element.style.setProperty("caret-color", value, priority);
      } else {
        element.style.removeProperty("caret-color");
      }
    }
    nativeCaretBackup = null;
  }

  function setActiveEditable(element) {
    if (activeEditable === element) {
      scheduleUpdate();
      return;
    }

    restoreNativeCaret();
    activeEditable = element;
    caretVisible = false;

    if (!activeEditable || !isSiteEnabled()) {
      hideOverlay();
      return;
    }

    ensureOverlay();
    const color = readCaretColor(activeEditable);
    caret.style.color = color;

    // 不在这里立刻隐藏原生光标。
    // 必须等假光标成功计算并显示后再隐藏，避免特殊网页出现“双重消失”。
    scheduleUpdate(true);
  }

  function clearActiveEditable(element = null) {
    if (element && activeEditable !== element) return;
    activeEditable = null;
    composing = false;
    restoreNativeCaret();
    hideOverlay();
  }

  function hideOverlay() {
    if (!caret) return;
    caret.classList.remove("visible", "blinking");
    caret.style.opacity = "0";
    caret.style.transform = "translate3d(-9999px, -9999px, 0)";
    caretVisible = false;
    clearTimeout(blinkTimer);
  }

  function restartBlink() {
    if (!caret) return;

    clearTimeout(blinkTimer);
    caret.classList.remove("blinking");
    caret.style.opacity = "1";

    // 中文拼音组合阶段让光标保持常亮并持续跟随，
    // 避免候选输入尚未结束时光标突然闪灭。
    if (composing) return;

    // 强制浏览器重新计算动画状态，保证每次输入后先保持常亮。
    void caret.offsetWidth;

    blinkTimer = window.setTimeout(() => {
      if (!caretVisible || !activeEditable || composing) return;
      caret.style.animationDuration = `${settings.blinkInterval}ms`;
      caret.classList.add("blinking");
    }, Math.max(220, settings.blinkInterval));
  }

  function px(style, name) {
    const value = Number.parseFloat(style.getPropertyValue(name));
    return Number.isFinite(value) ? value : 0;
  }

  function numberOr(value, fallback) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  const MIRROR_PROPERTIES = [
    "direction",
    "box-sizing",
    "font-family",
    "font-size",
    "font-style",
    "font-variant",
    "font-weight",
    "font-stretch",
    "font-feature-settings",
    "font-kerning",
    "font-variation-settings",
    "line-height",
    "letter-spacing",
    "word-spacing",
    "text-align",
    "text-indent",
    "text-transform",
    "text-rendering",
    "tab-size",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "word-break",
    "overflow-wrap"
  ];

  function caretRectForTextControl(element) {
    const selectionStart = element.selectionStart;
    if (typeof selectionStart !== "number") return null;

    const valueBeforeCaret = element.value.slice(0, selectionStart);
    const elementRect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const mirrorElement = ensureMirror();

    mirrorElement.replaceChildren();
    mirrorElement.style.cssText = [
      "position:fixed",
      `left:${elementRect.left + element.clientLeft}px`,
      `top:${elementRect.top + element.clientTop}px`,
      `width:${element.clientWidth}px`,
      `min-height:${element.clientHeight}px`,
      "height:auto",
      "visibility:hidden",
      "pointer-events:none",
      "z-index:-2147483648",
      "overflow:visible",
      "contain:layout style",
      "margin:0",
      "border:0",
      "box-sizing:border-box"
    ].join(";");

    for (const property of MIRROR_PROPERTIES) {
      mirrorElement.style.setProperty(property, style.getPropertyValue(property));
    }

    const isInput = element instanceof HTMLInputElement;
    mirrorElement.style.whiteSpace = isInput ? "pre" : "pre-wrap";
    mirrorElement.style.overflowWrap = isInput
      ? "normal"
      : (style.overflowWrap || "break-word");

    const textNode = document.createTextNode(valueBeforeCaret);
    const marker = document.createElement("span");
    marker.textContent = "\u200b";
    marker.style.cssText = [
      "display:inline",
      "padding:0",
      "margin:0",
      "border:0"
    ].join(";");

    mirrorElement.append(textNode, marker);

    const markerRect = marker.getBoundingClientRect();
    const fontSize = numberOr(style.fontSize, 16);
    const lineHeight = style.lineHeight === "normal"
      ? fontSize * 1.2
      : numberOr(style.lineHeight, fontSize * 1.2);

    return {
      x: markerRect.left - element.scrollLeft,
      y: markerRect.top - element.scrollTop,
      height: markerRect.height || lineHeight,
      color: style.color
    };
  }

  function rangeAtSelectionFocus(selection) {
    if (!selection?.focusNode) return null;

    try {
      const range = document.createRange();
      range.setStart(selection.focusNode, selection.focusOffset);
      range.collapse(true);
      return range;
    } catch {
      return null;
    }
  }

  function rectFromTextBoundary(textNode, atEnd) {
    const text = textNode.textContent || "";
    if (!text.length) return null;

    // 通常只需测量边界处的一个字符；循环是为了跳过偶尔没有布局框的换行符等字符。
    const startIndex = atEnd ? text.length - 1 : 0;
    const step = atEnd ? -1 : 1;
    const stop = atEnd ? -1 : text.length;
    let attempts = 0;

    for (
      let index = startIndex;
      index !== stop && attempts < 64;
      index += step, attempts += 1
    ) {
      try {
        const probe = document.createRange();
        probe.setStart(textNode, index);
        probe.setEnd(textNode, index + 1);

        const rects = probe.getClientRects();
        if (!rects.length) continue;

        const rect = atEnd ? rects[rects.length - 1] : rects[0];
        if (rect.height <= 0) continue;

        return {
          x: atEnd ? rect.right : rect.left,
          y: rect.top,
          height: rect.height
        };
      } catch {
        return null;
      }
    }

    return null;
  }

  function rectFromNodeBoundary(node, atEnd) {
    if (!node) return null;

    if (node.nodeType === Node.TEXT_NODE) {
      return rectFromTextBoundary(
        /** @type {Text} */ (node),
        atEnd
      );
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }

    const element = /** @type {Element} */ (node);
    const children = [...element.childNodes];

    // 关键修复：
    // ChatGPT 等编辑器首次从空白状态提交中文后，Selection 可能落在：
    //   contenteditable 根节点，offset = 1
    // 它前面的节点通常是一个铺满整行的 <p>。
    // 不能使用 <p>.getBoundingClientRect().right，
    // 否则假光标会直接飞到输入框最右边。
    // 应递归找到段落里最靠近边界的真实文字，并测量该字符边缘。
    if (atEnd) {
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const rect = rectFromNodeBoundary(children[index], true);
        if (rect) return rect;
      }
    } else {
      for (const child of children) {
        const rect = rectFromNodeBoundary(child, false);
        if (rect) return rect;
      }
    }

    // 空行和显式换行的回退位置。
    if (element instanceof HTMLBRElement) {
      const rect = element.getBoundingClientRect();
      const parent = element.parentElement;
      const style = parent ? getComputedStyle(parent) : getComputedStyle(element);
      const fontSize = numberOr(style.fontSize, 16);
      const lineHeight = style.lineHeight === "normal"
        ? fontSize * 1.2
        : numberOr(style.lineHeight, fontSize * 1.2);

      return {
        x: rect.left,
        y: rect.top,
        height: rect.height || lineHeight
      };
    }

    // 对没有文字后代的内联替换元素使用自身边缘；
    // 对块级空段落则使用内容区起点，避免再次误用整行右边缘。
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0) return null;

    const style = getComputedStyle(element);
    const display = style.display || "";
    const isBlockLike = (
      display === "block" ||
      display === "flex" ||
      display === "grid" ||
      display === "table" ||
      display === "list-item"
    );

    const fontSize = numberOr(style.fontSize, 16);
    const lineHeight = style.lineHeight === "normal"
      ? fontSize * 1.2
      : numberOr(style.lineHeight, fontSize * 1.2);

    return {
      x: isBlockLike
        ? rect.left + px(style, "padding-left")
        : (atEnd ? rect.right : rect.left),
      y: rect.top + px(style, "padding-top"),
      height: Math.min(rect.height, lineHeight) || lineHeight
    };
  }

  function rectFromCollapsedRange(range) {
    if (!range) return null;

    const rects = range.getClientRects();
    if (rects.length) {
      const rect = rects[rects.length - 1];
      if (rect.height > 0) {
        return {
          x: rect.left,
          y: rect.top,
          height: rect.height
        };
      }
    }

    const node = range.startContainer;
    const offset = range.startOffset;

    // 文本节点中的兼容回退：测量光标左边或右边的单个字符。
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || "";

      if (offset > 0) {
        const probe = document.createRange();
        probe.setStart(node, offset - 1);
        probe.setEnd(node, offset);
        const charRects = probe.getClientRects();
        if (charRects.length) {
          const rect = charRects[charRects.length - 1];
          return {
            x: rect.right,
            y: rect.top,
            height: rect.height
          };
        }
      }

      if (offset < text.length) {
        const probe = document.createRange();
        probe.setStart(node, offset);
        probe.setEnd(node, offset + 1);
        const charRects = probe.getClientRects();
        if (charRects.length) {
          const rect = charRects[0];
          return {
            x: rect.left,
            y: rect.top,
            height: rect.height
          };
        }
      }
    }

    // 元素节点中的兼容回退。
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = /** @type {Element} */ (node);
      const before = offset > 0 ? element.childNodes[offset - 1] : null;
      const after = element.childNodes[offset] || null;

      // 光标位于某个子节点之后：测量该子树最后一个真实字符的右边缘。
      const beforeRect = rectFromNodeBoundary(before, true);
      if (beforeRect) return beforeRect;

      // 光标位于某个子节点之前：测量该子树第一个真实字符的左边缘。
      const afterRect = rectFromNodeBoundary(after, false);
      if (afterRect) return afterRect;
    }

    return null;
  }

  function caretRectForContentEditable(element) {
    const selection = document.getSelection();
    if (
      !selection ||
      selection.rangeCount === 0 ||
      !editableContainsNode(element, selection.focusNode)
    ) {
      return null;
    }

    const range = rangeAtSelectionFocus(selection);
    let rect = rectFromCollapsedRange(range);

    let styleTarget = selection.focusNode?.nodeType === Node.ELEMENT_NODE
      ? /** @type {Element} */ (selection.focusNode)
      : selection.focusNode?.parentElement;

    if (!(styleTarget instanceof Element)) {
      styleTarget = element;
    }

    const style = getComputedStyle(styleTarget);
    const fontSize = numberOr(style.fontSize, 16);
    const lineHeight = style.lineHeight === "normal"
      ? fontSize * 1.2
      : numberOr(style.lineHeight, fontSize * 1.2);

    if (!rect) {
      const bounds = element.getBoundingClientRect();
      const elementStyle = getComputedStyle(element);
      rect = {
        x: bounds.left + px(elementStyle, "padding-left"),
        y: bounds.top + px(elementStyle, "padding-top"),
        height: lineHeight
      };
    }

    return {
      ...rect,
      height: rect.height || lineHeight,
      color: style.color || getComputedStyle(element).color
    };
  }

  function caretRectFor(element) {
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      return caretRectForTextControl(element);
    }

    if (element instanceof HTMLElement && element.isContentEditable) {
      return caretRectForContentEditable(element);
    }

    return null;
  }

  function isCaretInsideVisibleArea(element, rect) {
    if (!rect) return false;

    const viewportVisible = (
      rect.x >= -4 &&
      rect.x <= window.innerWidth + 4 &&
      rect.y + rect.height >= -4 &&
      rect.y <= window.innerHeight + 4
    );
    if (!viewportVisible) return false;

    const bounds = element.getBoundingClientRect();

    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      const left = bounds.left + element.clientLeft - 2;
      const right = left + element.clientWidth + 4;
      const top = bounds.top + element.clientTop - 2;
      const bottom = top + element.clientHeight + 4;

      return (
        rect.x >= left &&
        rect.x <= right &&
        rect.y + rect.height >= top &&
        rect.y <= bottom
      );
    }

    // 普通 contenteditable 允许少量越界，以兼容行高和空段落。
    return (
      rect.x >= bounds.left - 8 &&
      rect.x <= bounds.right + 8 &&
      rect.y + rect.height >= bounds.top - 8 &&
      rect.y <= bounds.bottom + 8
    );
  }

  function updateOverlay(immediate = false) {
    scheduled = false;

    if (
      !activeEditable ||
      !activeEditable.isConnected ||
      !isSiteEnabled()
    ) {
      clearActiveEditable();
      return;
    }

    // v1.2：中文输入法组合期间也继续测量当前插入点。
    // 拼音预编辑文本虽然尚未正式提交，但已经显示在编辑器中，
    // selectionStart / Selection 通常也会随拼音末尾更新，因此假光标应继续跟随。
    ensureOverlay();

    const rect = caretRectFor(activeEditable);
    if (!rect || !isCaretInsideVisibleArea(activeEditable, rect)) {
      caret.classList.remove("visible", "blinking");
      caret.style.opacity = "0";
      caretVisible = false;

      // 安全回退：假光标无法定位时，立即恢复网页自己的光标。
      restoreNativeCaret();
      return;
    }

    const duration = immediate || !caretVisible ? 0 : settings.duration;
    const height = Math.max(8, Math.min(120, rect.height));
    const width = Math.max(1, Math.min(5, settings.caretWidth));

    caret.style.transitionDuration = `${duration}ms`;
    caret.style.width = `${width}px`;
    caret.style.height = `${height}px`;
    caret.style.color = rect.color || readCaretColor(activeEditable);
    caret.style.transform =
      `translate3d(${rect.x}px, ${rect.y}px, 0)`;

    caret.classList.add("visible");
    caret.style.opacity = "1";
    caretVisible = true;

    // 只有假光标已经成功放到正确位置后，才隐藏原生光标。
    hideNativeCaret(activeEditable);
    restartBlink();
  }

  function scheduleUpdate(immediate = false) {
    if (scheduled && !immediate) return;

    if (immediate) {
      cancelAnimationFrame(scheduled);
      scheduled = false;
      requestAnimationFrame(() => updateOverlay(true));
      return;
    }

    scheduled = requestAnimationFrame(() => updateOverlay(false));
  }

  function applySettings(nextSettings) {
    settings = {
      ...DEFAULTS,
      ...nextSettings,
      disabledHosts: Array.isArray(nextSettings?.disabledHosts)
        ? nextSettings.disabledHosts
        : []
    };

    if (caret) {
      caret.style.width = `${settings.caretWidth}px`;
      caret.style.animationDuration = `${settings.blinkInterval}ms`;
    }

    if (!isSiteEnabled()) {
      restoreNativeCaret();
      hideOverlay();
      return;
    }

    if (activeEditable) {
      // 同样先定位假光标；定位成功后 updateOverlay 会隐藏原生光标。
      restoreNativeCaret();
      scheduleUpdate(true);
    }
  }

  function handleFocusIn(event) {
    const editable = editableFromEvent(event);
    if (editable) setActiveEditable(editable);
  }

  function handleFocusOut(event) {
    const leaving = editableFromEvent(event);
    if (!leaving || leaving !== activeEditable) return;

    // 某些编辑器在内部临时切换焦点，延迟一帧再确认。
    requestAnimationFrame(() => {
      const deepActive = document.activeElement;
      if (
        deepActive === activeEditable ||
        (deepActive instanceof Node && activeEditable?.contains(deepActive))
      ) {
        return;
      }
      clearActiveEditable(leaving);
    });
  }

  function scheduleCompositionUpdate(immediate = false) {
    // 不同网页编辑器更新预编辑文本和 Selection 的时机不完全一致。
    // 当前帧、下一帧以及零延时任务各测一次，可覆盖 ChatGPT 等富文本编辑器。
    scheduleUpdate(immediate);
    requestAnimationFrame(() => scheduleUpdate(false));
    window.setTimeout(() => scheduleUpdate(false), 0);
  }

  function handleCompositionStart(event) {
    const editable = editableFromEvent(event);
    if (editable) setActiveEditable(editable);

    composing = true;
    if (caret) {
      clearTimeout(blinkTimer);
      caret.classList.remove("blinking");
      caret.style.opacity = "1";
    }

    scheduleCompositionUpdate(false);
  }

  function handleCompositionUpdate() {
    scheduleCompositionUpdate(false);
  }

  function handleCompositionEnd() {
    composing = false;

    // 中文候选提交时，最终汉字和最终 Selection 也可能在事件之后才落入 DOM。
    scheduleCompositionUpdate(false);
    restartBlink();
  }

  document.addEventListener("focusin", handleFocusIn, true);
  document.addEventListener("focusout", handleFocusOut, true);
  document.addEventListener("input", () => scheduleUpdate(), true);
  document.addEventListener("beforeinput", () => restartBlink(), true);
  document.addEventListener("keyup", () => scheduleUpdate(), true);
  document.addEventListener("pointerup", () => scheduleUpdate(), true);
  document.addEventListener("click", () => scheduleUpdate(), true);
  document.addEventListener("selectionchange", () => scheduleUpdate(), true);
  document.addEventListener("compositionstart", handleCompositionStart, true);
  document.addEventListener("compositionupdate", handleCompositionUpdate, true);
  document.addEventListener("compositionend", handleCompositionEnd, true);

  window.addEventListener("scroll", () => scheduleUpdate(), true);
  window.addEventListener("resize", () => scheduleUpdate(), true);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hideOverlay();
    } else if (activeEditable) {
      scheduleUpdate(true);
    }
  });

  chrome.storage.sync.get(DEFAULTS, applySettings);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;

    const next = { ...settings };
    for (const [key, change] of Object.entries(changes)) {
      next[key] = change.newValue;
    }
    applySettings(next);
  });
})();
