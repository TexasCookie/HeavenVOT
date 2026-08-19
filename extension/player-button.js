(function (root) {
  var TOGGLE_ID = "lvt-toggle";

  function nodeOrAncestorHasId(node, id) {
    var current = node;
    while (current) {
      if (current.id === id) return true;
      current = current.parentElement || current.parentNode;
    }
    return false;
  }

  function eventHitsToggle(event) {
    if (!event) return false;
    if (event.composedPath) {
      var path = event.composedPath();
      for (var i = 0; i < path.length; i++) {
        if (path[i] && path[i].id === TOGGLE_ID) return true;
      }
    }
    return nodeOrAncestorHasId(event.target, TOGGLE_ID);
  }

  function swallow(event) {
    if (!event) return;
    if (event.preventDefault) event.preventDefault();
    if (event.stopPropagation) event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
  }

  function makeDebounced(activate, gap) {
    var last = 0;
    var wait = gap || 400;
    return function (event) {
      var now = Date.now();
      if (now - last < wait) return false;
      last = now;
      activate(event);
      return true;
    };
  }

  function installWindowCapture(activate) {
    if (root.__lvtWindowGuard) return;
    var fire = makeDebounced(activate, 400);
    function onEvent(event) {
      if (!eventHitsToggle(event)) return;
      swallow(event);
      if (event.type === "pointerdown" || event.type === "click") fire(event);
    }
    ["pointerdown", "mousedown", "mouseup", "click"].forEach(function (type) {
      window.addEventListener(type, onEvent, true);
      document.addEventListener(type, onEvent, true);
    });
    root.__lvtWindowGuard = true;
  }

  function mountOverlay(host, button) {
    if (!host || !button) return false;
    var style = host.style;
    if (style && !style.position) style.position = "relative";
    if (button.parentNode !== host) host.appendChild(button);
    return button.parentNode === host;
  }

  var api = {
    TOGGLE_ID: TOGGLE_ID,
    nodeOrAncestorHasId: nodeOrAncestorHasId,
    eventHitsToggle: eventHitsToggle,
    swallow: swallow,
    makeDebounced: makeDebounced,
    installWindowCapture: installWindowCapture,
    mountOverlay: mountOverlay,
  };
  root.LvtPlayerButton = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
